# Data model

Storage conventions (sync-ready) and the known constraints of the local database.

## Architecture details

```
React UI (Carbon)  ──>  Repository interface  ──>  SqliteRepository  ──>  SQLite (WASM) in a Web Worker
app/src/pages, app/src/ui       app/src/data/repository.ts     app/src/data/sqlite/       persisted in OPFS (SAH-pool VFS)
```

- **Tauri is only a window.** `desktop` has no commands or DB bindings; its only plugin is
  `opener` (links open in the system browser), reached via `app/src/platform/openExternal.ts`, which
  falls back to `window.open` on the web. New native capabilities go in `app/src/platform/` the same way. All logic and
  storage live in the web frontend so the identical build runs in a browser / iOS home-screen app.
  Do not add Tauri-only APIs to the core; if a native capability is ever needed, put it behind an
  interface with a web fallback.
- **SQLite runs in the browser** via `@sqlite.org/sqlite-wasm` inside a dedicated worker
  (`app/src/data/sqlite/worker.ts`: the lock and OPFS; the schema, reads and writes are
  `SqliteEngine` in `engine.ts`), stored with the `opfs-sahpool` VFS (no COOP/COEP headers needed;
  Safari 16.4+). Without OPFS it falls back to an in-memory DB and the UI shows a warning.
- **Three hosts, one engine.** `SqliteEngine` runs on sqlite-wasm in the browser's worker (OPFS), on sqlite-wasm in
  memory in tests (`DirectSqlClient`), and on Node's built-in `node:sqlite` in the server's headless device
  (`NodeSqlClient`, `data/sqlite/node.ts`: a real WAL file, or `:memory:` without `KUBUS_HEADLESS_DIR`; `NodeDb` gives it
  the few `oo1.DB` methods the engine uses, integers bind as INTEGER and read back as numbers, BigInt beyond 2^53). The
  storage, sync and api tests run on both (vitest project `nodesqlite`, `docs/testing.md`).
- **Repository boundary.** The UI only talks to `Repository` (`app/src/data/repository.ts`); sync
  (`repo.sync`) lives behind it, so the UI knows nothing about it.
- **Change feed.** After every committed write the repository emits a `DataChange`
  (`spaces`, `collections`, `items` of a collection / item, `views` of a collection, `components`,
  `bookmarks`) via `repo.subscribe`. Anything that
  shows data refreshes through `useDataChanges` (app/src/app/useDataChanges.ts) rather than relying
  on whoever made the edit: item lists, item pages, reference labels, counts and the store's
  collections all do. Sync emits the same changes for data arriving from the server.
- **Writes are change sets.** Each mutating repository method collects its statements and commits
  them in one transaction (`SqlClient.write`); the sync outbox's triggers queue its rows in the same
  transaction.
- **Items are loaded once and shared** (`app/src/app/itemCache.ts`, hook `useItems`): while any
  pane shows a collection, its items (of the shown space) live in one cache, kept current from the change feed (a changed
  item is re-read alone; a collection whose fields changed is reloaded; switching spaces reloads
  all) and dropped 10 s after the last viewer leaves. Unchanged items keep their identity, which memoized rows
  (`ItemRow` / `ItemCard`) and `withComputed`'s per-item memo rely on: don't copy or
  rebuild items needlessly. Reference pickers and links need only labels: `useReferenceOptions`
  uses `Repository.listLabels` (ids + labels, no values) unless a field's choice filter needs the
  target's items. Stable `ItemActions` (delegating to the latest handlers) keep rows from
  re-rendering; keep new actions delegating the same way.
- **Domain model** (`app/src/domain`) is storage-agnostic. `fieldKinds.ts` is the registry of field
  kinds (DB column, codec, formatting); `ui/FieldInput.tsx` holds the matching editors.
