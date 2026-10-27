# Plan: server API (headless device), webhooks, file transfer and thumbnails, Help tabs

Status: proposal, nothing built yet.

## Goals

1. Everything the GUI can do to data is also possible over HTTP, with the same `KUBUS_TOKEN`,
   for any outside tool (automation tools, scripts, cron jobs). The API is general, not shaped
   around one tool.
2. The server can call a webhook whenever data changes, whoever changed it (a device, the API).
3. Many images (thousands) stay fast and fit on a phone: file bytes no longer travel inside
   `/api/sync`, small images (thumbnails) are shown wherever an image is shown small, and a device
   can download originals only when they are opened. On the server, bytes sit behind a `FileStore`
   interface, kept in Postgres for now; S3 can come later as a second implementation.
4. The Help page gets tabs along the top: "Components" (today's text) and "API".
5. Computed (component) field values are included when the API returns items.

Unchanged: the app stays local-first and works fully offline, with or without a server.

## 1. The headless device

The API runs the app's own `SqliteRepository` inside the server process as one more synced
device. It does not write into Postgres directly, so the API follows exactly the same rules as the
GUI: field diffing, file release, AI field handling, the "All" view a new collection gets, soft
deletes and change sets. A Postgres version of the repository would duplicate about 900 lines in
another SQL dialect, so that is ruled out.

```
outside tool ──HTTP /api/v1 + token──> server ──> headless device (SqliteRepository, in-memory SQLite)
                                                        │  syncs over HTTP to 127.0.0.1, like any device
devices ──────/api/sync, /api/files──> server ──> Postgres (rows) + FileStore (file bytes, Postgres for now)
```

- **Database:** the same sqlite-wasm the app uses (it has a Node build), in memory. The headless
  device is a cache of Postgres. At start it makes a first connection, which downloads everything
  except file bytes. After a server wipe it gets the 409 "database replaced" answer: it wipes
  itself and connects again. It never uploads stale data.
- **Sync:** the real `SyncEngine`, talking HTTP to its own server at `http://127.0.0.1:$PORT`.
  No second sync code path. It listens to `/api/events` like the app does, so it hears device
  changes within a second.
- **Consistency:** API requests run one at a time. Each one syncs first (an incremental pull,
  usually empty), so it reads the latest data. A request that writes syncs again before it
  answers, so the change is in Postgres, and on other devices, by the time the response arrives.
- **Build:** app code imports modules without `.ts` extensions and uses Vite's `?raw` imports, so
  Node can't run it directly. A small Vite SSR build (`app/vite.headless.config.ts`, root script
  `npm run build:headless`) bundles `app/src/headless/index.ts` into `server/headless/` (git-ignored).
  `@sqlite.org/sqlite-wasm` stays external and becomes the server's second dependency. The server
  loads the bundle with a dynamic import. Its types come from `shared/api.ts`, types only, as
  `shared/sync.ts` is. Without the bundle (server dev before building), `/api/v1` answers 503 and
  says to run `npm run build:headless`. The Dockerfile's web stage builds it next to the web app.

### Abstractions (no duplicated code)

- **SQLite engine:** `worker.ts` today mixes the OPFS / lock handling with schema upgrade and
  `select` / `write` / `wipe`. Split it:
  - `sqlite/engine.ts`: `SqliteEngine` wraps an oo1 database: `ensureSchema` (the upgrade code moved
    as is), `select`, `write`, `wipe`.
  - `worker.ts` keeps only the lock, the pool-file probe and the OPFS VFS (`acquireDbLock` /
    `poolFilesFree` untouched), then hands messages to `SqliteEngine`.
  - `SqlClient` becomes an interface with two implementations: `WorkerSqlClient` (today's
    `SqlClient`, browser) and `DirectSqlClient` (in-process `SqliteEngine`, Node).
- **Sync environment:** `SyncEngine` reads `localStorage`, `location`, `document`, `addEventListener`
  and `fetch` directly. Those move into a `SyncEnvironment` that `SqliteRepository.open` passes in:
  - a key/value store;
  - the default server URL;
  - "watch" hooks (online, visibility);
  - which file bytes to keep locally (see §3).

  The browser environment keeps today's behaviour exactly. The headless one has in-memory
  settings and keeps no bytes (it drops them once uploaded).
