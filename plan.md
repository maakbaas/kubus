# Plan: server API (headless device), webhooks, file transfer and thumbnails, Help tabs

Status: proposal, nothing built yet.

## Goals

1. Everything the GUI can do to data is also possible over HTTP, with the same `KUBUS_TOKEN`,
   for any outside tool (automation tools, scripts, cron jobs). The API is general, not shaped
   around one tool.
2. The server can call a webhook whenever data changes, whoever changed it (a device, the API).
3. Many images (thousands) stay fast and fit on a phone: file bytes no longer travel inside
   `/api/sync`, small images (thumbnails) are shown wherever an image is shown small, and a device
   can download originals only when they are opened. The server keeps the bytes in Postgres (no S3),
   and files no longer used by any item are cleaned up automatically, on devices and on the server.
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
devices ──────/api/sync, /api/files──> server ──> Postgres (rows, file bytes)
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
  router, used by the devices' endpoints too. Shared decoders resolve names (collection, space,
  field, component) and turn the API's shapes into `Repository` arguments.
- **Field and collection edits:** `saveCollection` takes the whole collection. One helper
  (`headless/schema.ts`) loads the collection, applies one change (add, change, remove or reorder
  a field, change a setting) and saves it, so each route stays a few lines.

## 2. The HTTP API (`/api/v1`, `Authorization: Bearer $KUBUS_TOKEN`)

Resources, JSON in and out, with plain routes for everything the GUI can do (no generic RPC
endpoint). Each route is a thin translation onto one `Repository` method, so the rules stay in one
place. The shapes are the API's own, documented on the Help page, and they don't change when an
internal signature does.

Names: a collection can be given by its id, name or plural name (any case); a space by id or name
(default: the default space); a field by id or name; a component by id or name.

**Spaces**

| Method + path | What | Repository |
|---|---|---|
| `GET /spaces` | spaces | `listSpaces` |
| `POST /spaces` `{ name, icon? }` | create | `saveSpace` |
| `PATCH /spaces/{s}` `{ name?, icon? }` | rename, change icon | `saveSpace` |
| `DELETE /spaces/{s}` | delete with its items, views and bookmarks | `deleteSpace` |

**Collections and fields** (the schema-change policy applies exactly as in the GUI)

| Method + path | What | Repository |
|---|---|---|
| `GET /collections?space=` | collections with their fields and item counts | `listCollections`, `countItemsByCollection` |
| `GET /collections/{c}` | one collection | `listCollections` |
| `POST /collections` `{ name, pluralName, icon?, description?, spaces?, fields: [{ name, kind, … }] }` | create; it gets its "All" view | `saveCollection` |
| `PATCH /collections/{c}` `{ name?, pluralName?, icon?, description?, spaces? }` | change the collection's own settings | `saveCollection` |
| `DELETE /collections/{c}` | delete (refused while other collections refer to it, as in the GUI) | `deleteCollection` |
| `POST /collections/{c}/fields` `{ name, kind, … }` | add a field | `saveCollection` |
| `PATCH /collections/{c}/fields/{f}` `{ name?, … }` | change a field (rename, options, AI prompt…) | `saveCollection` |
| `DELETE /collections/{c}/fields/{f}` | remove a field (its images are released) | `saveCollection` |
| `PUT /collections/{c}/fields/order` `[f, …]` | field order | `saveCollection` |

**Items**

