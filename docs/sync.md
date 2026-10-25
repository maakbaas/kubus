# Sync with Postgres

The server, the sync engine and the home-screen app.

## Sync with Postgres (the server and the sync engine)

Repo layout: `app/` the web app (what Tauri and the phone run), `desktop/` the Tauri shell,
`server/` the sync server (Node 24, runs its TypeScript directly, only dependency `pg`),
`shared/sync.ts` the protocol both sides import (the list of synced tables / columns / types and
the request shapes).

**Topology.** `app ──HTTPS──> server ──> Postgres` (the example `docker-compose.yml` runs its own; any other via `DATABASE_URL`). The
client never talks to Postgres: browsers and the iOS PWA can only do HTTP. One container
(`server/Dockerfile`, `docker-compose.yml` with `DATABASE_URL` and `KUBUS_TOKEN`) serves the
sync API at `/api` and the built web app at `/`, so the phone installs the app from the server
(same origin, no CORS). Auth is one shared bearer token (`KUBUS_TOKEN`); the app's
Settings (`#/settings?section=sync`, the Sync tab, `ui/SyncSettings.tsx`; reached from the "Configure sync" button in the
popover of the status icon ending the top-right tab strip, `ui/SyncStatusButton.tsx`, which itself only shows the state) holds server URL + token + on/off + Disconnect (forgets the server; the
device keeps its data and the next connection is a first one), per device (localStorage
`kubus.sync`). A readable Postgres replica (not end-to-end encrypted) was chosen, as the hub
vision wants server-side queries and remote sources later.

**Client** (`app/src/data/sync/SyncEngine.ts`, created by `SqliteRepository`, exposed as `repo.sync`):
- *Outbox by triggers.* `schema.sql` has `AFTER INSERT/UPDATE` triggers on every synced table that
  queue the row's key in `sync_outbox` (local only), in the same transaction as the change; so no
  repository method knows about sync. Rows the engine applies from the server are not queued
  (`meta` row `sync_applying` is set during the apply). `worker.ts` `upgradeInPlace` also
  (re)creates triggers. A new synced table or column needs: `shared/sync.ts`, `server/schema.sql`
  (CREATE + ALTER line) and triggers in `schema.sql`; `sync/spec.test.ts` fails until they agree.
- *One request does push and pull*: `POST /api/sync { since, changes }` returns `{ cursor, changes }`
  (rows with server `seq` > since). Applying the response, clearing the sent part of the outbox
  (`id <= snapshot`; edits made during the request stay queued) and storing `meta.sync_cursor` is
  one local transaction. Pulls are incremental (per row; `field_values` rows are single fields).
- *Merge*: a row replaces the local one only if its `updated_at` is newer (field-level last writer
  wins, since every value is its own row). Files are immutable and inserted if missing. `now()`
  never goes below a timestamp received from the server (`observeStamp`), a cheap guard against clock
  skew instead of a hybrid logical clock.
- *First connection to a server* (or a changed server URL): the server is the source of truth. If it
  holds data, that replaces everything on the device (one local transaction, nothing is sent; the
  Sync settings ask for confirmation first, `isNewServer`). Only an empty server takes the device's data
  instead: all local rows are queued and uploaded.
- *When*: 2 s after a local write, every 30 s, on `online`, when the app becomes visible, and when the
  server signals a change (`GET /api/events`, server-sent events read with `fetch` so the token goes
  in a header; reconnects with backoff). Applied changes are announced as `DataChange`s, so every
  view refreshes as for a local write.

**Server** (`server/src`): `sync.ts` runs a request in one transaction under an advisory lock, so
`seq` (from `sync_seq`, taken per written row) order is commit order and a cursor never skips a row.
`server/schema.sql` is generated from `shared/sync.ts` (jsonb, timestamptz, bytea, …; no foreign
keys or checks) and applied idempotently at start. `events.ts` is the change signal. Proxies must not
buffer `/api/events` (nginx: `proxy_buffering off`); polling covers a dropped stream.

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
- Files travel inline (base64) and are never deleted on the server; a pull is not paged.
- One user, one token. A device that is not synced can lose its data on a schema wipe; with the
  server the replica re-syncs, so enable sync before putting real notes in. Connecting a device that
  has data of its own to a server that has data too discards the device's data (no merge).
- Not built: hybrid logical clocks, Merkle-trie diffing (Actual Budget style), end-to-end encryption,
  Postgres `LISTEN/NOTIFY` for several server instances. Consider ElectricSQL / PowerSync / cr-sqlite
  before growing this.