- **Reference labels for computed values:** `aiBackfill.ts` already works out the labels that
  `withComputed` needs without the UI (`buildTargetOptions` / `refLabelOf`). Move that loop into one
  function in `domain/refOptions.ts`, for example `refLabelForSpace(repo, collection, spaceId, world)`.
  The backfill and the API both call it, so the API computes component values exactly as the screens do.
- **Values by field name:** one module (`headless/values.ts`) turns an item into
  `{ "Field name": value }` and back. It resolves fields by name or id and checks each value
  against its kind (`fieldKinds`).
- **API routes:** one table of `{ method, path pattern, handler }`, so `/api/v1` has a single
  router. The RPC endpoint is one more table entry that maps a method name to argument decoders.

## 2. The HTTP API (`/api/v1`, `Authorization: Bearer $KUBUS_TOKEN`)

Resources, JSON in and out. A collection can be named by its id, name or plural name (any case);
a space by id or name (default: the default space). A field can be named by its id or name.

| Method + path | What |
|---|---|
| `GET /spaces` | spaces |
| `GET /collections`, `GET /collections/{c}` | collections with their fields |
| `GET /collections/{c}/items?space=&limit=&offset=` | items with `values` by field name, computed fields included |
| `POST /collections/{c}/items` `{ space?, values }` | create; returns the item |
| `GET /items/{id}` | one item |
| `PATCH /items/{id}` `{ values }` | update only the fields given |
| `DELETE /items/{id}` | soft delete |
| `POST /items/{id}/move` `{ space }` | move to another space |
| `GET /search?q=&space=` | global search |
| `POST /files` (raw body, `Content-Type`) | store a file; returns `{ id }` for an image field or `files/<id>` in Markdown |
| `GET /files/{id}` | the bytes |
| `POST /rpc/{method}` `{ args: [...] }` | any `Repository` data method, so schema edits, views, item views, bookmarks, components, AI values (`setGenerated`) and so on are all reachable. Collection and field arguments are given by id or name. |

How values look:
- **Item item:** `{ id, collection, collectionId, spaceId, itemViewId, label, createdAt, updatedAt, values }`.
- **Value types:** the stored types (`FieldValue`): string, number, boolean, `YYYY-MM-DD`, ISO
  datetime, string arrays, item ids for references, a file id for an image.
- **Computed values:** component values appear in `values` as well, but are read-only. Writing
  one is refused.
- **Errors:** `{ error }` with 400 (bad input), 404 (unknown collection, item or field) or
  503 (sync not reachable).

Not exposed: the sync controls, `wipeLocal`, `subscribe`. Server wipe stays `POST /api/wipe`.

## 3. Files: their own transfer, thumbnails, originals when needed

