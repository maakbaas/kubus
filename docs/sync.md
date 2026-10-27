# Sync with Postgres

The server, the sync engine, files, the HTTP API (headless device) and webhooks, and the
home-screen app.

## Sync with Postgres (the server and the sync engine)

Repo layout: `app/` the web app (what Tauri and the phone run), `desktop/` the Tauri shell,
`server/` the sync server (Node 24, runs its TypeScript directly, dependencies `pg` and
`@sqlite.org/sqlite-wasm` for the headless device), `shared/` what both sides import: `sync.ts`
the protocol (the list of synced tables / columns / types and the request shapes), `files.ts`
(file ids, `fileIdsIn`), `router.ts` (the routes of the server and the API), `api.ts` (types of the
server ↔ headless device interface).

**Topology.** `app ──HTTPS──> server ──> Postgres` (the example `docker-compose.yml` runs its own; any other via `DATABASE_URL`). The
client never talks to Postgres: browsers and the iOS PWA can only do HTTP. One container
(`server/Dockerfile`, `docker-compose.yml` with `DATABASE_URL` and `KUBUS_TOKEN`) serves the
sync API at `/api` and the built web app at `/`, so the phone installs the app from the server
(same origin, no CORS). Auth is one shared bearer token (`KUBUS_TOKEN`); the app's
Settings (`#/settings?section=sync`, the Sync tab, `ui/SyncSettings.tsx`; reached from the "Configure sync" button in the
popover of the status icon ending the top-right tab strip, `ui/SyncStatusButton.tsx`, which itself only shows the state) holds server URL + token + on/off + Disconnect (forgets the server; the
device keeps its data and the next connection is a first one) + Wipe local database (`Repository.wipeLocal`:
pauses sync with `SyncControl.pause`, which keeps URL and token but forgets the server so switching it on again is a
first connection; then the worker drops every table and creates the schema afresh, and the app reloads) + Wipe server
database (while connected; `POST /api/wipe` with `{"confirm":"wipe"}`, `server/src/wipe.ts`: drops every table and sequence in
the server's schema, whatever they are, and applies `schema.sql` again, in one transaction; then this device pauses sync, so
switching it on again uploads its data). A server whose database doesn't fit `schema.sql` still starts: sync answers with that
error until the database is wiped. Per device (localStorage
`kubus.sync`). A readable Postgres replica (not end-to-end encrypted) was chosen, as the hub
vision wants server-side queries and remote sources later.

**Client** (`app/src/data/sync/SyncEngine.ts`, created by `SqliteRepository`, exposed as `repo.sync`):
- *Outbox by triggers.* `AFTER INSERT/UPDATE` triggers on every synced table (made from
  `SYNC_TABLES` and appended to `schema.sql` by `data/schema.ts`; insert only for `version: null`)
  queue the row's key in `sync_outbox` (local only), in the same transaction as the change; so no
  repository method knows about sync. Rows the engine applies from the server are not queued
  (`meta` row `sync_applying` is set during the apply). A new synced table or column goes in `schema.sql` and `shared/sync.ts`
  (`sync/spec.test.ts` fails until they agree); the triggers and the server's tables follow.
- *One request does push and pull*: `POST /api/sync { since, changes }` returns `{ cursor, changes }`
  (rows with server `seq` > since, but not the ones this request wrote: the device has them, and the
  cursor covers them). Applying the response, clearing the sent part of the outbox
  (`id <= snapshot`; edits made during the request stay queued) and storing `meta.sync_cursor` is
  one local transaction. Pulls are incremental (per row; `field_values` rows are single fields).
- *Merge*: a row replaces the local one only if its `updated_at` is newer (field-level last writer
  wins, since every value is its own row). Files and thumbnail links are immutable and inserted if
  missing. `now()`
  never goes below a timestamp received from the server (`observeStamp`), a cheap guard against clock
  skew instead of a hybrid logical clock.