| Method + path | What | Repository |
|---|---|---|
| `GET /collections/{c}/items?space=&limit=&offset=` | items with `values` by field name, computed fields included | `listItems` |
| `POST /collections/{c}/items` `{ space?, values }` | create; returns the item | `createItem` |
| `GET /items/{id}` | one item | `getItem` |
| `PATCH /items/{id}` `{ values }` | update only the fields given | `updateItem` |
| `DELETE /items/{id}` | soft delete | `deleteItem` |
| `POST /items/{id}/move` `{ space }` | move to another space | `moveItem` |
| `PUT /items/{id}/item-view` `{ itemView }` (null: the collection's default) | pin an item view | `pinItemView` |
| `PUT /items/{id}/ai/{f}` `{ value }` | write an AI field's generated value; the input hash is worked out from the current inputs, as the backfill does | `setGenerated` |
| `POST /items/{id}/ai/{f}/accept` | keep a typed-over AI value | `acceptEdit` |
| `GET /search?q=&space=&limit=` | global search | `search` |

**Views**

| Method + path | What | Repository |
|---|---|---|
| `GET /collections/{c}/views?space=` | collection views, the default marked | `listViews` |
| `POST /collections/{c}/views` `{ name, space?, blocks }` | create | `saveView` |
| `PATCH /views/{id}` `{ name?, blocks? }` | change | `saveView` |
| `DELETE /views/{id}` | delete | `deleteView` |
| `PUT /collections/{c}/default-view` `{ space?, view }` (null: none) | set the default | `setDefaultView` |
| `GET /collections/{c}/item-views` | item views with their layouts | `listCollections` |
| `PUT /collections/{c}/item-views` `[…]` | replace the item views | `saveItemViews` |

Blocks and layouts are the stored shapes (`ViewBlock`, `ItemLayout`), with fields given by id or
name; the Help page documents them.

**Bookmarks and components**

| Method + path | What | Repository |
|---|---|---|
| `GET /bookmarks?space=` | bookmarks | `listBookmarks` |
| `POST /bookmarks` `{ space?, kind, collection, target, label }` | add | `addBookmark` |
| `PATCH /bookmarks/{target}` `{ label }` | rename | `relabelBookmark` |
| `DELETE /bookmarks/{target}?space=` | remove | `removeBookmark` |
| `GET /components`, `GET /components/{id}` | components with their code | `listComponents` |
| `POST /components`, `PATCH /components/{id}` | create, change (the same checks as the editor: `placeProblem`) | `saveComponent` |
| `DELETE /components/{id}?withFields=` | delete | `deleteComponent` |

**Files**

| Method + path | What | Repository |
|---|---|---|
| `POST /files` (raw body, `Content-Type`) | store; returns `{ id }` for an image field or `files/<id>` in Markdown | `putFile` |
| `GET /files/{id}` | the bytes | the same handler as the devices' `GET /api/files/{id}` |

How values look:
- **Item:** `{ id, collection, collectionId, spaceId, itemViewId, label, createdAt, updatedAt, values }`.
- **Value types:** the stored types (`FieldValue`): string, number, boolean, `YYYY-MM-DD`, ISO
  datetime, string arrays, item ids for references, a file id for an image.
- **Computed values:** component values appear in `values` as well, but are read-only. Writing
  one is refused.
- **Errors:** `{ error }` with 400 (bad input), 404 (unknown collection, item, field, view…),
  409 (refused by a rule, e.g. deleting a collection others refer to) or 503 (sync not reachable).

Not exposed: the sync controls, `wipeLocal`, `subscribe`, `listLabels` (item labels are in every
item), `releaseFiles` (clean-up is automatic, §3). Server wipe stays `POST /api/wipe`.

**Devices keep their own protocol.** The API is not used for device sync, on purpose:
- A device replicates rows (outbox, cursor, a merge per field, tombstones) so that it works offline
  and merges later. API calls are operations that need the server at the moment they are made.
- Syncing through the API would mean recording every offline edit as an operation and replaying
  it in order: a different, more fragile sync design.
- The reuse is one level down: the API calls the same `Repository` as the GUI, and the headless
  device turns its writes into rows through the same sync.

Shared between both: the router table, the token check, the `{ error }` format and the file
bytes handler. `/api/sync`, `/api/events` and `/api/files` stay outside `/api/v1`: they are the
devices' internal protocol, not a public API, and change with the app.

## 3. Files: their own transfer, thumbnails, originals when needed

Why: storing images in SQLite on a device and in Postgres on the server is not what makes many
images slow. Item queries never read the `files` table. Three things are slow:
- full-size originals (up to 20 MB) decoded to draw a thumbnail in a table or card;
- bytes as base64 inside the `/api/sync` JSON, in one unpaged request;
- every device downloading every original (thousands of photos don't fit on a phone, and iOS evicts).

Moving bytes to S3 would fix none of these, so there is no S3. Nothing changes for a device
without a server: it keeps every byte it stores, as now.

**Thumbnails (on every device, with or without a server)**
- When an image is stored (`storeImageFile`), the device also makes a thumbnail: shortest side
  512 px (so a card cropping it to its own shape stays sharp), the longest side capped at 2048 px
  (panoramas), with `createImageBitmap` and `OffscreenCanvas`. It is WebP, or JPEG / PNG (if
  transparent) where the browser can't encode WebP (Safari). No thumbnail when the image is
  already small (shortest side ≤ 512 px, or ≤ 100 KB), for SVG (vector), or for an animated GIF: those show the
  original.
- The thumbnail is an ordinary content-addressed `files` row. A new synced, insert-only table
  `thumbnails (file_id PRIMARY KEY, thumb_id)` links it to its original. `files` rows stay
  immutable. If two devices make a thumbnail for the same file at once, the server keeps the first
  link. A device whose own link lost keeps using its own thumbnail, and both are valid.
- Images stored before this change, and images stored through the API (no canvas in Node), get a
  thumbnail lazily: the first device that shows one small, with its original present, makes it.
- **Used:** only in table cells and cards (`useFileUrl` gets a "small" flag). **Original:**
  everywhere else: image fields on an item page, the Lightbox, Markdown images and component
  images (`fileDataUrl`).
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
- The bytes go in a new Postgres table `file_bytes (id PRIMARY KEY, data bytea, stored_at)`, out of
  the sync tables, read and written only by `server/src/files.ts`.
- `files` keeps the synced metadata: `id` (SHA-256), `mime`, `size`, `created_at`, `seq`.
- `PUT /api/files/{id}`: checks that the SHA-256 of the body equals `id` (a wrong or partial upload
  is refused) and the 20 MB limit (+ margin). `GET /api/files/{id}` returns the bytes with their
  `Content-Type` and a long `Cache-Control` (content-addressed). Both need the token.
- **Existing servers:** at start, `files.data` is moved into `file_bytes`, then the column is
  dropped (in `server/schema.sql`, in one transaction). No server loses its images, and devices
  keep their own bytes.
- `/api/sync` gets much smaller, so `MAX_BODY` can drop from 100 MB to about 10 MB.
- Wipe server: also clears `file_bytes`.
- `shared/sync.ts`: `files` loses `data`, and `thumbnails` is added. The `bytes` column type and
  the base64 code go (nothing else uses them). `sync/spec.test.ts` is updated so the local-only
  `data` column is allowed.
- `/api/v1/files` (the API) uses the headless device's `putFile` / `getFile`, so it goes through
  the same path as the GUI.

**Cleaning up unused files**

Today a device deletes a file when its own edit removes the file's last use (`releaseFile`). That
delete isn't synced (`files` is insert-only), and nothing runs when the last use goes away through
a sync (an item deleted on another device). So other devices and the server keep such files for
good. To clean them up automatically:
- **One rule.** A file is in use when a live item, through a live field, has it as an image value
  or mentions `files/<id>` in a Markdown or HTML value. This is the `liveUse` expression of
  `releaseFile` today. A thumbnail is in use when its original is. `SqliteRepository` gets
  `unusedFiles(ids?)` built from that same expression, so there's no second version of it.
- **No synced deletes.** Every device and the server apply the same rule to the same data and reach
  the same answer, so `files` stays insert-only and needs no tombstones.
- **Devices.** While applying a sync, the engine notes the files the replaced or deleted rows used
  (read before the merge overwrites them: image values, `fileIdsIn` of Markdown / HTML, the
  fields and items deleted). After the sync it releases those that are now unused, exactly as a
  local edit does today, with their thumbnails and `thumbnails` links.
- **Server: tracked the same way, deleted after a grace period.** The headless device applies
  every sync with the same candidate tracking. When a file loses its last use it is marked
  (`file_bytes.unused_since`), and the mark is cleared when a use comes back. A file uploaded
  before any row uses it starts out marked. An hourly pass deletes the `files` row and
  `file_bytes` of files marked for more than 7 days. It only reads the marks, it doesn't scan
  everything.
- **Why not delete on the server at once:** devices sync late and out of order, so "the last use
  is gone" on the server is not final. A file's use can arrive after its bytes (a sync that ran out
  of its upload budget). An offline device can still hold an edit that uses it. An undo or a cut
  and paste in Markdown removes a use and adds it back moments later. The 7 days cover those cases
  without a re-upload.
- **No stored usage index.** Uses in Markdown and HTML are found by parsing text (`fileIdsIn`),
  which a SQLite trigger can't do. An index would have to be kept up to date by hand on every write
  path (edits, sync apply, field and collection deletes), and a derived table can drift from the
  data. Checking only the files that changed rows used, at the moment they change, gives the same
  "last use removed" behaviour without one.
- **Back in use after deletion.** A device that brings a deleted file back into use (an old
  offline edit) doesn't lose it. The `/api/sync` answer lists the files used by the pushed rows
  that the server doesn't have (`missingFiles`). The device queues them again and uploads their
  bytes at the next sync. For this, `fileIdsIn` moves from `domain/files.ts` to `shared/files.ts`,
  used by the app and the server. Only a file nobody has the bytes of anymore is lost: unused for
  a week, and then used again by a device that only had its metadata. It shows as missing.
- **A download that answers 404** (deleted on the server) removes the local row when it is unused
  locally too.

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
    (no S3).
- **Docs:**
  - `docs/sync.md`: the headless device, the API, webhooks, `/api/files`, file clean-up, thumbnails, the download setting and the updated known limits;
  - `docs/data-model.md`: files (nullable `data`, thumbnails);
  - `docs/features.md`: thumbnails and the Lightbox loading the original;
  - `CLAUDE.md`: commands (`build:headless`), the repo layout, and the rule "the API goes through
    the headless device's Repository, never into Postgres".

## Tests

- **Unit (vitest):**
  - `values.ts` (by name, validation, computed fields read-only);
  - the router, name resolution and the field / collection edit helper;
  - one test per route against the headless device in Node (status codes, shapes, refusals);
  - webhook event building (created / updated / deleted);
  - the sync engine's file upload and download against a fake fetch (upload before the row,
    the per-sync upload budget, thumbnails first, the "when opened" setting, retries);
  - the `files` upgrade (a database with bytes keeps them; `data` becomes nullable);
  - clean-up: the rule (image value, Markdown, HTML, deleted item or field, thumbnail with its
    original), release after a sync, the server's mark and clear (`unused_since`), `missingFiles`
    and re-upload;
  - thumbnail choice: when one is made, which size, which places use it, `releaseFile` freeing both;
  - `DirectSqlClient` plus `SqliteRepository` running in Node (the headless device's own path).
- **Server:** typecheck. A manual run with Postgres (`docker compose up`): create items by API,
  see them on a device, upload an image on one device and see its thumbnail and original arrive on
  another, start an existing server and check its images moved to `file_bytes`, delete an item and
  see its image released on the other device (and on the server after the grace period, shortened
  for the test), receive webhooks.
- **GUI suite:** the image cases still pass (thumbnails in tables and cards, the original in the
  Lightbox).

## Order of work

1. `SqliteEngine` / `SqlClient` split, then `SyncEnvironment` (no behaviour change; tests stay green).
2. Files: `file_bytes` with the move of existing bytes, `/api/files`, nullable local `data`, upload
   and download in the engine, the download setting, wipe.
3. Thumbnails: making them on store and lazily, `thumbnails` table and sync, the places that use
   them, release.
4. Clean-up: `unusedFiles`, release after a sync, `missingFiles`, the server's marks and hourly pass
   (needs the headless device, so its server half lands with step 5).
5. Headless device: bundle, `DirectSqlClient`, start-up and reset, request queue.
6. API: values, router, the routes table by table (items, collections and fields, views, bookmarks,
   components, spaces, AI values), shared reference-label function, computed values.
7. Webhooks.
8. Help tabs and `api.md`; compose, docs, CLAUDE.md.

## Open questions

- Should a separate, more limited token for outside tools come later (read-only, or no wipe)?
  This plan uses the one `KUBUS_TOKEN`, as asked.
- A device never throws away originals it has (no "free up space" yet).