Why: storing images in SQLite on a device and in Postgres on the server is not what makes many
images slow. Item queries never read the `files` table. Three things are slow:
- full-size originals (up to 20 MB) decoded to draw a thumbnail in a table or card;
- bytes as base64 inside the `/api/sync` JSON, in one unpaged request;
- every device downloading every original (thousands of photos don't fit on a phone, and iOS evicts).

Moving bytes to S3 fixes none of these, so S3 is left for later (see Open questions). Nothing
changes for a device without a server: it keeps every byte it stores, as now.

**Thumbnails (on every device, with or without a server)**
- When an image is stored (`storeImageFile`), the device also makes a thumbnail: longest side
  512 px, with `createImageBitmap` and `OffscreenCanvas`. It is WebP, or JPEG / PNG (if
  transparent) where the browser can't encode WebP (Safari). No thumbnail when the image is
  already small (≤ 512 px or ≤ 100 KB), for SVG (vector), or for an animated GIF: those show the
  original.
- The thumbnail is an ordinary content-addressed `files` row. A new synced, insert-only table
  `thumbnails (file_id PRIMARY KEY, thumb_id)` links it to its original. `files` rows stay
  immutable. If two devices make a thumbnail for the same file at once, the server keeps the first
  link. A device whose own link lost keeps using its own thumbnail, and both are valid.
- Images stored before this change, and images stored through the API (no canvas in Node), get a
  thumbnail lazily: the first device that shows one small, with its original present, makes it.
- **Used:** table cells, cards and an image field shown at its small size (`useFileUrl` gets a
  "small" flag). **Original:** the Lightbox, Markdown images and component images (`fileDataUrl`).
  A small place whose thumbnail isn't there yet shows the original if present; the Lightbox shows
  the thumbnail until the original arrives.
- `releaseFile` releases the thumbnail together with its original.

**Files table on a device**
- `files.data` becomes nullable. This is an in-place upgrade (a table rebuild, no data lost).
  A row with `data IS NULL` means the device knows the file, from a sync, but hasn't downloaded
  its bytes.

**Transfer (devices with a server)**
- **Upload:** before a sync request, the engine uploads the bytes of queued `files` rows with
  `PUT /api/files/{id}` (raw body, a few at a time), then sends those rows (metadata only) in
  `/api/sync`. The server never lists a file whose bytes it lacks.
  - There is no foreign key on the server, so other rows don't wait on uploads.
  - Each sync uploads within a budget (about 50 MB or 30 s), so a device with a large backlog
    still syncs its edits at once. Rows not yet uploaded stay queued for the next sync.
  - A failed upload is retried at the next sync.
  - Until then, another device shows such an image as "not synced yet".
- **Download:** files arriving from the server are inserted without bytes. After each sync, in
  the background (other rows are already applied), the engine fetches missing bytes with
  `GET /api/files/{id}`, a few at a time: thumbnails first, then originals. One that fails is
  retried at the next sync.
- **Setting (Settings → Sync), per device:** "Download originals: always | when opened".
  - **Always** (the default) keeps today's promise: a synced device has every image offline.
  - **When opened** suits phones with many photos: only thumbnails are downloaded. An original is
    fetched the first time it is shown and then kept.
  - Offline, an original that isn't on the device shows its thumbnail enlarged, with a note.
  - Thumbnails are always downloaded.
- **`getFile`:** when the bytes are missing and a server is set, it fetches them right away and
  keeps them, unless the device keeps no bytes (the headless device).

**On the server**
- A `FileStore` interface (`put`, `get`, `has`, `clear`). For now it has one implementation in
  Postgres: a new table `file_bytes (id PRIMARY KEY, data bytea)`, out of the sync tables. S3
  later is a second implementation; nothing else changes then.
- `files` keeps the synced metadata: `id` (SHA-256), `mime`, `size`, `created_at`, `seq`.
- `PUT /api/files/{id}`: checks that the SHA-256 of the body equals `id` (a wrong or partial upload
  is refused) and the 20 MB limit (+ margin). `GET /api/files/{id}` returns the bytes with their
  `Content-Type` and a long `Cache-Control` (content-addressed). Both need the token.
- **Existing servers:** at start, `files.data` is moved into `file_bytes`, then the column is
  dropped (in `server/schema.sql`, in one transaction). No server loses its images, and devices
  keep their own bytes.
- `/api/sync` gets much smaller, so `MAX_BODY` can drop from 100 MB to about 10 MB.
- Wipe server: also clears the `FileStore`.
- `shared/sync.ts`: `files` loses `data`, and `thumbnails` is added. The `bytes` column type and
  the base64 code go (nothing else uses them). `sync/spec.test.ts` is updated so the local-only
  `data` column is allowed.
- `/api/v1/files` (the API) uses the headless device's `putFile` / `getFile`, so it goes through
  the same path as the GUI.

## 4. Webhooks

The headless device sees every change, from any device or the API, when it pulls. It turns them
into events and POSTs them to the configured URL(s).

- **Configuration:** `KUBUS_WEBHOOK_URL` (one URL, or several separated by commas) and an optional
  `KUBUS_WEBHOOK_SECRET`. With a secret, every request carries
  `X-Kubus-Signature: sha256=<HMAC of the body>`.
- **Payload, one POST per sync that brought changes:**
  ```json
  { "database": "<id>", "cursor": 123, "events": [
    { "type": "item.created", "id": "…", "collection": "Book", "collectionId": "…", "spaceId": "…", "item": { …as the API returns it, computed values included } },
    { "type": "item.updated", … }, { "type": "item.deleted", "id": "…", … },
    { "type": "collection.changed", "id": "…" }, { "type": "view.changed", … }, { "type": "space.changed", … },
    { "type": "component.changed", … }, { "type": "bookmark.changed", … } ] }
  ```
- **Created, updated or deleted:**
  - `deleted_at` set means deleted.
  - Otherwise `created_at = updated_at` means created.
  - Otherwise, or when only field values changed (an AI value, for example), updated.
- **Not sent:** the first full download at start or after a wipe.
- **Delivery:** in order, one at a time, a few retries with backoff (1 s, 5 s, 30 s), then logged
  and dropped. Delivery is best effort and doesn't survive a restart (documented).

## 5. Help page tabs

- `HelpPage` gets Carbon `Tabs` along the top, like Settings (`?section=components|api`).
- **Components:** today's `help/components.md`. It is still the text given to "Write with AI".
- **API:** a new `help/api.md`: authentication, every endpoint, the shape of values, files,
  webhooks and their signature, examples with `curl`.

## 6. Docker compose and docs

- **`docker-compose.yml`:**
  - commented `KUBUS_WEBHOOK_URL` / `KUBUS_WEBHOOK_SECRET` on the server. Nothing else changes
    (no S3 yet).
- **Docs:**
  - `docs/sync.md`: the headless device, the API, webhooks, `/api/files`, the `FileStore`, thumbnails, the download setting and the updated known limits;
  - `docs/data-model.md`: files (nullable `data`, thumbnails);
  - `docs/features.md`: thumbnails and the Lightbox loading the original;
  - `CLAUDE.md`: commands (`build:headless`), the repo layout, and the rule "the API goes through
    the headless device's Repository, never into Postgres".

## Tests

- **Unit (vitest):**
  - `values.ts` (by name, validation, computed fields read-only);
  - the router and RPC argument decoding;
  - webhook event building (created / updated / deleted);
  - the sync engine's file upload and download against a fake fetch (upload before the row,
    the per-sync upload budget, thumbnails first, the "when opened" setting, retries);
  - the `files` upgrade (a database with bytes keeps them; `data` becomes nullable);
  - thumbnail choice: when one is made, which size, which places use it, `releaseFile` freeing both;
  - `DirectSqlClient` plus `SqliteRepository` running in Node (the headless device's own path).
- **Server:** typecheck. A manual run with Postgres (`docker compose up`): create items by API,
  see them on a device, upload an image on one device and see its thumbnail and original arrive on
  another, start an existing server and check its images moved to `file_bytes`, receive webhooks.
- **GUI suite:** the image cases still pass (thumbnails in tables and cards, the original in the
  Lightbox).

## Order of work

1. `SqliteEngine` / `SqlClient` split, then `SyncEnvironment` (no behaviour change; tests stay green).
2. Files: `FileStore` and `file_bytes` with the move of existing bytes, `/api/files`, nullable local
   `data`, upload and download in the engine, the download setting, wipe.
3. Thumbnails: making them on store and lazily, `thumbnails` table and sync, the places that use
   them, release.
4. Headless device: bundle, `DirectSqlClient`, start-up and reset, request queue.
5. API: values, routes, RPC, shared reference-label function, computed values.
6. Webhooks.
7. Help tabs and `api.md`; compose, docs, CLAUDE.md.

## Open questions

- Should a separate, more limited token for outside tools come later (read-only, or no wipe)?
  This plan uses the one `KUBUS_TOKEN`, as asked.
- S3 as a second `FileStore` (`S3_*` settings, a tiny SigV4 client, copying existing bytes over,
  MinIO in compose) comes later. It only changes the server: devices only talk to `/api/files`.
  Its gains are in running the server (small database backups, cheap storage), not speed.
- The server never deletes file bytes (known limit, as today); a clean-up of unreferenced files
  could come with S3.
- A device never throws away originals it has (no "free up space" yet).