- *First connection to a server* (or a changed server URL): the server is the source of truth. If it
  holds data, that replaces everything on the device (one local transaction, nothing is sent; the
  Sync settings ask for confirmation first, `isNewServer`). Only an empty server takes the device's data
  instead: all local rows are queued and uploaded.
- *Which database*: the server's database has an id (`server_meta`: a `gen_random_uuid()` and its
  creation time, inserted `ON CONFLICT DO NOTHING`, so a restart keeps it and a wipe, a new volume or
  another database gives a new one). Every response carries it (`SyncResponse.database`); the device
  keeps it in `meta` (`sync_database`) and sends it with every sync. When the server holds another
  one, it writes nothing and answers 409 (`SyncMismatch`, with whether the new database is empty):
  the outbox only holds what changed since the last sync, which would land there as fragments (and
  a non-empty server would then replace the data of the device that meant to fill it). The device
  pauses, keeping URL and token, and forgets the server; `SyncStatus.replaced` (kept in
  `kubus.syncReplaced` across reloads) turns the sync icon red, and its popover and the sync settings
  (`ui/ServerReplaced.tsx`) offer connecting again (`reconnect`): a first connection to the new
  database (download, after a confirmation; or upload when it is empty). Not caught: tables emptied by hand
  (the id stays) and a restored backup (same id, older data: devices ahead of the server pull
  everything again); delete the `server_meta` rows after such a restore to make it count as new.
- *When*: 2 s after a local write (a sync starting meanwhile takes it along and cancels that), every
  30 s, on `online`, when the app becomes visible, and when the server signals a change this device
  doesn't have (`GET /api/events`, server-sent events read with `fetch` so the token goes in a
  header; reconnects with backoff; each event is `data: <cursor>`, so a device's own push, at or
  below its cursor, doesn't make it sync again; `0` = wiped). Applied changes are announced as `DataChange`s, so every
  view refreshes as for a local write.

**Server** (`server/src`): `sync.ts` runs a request in one transaction under an advisory lock, so
`seq` (from `sync_seq`, taken per written row) order is commit order and a cursor never skips a row;
the lock also means the rows a request writes are exactly the ones after the cursor it started at,
which is how the answer leaves them out. Pushed rows are written a statement per table (and per
1000 rows: `jsonb_to_recordset`), not one by one. The synced tables are made from `shared/sync.ts`
(`schema.ts`: jsonb, timestamptz, …; no foreign keys or checks), then `server/schema.sql` (the
server's own tables), all applied idempotently at start. `events.ts` is the change signal. Proxies must not
buffer `/api/events` (nginx: `proxy_buffering off`); polling covers a dropped stream. Its routes
(`index.ts`) go through the shared `Router` (`shared/router.ts`).

## Files

File bytes (images) never travel inside `/api/sync`; the synced `files` row is metadata only.
- *On a device* the bytes are the local-only column `files.data` (`spec.test.ts` allows it). `NULL`
  = known from a sync, not downloaded yet. A device without a server keeps every byte it stores.
- *Upload*: before a sync sends a queued `files` row, the engine asks `HEAD /api/files/<id>` and
  else uploads `PUT /api/files/<id>` (raw body, `Content-Type`); the server checks the SHA-256 against
  the id and the 20 MB limit (`MAX_FILE_BYTES`). Only then is the row sent, so the server never lists
  a file it can't serve. A sync uploads up to 50 MB / 30 s; the rest stays queued (and the engine
  syncs again at once), the other rows don't wait: image values have no foreign key
  (`field_values.value_file`), as a file's row may arrive after its use. A failed upload is retried
  at the next sync; a refused one (400/413) and one nobody has bytes for are dropped.
- *Download*: after each sync, in the background, three at a time (`downloadFiles`): thumbnails first,
  then originals; with the Sync setting "Download images: Full size when opened" (`SyncConfig.originals`
  = "opened") only thumbnails, an original then when `getFile` is first asked for it (and kept).
  `getFile` fetches missing bytes from the server. Files marked unused aren't downloaded.
