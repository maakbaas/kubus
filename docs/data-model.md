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
  `SqliteEngine` in `engine.ts`, which the server's headless device runs in memory), stored with the `opfs-sahpool` VFS (no COOP/COEP headers needed;
  Safari 16.4+). Without OPFS it falls back to an in-memory DB and the UI shows a warning.
- **Repository boundary.** The UI only talks to `Repository` (`app/src/data/repository.ts`). A
  sync-aware implementation slots in here later without touching the UI.
- **Change feed.** After every committed write the repository emits a `DataChange`
  (`spaces`, `collections`, `items` of a collection / item, `views` of a collection, `components`,
  `bookmarks`) via `repo.subscribe`. Anything that
  shows data refreshes through `useDataChanges` (app/src/app/useDataChanges.ts) rather than relying
  on whoever made the edit: item lists, item pages, reference labels, counts and the store's
  collections all do. A sync layer must emit the same changes for data arriving from the server.
- **Writes are change sets.** Each mutating repository method collects its statements and commits
  them in one transaction (`SqlClient.write`). This is the natural unit for a future sync outbox.
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
  from `shared/sync.ts`). The worker stores a hash of it in `PRAGMA user_version`; on mismatch every
  table is dropped and the schema created afresh (`ensureSchema` in `engine.ts`). No migrations or
  renames: pre-alpha, a schema change means a clean database (a synced device downloads again).

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
  fingerprint rides along in sync, so no new synced column was needed for it.
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
  virtualized: rows and cards are memoized only. If a 5,000-item collection feels slow, first try
  rendering rows in steps ("show more"), not virtualization (which clashes with `FillTable` /
  `useSharedColumns` measuring every row).
- **Never install the SAH-pool VFS while another worker may hold its files.** If
  `installOpfsSAHPoolVfs()` fails to open a pool file, its error path calls `removeVfs()`, which
  deletes the pool directory, i.e. the database (this happened on reload-after-save). The worker
  therefore takes a Web Lock (`kubus-db`) for its lifetime and probes every pool file before
  installing (`acquireDbLock` / `poolFilesFree` in `worker.ts`). Keep both.

- **Typed columns map to Postgres** as `text`, `double precision`, `date`, `timestamptz`,
  `boolean`, `uuid`, `jsonb`; markdown is `text`, and images reference a files table.
- **Single connection per origin:** the SAH-pool VFS locks the DB, so a second browser tab can't open
  it (shows an error). Fine for Tauri/PWA; for multi-tab web use, coordinate via a SharedWorker or
  Web Locks leader election later.
- **Storage lives in the web view, not a visible file.** On desktop the DB is inside the WebView2
  profile (`%LOCALAPPDATA%\com.kubus.app\EBWebView`). Export/import (sqlite file or JSON) is needed for
  backups. Changing the app identifier or `useHttpsScheme` changes the origin and orphans the data.
- **iOS eviction:** Safari can evict storage under pressure; home-screen apps are exempt from the
  7-day rule and we request `navigator.storage.persist()`. Once sync exists the server is the backup.
- macOS/Linux Tauri builds use WKWebView/WebKitGTK; OPFS support there is not yet verified.