- **Schema** is one file, `app/src/data/schema.sql` (plus the outbox triggers `data/schema.ts` makes
  from `shared/sync.ts`): what a new database gets. `PRAGMA user_version` is its version; an older
  database is migrated (`app/src/data/migrations.ts`, `ensureSchema` in `engine.ts`), one of a newer
  version is not opened. See `docs/migrations.md`.

## Data model (sync-ready conventions)

- Tables: `spaces`, `collections`, `fields`, `items`, `field_values` (EAV with typed columns
  `value_text | value_number | value_date | value_datetime | value_bool | value_ref | value_json`),
  `meta` (holds `replica_id`).
- Images live in `files` (content-addressed: id = SHA-256, immutable; the bytes in the local-only,
  nullable BLOB `data`: NULL until downloaded from the server) and are referenced from
  `field_values.value_file` (no foreign key: a file's row can arrive after its use) or from markdown
  as `files/<sha256>` (`file_uses`, kept by triggers, records which values name which files). `thumbnails` links an image to its small copy (another `files` row). Files are stored as soon as they're picked and
  released (`releaseFile` in `SqliteRepository.ts`: marked `unused_since`, with their thumbnail) in the same transaction as any write that drops
  the last reference (changed/removed image, deleted item/field), and after a sync that drops one; the item editor releases
  unsaved uploads when it closes. A week later `sweepFiles` deletes them, here and on the server, unless used again. Bytes travel
  apart from the rows (`/api/files`); the server keeps them in Postgres (`file_bytes`) until a device deletes them. See `docs/sync.md`, "Files".
- **Item links** (`item_links`, synced; `domain/backlinks.ts`): which items each value points at, for backlinks. One row per (source item,
  source field) whose value links anywhere: `id` = `<item id>/<field id>` (so every device makes the same row), `targets` = JSON array of
  `{ item, collection }` (a native item's id, or a remote row's item id; sorted, each once, keys in Postgres' jsonb order so the text
  survives the server unchanged), `updated_at` = **exactly the value's own** `field_values.updated_at`, `deleted_at` (= `updated_at`) when
  the value stopped linking anywhere (kept, so it syncs). Targets come from the field's kind: `item` (`value_ref`) and `item_list`
  (`value_json`, a list of item ids) point at `fields.target_collection_id`; `markdown`, `html` and `ai` text at the items it links to
  (`linkTargets`; a link to a field, view or block of an item counts as the item; `/items/new` and collection links don't). Other kinds
  (`value_json` also holds string lists, checklists, AI fingerprints) have no row. No foreign keys (a target can be a remote row, rows
  arrive in any order). A deleted source item or field isn't copied into the row: it is left out when reading (`listBacklinks` joins
  `items` and `fields`), so a restore needs nothing, and so does moving an item between spaces.
  - *Kept by triggers on `field_values`* (insert and update, `schema.sql`; the SQL function `link_targets`, defined by the engine like
    `file_ids`), so every write path (items, import, generated AI values, the API) maintains it in the same transaction, unless
    `sync_applying` is set: rows applied from a sync arrive with their own. The outbox triggers queue them like any synced row.
  - *Merge*: the row and its value have the same stamp and are written together, so the newest-wins merge (`updated_at`, ties stay as they
    were first stored) picks the same version for both on every side, whichever device syncs first. A tie leaves a pair per device, each
    consistent in itself.
  - *Healed*: a device of the version before the table (`SYNC_VERSION` 1) writes values but no rows. After a sync applied values
    (`SyncEngine`: `healAppliedLinks`; after a first connection for every value) `healLinks` rebuilds the row of each value whose row is
    missing or older than the value, with the value's stamp, and queues it, so it syncs out; the same rebuild is the same row on every device.
    `Repository.rebuildLinks` runs it over all values (and rewrites rows of the same stamp holding other targets, for a change in what
    counts as a link). Migration 2 builds the rows of the values already there and queues them.
- Reference fields (`item`, `item_list`) carry `fields.target_collection_id`, and optionally
  `fields.choice_filter` (JSON filter rules over the target, edited with the views' filter editor:
  `ui/ChoiceFilterEditor.tsx`): pickers offer only matching items (`choicesFor`); a value
  already chosen that no longer matches stays. Single references live
  in `value_ref`; lists (`string_list`, `item_list`) are JSON arrays in `value_json`, which means a
  list merges as one value during sync.
- Component and AI fields keep their own (local) component in `fields.code` / `output` / `frame_ratio`, else
  `component_id` names a shared one; blocks keep theirs in their options. AI fields (`fields.output`:
  `string` | `number` | `markdown`, also with a shared prompt) store their generated value in
  `value_text` (`value_number` for numbers) and, in `value_json`, the fingerprint (a JSON string) of the rendered
  prompt it answers (`domain/ai.ts`: JSON `{ "hash": …, "edited": true }`, `edited` when the user typed the value); `Repository.setGenerated` writes both without touching `items.updated_at`, `updateItem` stores a typed value as edited. The
  fingerprint syncs with the value.
- Items have no title field; their label (e.g. in reference pickers) is the first non-empty
  String field (`itemLabel`).
- A collection can't be deleted while another collection has a reference field pointing at it.
- Primary keys are client-generated UUIDs (no autoincrement), so replicas can create rows offline.
- Every row has `updated_at` (ISO 8601 UTC); `field_values` rows have their own, enabling
  field-level last-writer-wins merges. Updates only touch fields that actually changed.
- Deletes are soft (`deleted_at` tombstones) so they can replicate. Queries filter
  `deleted_at IS NULL`.
- A field's kind and reference target are immutable after creation (changing them would need
  value conversion).