- *Thumbnails* (`ui/thumbnails.ts`, `Repository.putThumbnail`): a copy with its shortest side 512 px
  (longest at most 2048), WebP, else JPEG or PNG, made in the browser when an image is stored or the
  first time one without a thumbnail is shown small (an image from the API: Node can't draw). Not for images already small (≤ 512 px or ≤ 100 KB), SVG or GIF. Stored as an ordinary file
  plus a row of the synced, insert-only `thumbnails` table (`file_id` → `thumb_id`; the first link the
  server gets stays, another device's own is as good). Used only by table cells, cards and compact
  component images (`useFileUrl(id, true)`); item pages, Markdown and the Lightbox (`data-file`) show
  the original. Released with the original.
- *On the server* the bytes are `file_bytes` (id, mime, data, stored_at), out of the sync tables
  (`server/src/files.ts`). `GET /api/files/<id>` sends them with a year-long private cache;
  `DELETE /api/files/<id>` drops them. Wiping drops them with every table. The server decides
  nothing about files: it stores, serves and deletes when a device says so.
- *Clean-up*, by the devices only. A value uses the files it names (an image value, `files/<id>` in
  its text, any field: `filesUsedBy` in `shared/files.ts`); triggers on `field_values` keep that in
  the local `file_uses` table (through the `file_ids()` function the engine defines). A file is in
  use when a live item, through a live field, uses it, a thumbnail through its original (`fileInUse`
  in `SqliteRepository.ts`). When an edit or a sync drops a file's last use, it is marked
  (`files.unused_since`, local only; `releaseFile`, same transaction; for a sync `filesUsedBefore`,
  read before the apply). `sweepFiles`, when the app opens and after each sync, unmarks the marked
  files used again and deletes those marked more than a week ago (`FILE_GRACE_MS`), with their
  thumbnail: first on the server (`SyncEngine.deleteFromServer`; one that fails stays for the next
  sweep), then here. A device that doesn't sync deletes only its own; the server's headless device
  (it keeps no files) never deletes the server's. Every synced device reaches the same answer from
  the same rows; the first to sweep deletes the server's copy, the others find it gone. The week
  covers a cut and paste across a save, late and out-of-order syncs, an offline edit. When pushed
  rows use a file the server no longer
  has, the answer lists it (`missingFiles`) and a device with the bytes queues it again.

## The server's language model

`KUBUS_AI_URL`, `KUBUS_AI_KEY`, `KUBUS_AI_FIELD_MODEL`, `KUBUS_AI_CODE_MODEL` (`server/src/ai.ts`) give
every device the same model. `GET /api/ai` says what is offered (`ServerAi` in `shared/api.ts`: the
models, never the address or key); `POST /api/ai/chat/completions` and `GET /api/ai/models` forward
to the provider with the server's key, for any device with the token. In the app, Settings → AI →
"The server's" (`AiConfig.source`, the default without a device's own) points `createLlmClient` at
`<server>/api/ai` with the sync token (`AiService.providerOf`); "My own" keeps today's per-device
provider. The headless device doesn't generate AI values (that stays with the apps).

## The API (headless device) and webhooks

`/api/v1` (documented for users in `app/src/help/api.md`, the Help page's API tab) is answered by the
app's own `SqliteRepository` running inside the server process as one more synced device
(`app/src/headless`), never by writing to Postgres: so it follows the GUI's rules (field diffing,
file release, AI fields, the "All" view, soft deletes, change sets).
- *Device*: `DirectSqlClient` (in-memory sqlite-wasm, `SqliteEngine` as in the worker), the real
  `SyncEngine` with `memoryEnvironment({ keepFiles: false })` (settings in memory; file bytes dropped
  once uploaded, fetched from the server when asked), syncing over HTTP with `http://127.0.0.1:$PORT`
  and listening to `/api/events`. It starts with a first connection (everything but bytes). After a
  wipe (409) it wipes itself and connects again: it is a cache, it never uploads stale data.
- *Requests* run one at a time (`HeadlessDevice.serial`); each syncs first unless the device is
  already at the server's latest write (`HeadlessOptions.cursor`, which the server knows: reads see
  the latest data without a request), and a write syncs again before it answers.
- *Routes* (`headless/api.ts`): each a thin translation onto one `Repository` method; names by id or
  name (`values.ts`: values by field name, checked per kind; component values included, read only,
  computed with `refLabelForSpace` as the screens and the AI backfill do). File bytes
  (`GET /api/v1/files/<id>`) come from the server's own handler. Errors `{ error }` 400 / 404 / 409 /
  503.
- *Component code* runs there in a V8 context of its own (`headless/compiler.ts` via `setCompiler`):
  no Node globals, no `eval`, 1 s per section. Not a security boundary: whoever holds the token can
  run code on the server.
- *Build*: `npm run build:headless` (`app/vite.headless.config.ts`, an SSR build) bundles
  `app/src/headless/index.ts` into `server/headless/index.js` (git-ignored; the Dockerfile's web stage
  builds it); sqlite-wasm stays external. The server loads it with a dynamic import
  (`server/src/headless.ts`); without it `/api/v1` answers 503 saying to build it.
- *Webhooks* (`headless/webhooks.ts`): `SyncEngine.onPulled` reports each sync's applied rows and
  the ones it sent (the API's own writes, which the server doesn't send back); the device turns them into events (item created / updated / deleted with the item as the API returns
  it; collection, view, space, component, bookmark changed) and POSTs one payload per sync to each of
  `KUBUS_WEBHOOK_URL` (comma-separated), signed with `KUBUS_WEBHOOK_SECRET` (`X-Kubus-Signature:
  sha256=<HMAC>`). Created = first seen by the hook. In order per URL, retried after 1, 5, 30 s, then
  dropped and logged; nothing survives a restart. The first download isn't sent.

**iOS / home-screen app.** The same web build. Status bar: no style meta (`default`); iOS
colours the bar from the top tab strip (sticky, solid, full width; see Conventions). `body` is
fixed and only pane bodies scroll, no bounce or zoom; the workspace is `position: fixed; inset: 0`.
Files: `app/public/manifest.webmanifest`, apple-touch-icon (its href gets a content hash at build, `vite.config.ts`; iOS never refreshes an installed icon, so a changed icon only shows after removing and re-adding the app) and
meta tags in `app/index.html`, safe-area padding in `styles.css`, and a service worker (`app/sw.js`,
emitted by the build with a version stamp; `platform/serviceWorker.ts` registers it in production
web builds only) that caches the app shell, so it starts offline. iOS needs HTTPS for OPFS and
service workers: put the container behind a TLS proxy or tunnel (Caddy, Tailscale serve, Cloudflare
tunnel). The Tauri app (https origin) can only sync with an HTTPS server too.

**Known limits / next steps:**
- Last writer wins per field; concurrent offline edits to the *same markdown field* lose one side
  (upgrade path: a text CRDT such as Yjs for markdown). Equal timestamps on two devices don't converge.
- A pull is not paged. Webhooks are best effort (lost on a restart). A device never frees space by
  dropping originals it has. A file unused for a week (on the device that sweeps first) and then used
  again by a device that only had its metadata is lost (shown as missing). A device that sweeps
  while sync is off keeps the server's copy (another device's sweep deletes it).
- One user, one token (the API too; it can also run component code on the server). A device that is not synced can lose its data on a schema wipe; with the
  server the replica re-syncs, so enable sync before putting real notes in. Connecting a device that
  has data of its own to a server that has data too discards the device's data (no merge).
- Not built: hybrid logical clocks, Merkle-trie diffing (Actual Budget style), end-to-end encryption,
  Postgres `LISTEN/NOTIFY` for several server instances. Consider ElectricSQL / PowerSync / cr-sqlite
  before growing this.