## Known constraints / risks

- **Scale: native collections are meant for under ~10,000 items.** A collection's items are loaded into
  memory and filtered, sorted and grouped there (`applyQuery`); that is fast at this size, so
  there is deliberately no SQL-side querying of native data. Larger data (time series, logs) is
  meant for remote collections, whose blocks ask their source for each page of rows (filtered,
  sorted and grouped there: `useRemoteResult`, docs/sync.md "Remote sources") instead of
  `applyQuery`. Rendering is not
  virtualized: rows and cards are memoized only. Instead a block shows a native collection's items a Limit at a time (Filter → Limit, `ViewBlock.limit`, `blockLimit`: 100 unless set, a chart all; "Show more" adds as many again), not virtualization (which clashes with `FillTable` / `useSharedColumns`
  measuring every row); the other block types get every item.
- **Never install the SAH-pool VFS while another worker may hold its files.** If
  `installOpfsSAHPoolVfs()` fails to open a pool file, its error path calls `removeVfs()`, which
  deletes the pool directory, i.e. the database (this happened on reload-after-save). The worker
  therefore takes a Web Lock (`kubus-db`) for its lifetime and probes every pool file before
  installing (`acquireDbLock` / `poolFilesFree` / `waitForPoolFiles` in `dbLock.ts`, called by `worker.ts`). Keep both.

- **Typed columns map to Postgres** as `text`, `double precision`, `date`, `timestamptz`,
  `boolean`, `uuid`, `jsonb`; markdown is `text`, and images reference a files table.
- **Single connection per origin:** the SAH-pool VFS locks the DB, so a second browser tab can't open
  it (shows an error). Fine for Tauri/PWA; several tabs are roadmap #8.
- **Storage lives in the web view, not a visible file.** On desktop the DB is inside the WebView2
  profile (`%LOCALAPPDATA%\com.kubus.app\EBWebView`). Without sync there is no backup yet
  (export / import: roadmap #7). Changing the app identifier or `useHttpsScheme` changes the origin and orphans the data.
- **iOS eviction:** Safari can evict storage under pressure; home-screen apps are exempt from the
  7-day rule and we request `navigator.storage.persist()`. With sync on, the server is the backup.
- macOS/Linux Tauri builds use WKWebView/WebKitGTK; OPFS support there is not verified (roadmap #8).
