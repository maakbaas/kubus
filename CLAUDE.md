# Kubus

Kubus (Dutch for "cube", after its icon; a working name) is a personal knowledge management app in the spirit of Obsidian, but backed by a
relational (CRUD/SQL) store instead of Markdown files. Other names considered: Relata, Squirrel, Squill.

## Goals

- **User-defined schema.** Users create types (e.g. Book, Person, Meeting) with arbitrary
  fields, and CRUD both the types and their objects.
- **Field types:** String, Markdown, Number, Date, Date & time, Checkbox, Image, Object (reference
  to an object of another type, e.g. Book → Author), List of strings, Checklist (items with a
  checkbox, stored as GFM task lines "[x] text", `domain/checklist.ts`; tables show "2/5"),
  List of objects, Template (computed from a template).
- **Checkbox and Checklist fields can show an icon instead of the box** (`fields.toggle_icon`, a
  key of `TOGGLE_ICONS` in `ui/ToggleInput.tsx`: heart, star, flag, bookmark, checkmark, thumbs up,
  faces; outlined when off, filled when on; null = Carbon's checkbox). Every place that toggles
  such a value uses `ToggleInput`, never `Checkbox` directly. Markdown task boxes stay GFM boxes.
- **Markdown is strictly GitHub Flavored Markdown.** The Milkdown editor (`app/src/ui/MarkdownEditor.tsx`)
  loads only the CommonMark + GFM presets (plus non-syntax utilities: history, listener,
  clipboard, upload, prism). Don't add syntax plugins (math, emoji, diagrams, frontmatter, Crepe, …),
  and any future renderer must also be GFM-only. Behaviour-only additions are fine: clickable task
  checkboxes, typed `[text](url)` links, link hover popover (open/edit/remove), code coloring
  (refractor common languages), images via button/paste/drop stored as `files/<sha256>` URLs.
- **Types have a singular and plural name** ("Author" / "Authors"): singular for one object
  ("New Author"), plural for lists, navigation and counts (`countLabel`).
- **Objects are edited in place**: `#/types/<id>/objects/<objectId>` shows every field in the
  user's order; clicking a field turns it into its form input, with no buttons (they would push the
  content down). Enter saves (Ctrl/Cmd+Enter in markdown), clicking outside saves, Escape cancels;
  checkboxes save on toggle; markdown starts editing where it was clicked. View and edit mode must
  keep the same geometry (label spacing, box height, text position) so nothing jumps. The field
  that is the object's title (`labelField`) isn't repeated among the fields: the page title itself
  is its editor (click to edit in place). The full form
  (`…/objects/new`) is only for creating. Narrow screens show the objects list as cards.
- **Markdown editor has no toolbar**: formatting is typed, images pasted/dropped, links edited from
  their hover popover. Its height follows the content (no inner scrolling, no resize handle).
- **Type editor header is the editor** for the type's icon (button + popover picker) and name
  (heading-sized input).
- **Types have an icon** from the full Carbon set (`object_types.icon`, an `@carbon/icons-react`
  export name). The icon module is lazy-loaded (`app/src/ui/objectIcons.tsx`); the picker is a search
  box over a grid of matches. App icon: `app/public/favicon.svg` (Cube, white on #0f62fe),
  rendered to `desktop/icons` with `tauri icon`. Display name: Kubus (app identifier `com.kubus.app`; changing it, or the database / pool
  names, the lock or the `kubus.*` storage keys, orphans existing data).
- The Milkdown editor reports changes synchronously (`changes` plugin); don't switch back to the
  debounced listener plugin, which lost text typed right before saving.
- **Templates** (`#/templates`, `app/src/domain/templates.ts`, table `templates`, field kind
  `template`): Markdown with `{{ … }}` sections of JavaScript over `$variables` (stored as
  `params`), plus the built-ins `$now` / `$object` (the object itself, n8n style; details in the
  header of `templates.ts`). A Template field picks one (`fields.template_id`) and maps each
  variable to a field of its type or a fixed text/number (`fields.template_args`, `TemplateArg`),
  so one template serves any type. A template that is only `{{ … }}` yields that raw value
  (numbers sort as numbers); otherwise rendered Markdown (rendered on object pages, plain text in
  tables/cards). Results are computed whenever objects are shown (`withComputed`, before queries
  run) and never stored; failing sections show `⚠ message`. One concept on purpose: the same
  templates will later render whole objects and query results. The code runs in the app with the
  user's rights (`new Function`); it must move to a sandbox once templates can come from others
  (sync, sharing).
  - `{{ }}` sections also work inside an object's own string, markdown and number values
    (`withComputed` renders them when shown and keeps the typed source in `object.sources`, which
    editors use). A number field holding sections stores that text in `value_text`, so its input
    is a Carbon TextInput with a decimal keyboard (NumberInput takes no braces).
  - HTML output renders in a sandboxed frame that sizes itself, one template for every place
    (`HtmlFrame` in `ui/TemplateValue.tsx`, which documents flow/fill sizing, `frame_ratio`, the
    `<meta name="frame">` override and the zero-specificity base styles).
  - Templates see an image field as its src, `files/<sha256>`: Markdown and image outputs (and
    card covers) resolve it to the stored file; HTML frames get each file embedded as a data URL.
  - Fields can also be added from every field picker ("Add field": table columns, card fields,
    object page layout; `ui/FieldModal.tsx`, which also edits template fields). They are ordinary
    fields of the type, shown in the picker's own view; adding asks for confirmation (the field
    belongs to the type, not the view).
- **Field order and layouts** (`app/src/domain/fieldLayout.ts`, `ui/FieldOrderEditor.tsx`): one
  approach for which fields show in which order: table columns, card fields and object pages
  (`orderFields`; null = all in the type's order). Object pages show an object view
  (`object_types.object_views`, JSON: name + layout = editable, field names shown, fields + order):
  the one the object is pinned to (`objects.object_view_id`), else the starred one, else the first.
  Once a type has object views its object pages show them as tabs with "+", delete, pin (this
  object always opens with it) and star (default for all objects). The layout popover edits the
  shown view's layout as unsaved changes, saved like the objects page's views (Discard / Save
  changes beside the tabs; "+" makes a new view of what is shown, in the header while the tab
  bar is hidden). A type always has at least one object view:
  without stored ones it is a virtual "Default" (`withDefaultObjectView`, id `default`), stored once
  changed; the last view can't be deleted. Both tab bars (objects page, object pages) are hidden while
  there is one view without unsaved changes; a changed view's tab shows " *". When a layout hides
  fields or isn't editable, an edit icon switches to the standard page (all fields, editable)
  for the time being.
- **Bookmarks** (`app/src/domain/bookmarks.ts`, table `bookmarks`): a bookmark icon on a view (tab strip,
  next to the star) and on an object (page header, next to (i)) toggles a link in the side nav's
  Bookmarks branch. A view bookmark opens `…/objects?view=<id>`. Labels are snapshots, refreshed
  while the bookmarked page is shown; bookmarks of deleted views / objects aren't listed.
- **Global search** in the side nav (`/search?q=`): substring match over string, markdown and
  list-of-strings values (ASCII case-insensitive; an FTS index can come later).
- **Local first.** The app works fully offline on the device's own SQLite database.
- **Future:** the same templates render whole objects and query results (see Templates).
- **Sync.** The local SQLite is an offline-first replica of a Postgres-backed server (see "Sync with Postgres").
- **One codebase, many shells.** Desktop runs in Tauri; iOS (and anything else) runs the same web
  build as a home-screen web app (PWA). No native-only features in the core app.
- **Responsive UI** built strictly with the Carbon Design System (`@carbon/react`): use Carbon
  components for every control (DatePicker/TimePicker, NumberInput, ComboBox, …), never native
  inputs or hand-rolled widgets.
- **Pre-alpha, but data is kept where possible.** No migration scripts: when `app/src/data/schema.sql`
  changes, simple changes (new tables, indexes, nullable or defaulted columns; removed plain
  columns; changed CHECKs, e.g. a new field kind: the table is rebuilt with its rows) are applied
  in place and the data is kept; anything else (retyped columns, new NOT NULL columns without
  default) still wipes the local database. Prefer such
  simple schema changes.

## Vision: one hub for all data

Obsidian + Metabase + Directus in one: personal knowledge, live external data and its
visualisation, linked together. The sharp pitch: *Obsidian, where your notes can embed and link
live data.* The unique part is linking across sources (a meeting note referencing live CRM rows,
a project page showing a query over production data next to your own notes).

Rules that keep this from becoming three products glued together:

- **Everything is a source with capabilities.** Native Kubus types and remote data (external
  tables, SQL queries) are both "typed collections" behind one data-source interface. Each source
  declares what it supports, and the UI shows or hides features by those flags, never by source
  kind. Sketch:
  `{ edit, create, delete, editSchema, offline, serverQuery }`; the native source declares all.
- **Views and templates are source-agnostic.** Table, cards, future per-record / query templates
  and chart/dashboard view types render "objects of a type", wherever they come from. If remote
  data ever needs its own pages or its own query editor, the design has gone wrong.
- **Native vs remote:**

  | | Native Kubus | External / remote |
  |---|---|---|
  | Schema | user-defined | read from the source; only local labels / icons / column choices |
  | Editing | full | off by default; later only where a primary key allows it |
  | Offline | yes | no (maybe a read-only cached snapshot) |
  | Sync | yes | no, the source is its own truth |
  | Filter / sort / group | in memory (`applyQuery`) | pushed down to the server |
  | Links | both directions, backlinks | native → remote only |

- Links from native objects to remote rows store source + table + key **plus a label snapshot**,
  so they read sensibly offline or after the row is gone.
- Settings for remote collections (column choices, labels, icons, views) are stored natively and
  synced; the remote data itself is never copied unless explicitly imported.
- Import (copy a CSV / query result into a new native type) is the simple alternative to a live
  source and keeps the data editable and syncable.
- For SQL over the user's own data, generate a normal-looking SQL view per type (pivoting
  the EAV `field_values`), so queries and query templates don't have to deal with EAV.
- Remote sources make the server essential and change the security story: auth, secret storage
  for credentials, read-only database users by default.

Roadmap, in order: (1) native Kubus core: object links + backlinks, per-record and query templates;
(2) the server + sync; (3) remote sources, read-only (tables and SQL queries through the server,
same views/templates, links to remote rows); (4) editing remote data (Directus side), only where
the source allows it; (5) chart / dashboard view types (Metabase side), any time after (3).
Cheap step that can be done any time: introduce the capabilities type with the native source
declaring everything, and make the UI respect it.

## Terminology

| UI       | Code / DB                          |
|----------|------------------------------------|
| Type     | `ObjectType` / `object_types`      |
| Object   | `ObjectInstance` / `objects`       |
| Field    | `FieldDef` / `fields`              |

A Type defines fields (Book); an Object is one instance of it (a particular book). The UI never
says "entry"; a field's own kind is called "Field type" in the UI to keep "Type" for the schema.

## Architecture

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
  (`app/src/data/sqlite/worker.ts`), stored with the `opfs-sahpool` VFS (no COOP/COEP headers needed;
  Safari 16.4+). Without OPFS it falls back to an in-memory DB and the UI shows a warning.
- **Repository boundary.** The UI only talks to `Repository` (`app/src/data/repository.ts`). A
  sync-aware implementation slots in here later without touching the UI.
- **Change feed.** After every committed write the repository emits a `DataChange`
  (`types`, `objects` of a type / object, `views` of a type) via `repo.subscribe`. Anything that
  shows data refreshes through `useDataChanges` (app/src/app/useDataChanges.ts) rather than relying
  on whoever made the edit: object lists, object pages, reference labels, counts and the store's
  types all do. A sync layer must emit the same changes for data arriving from the server.
- **Writes are change sets.** Each mutating repository method collects its statements and commits
  them in one transaction (`SqlClient.write`). This is the natural unit for a future sync outbox.
- **Objects are loaded once and shared** (`app/src/app/objectCache.ts`, hook `useObjects`): while any
  pane shows a type, its objects live in one cache, kept current from the change feed (a changed
  object is re-read alone; a type whose fields changed is reloaded) and dropped 10 s after the
  last viewer leaves. Unchanged objects keep their identity, which memoized rows
  (`ObjectRow` / `ObjectCard`) and `withComputed`'s per-object memo rely on: don't copy or
  rebuild objects needlessly. Reference pickers and links need only labels: `useReferenceOptions`
  uses `Repository.listLabels` (ids + labels, no values) unless a field's choice filter needs the
  target's objects. Stable `ObjectActions` (delegating to the latest handlers) keep rows from
  re-rendering; keep new actions delegating the same way.
- **Domain model** (`app/src/domain`) is storage-agnostic. `fieldKinds.ts` is the registry of field
  kinds (DB column, codec, formatting); `ui/FieldInput.tsx` holds the matching editors.
- **Renames** of tables, columns or stored values go in `RENAMES` / `RENAMED_VALUES` in
  `worker.ts`: applied before the upgrade (with CHECKs ignored until the rebuild), so renaming
  keeps the data. (Expressions → templates was done this way.)
- **Schema** is one file, `app/src/data/schema.sql`. The worker stores a hash of it in
  `PRAGMA user_version`; on mismatch it builds the new schema in an in-memory database, compares,
  adds missing tables/columns/indexes and drops removed columns in place (`upgradeAdditively`
  in `worker.ts`). Only an incompatible change drops and recreates everything.

### Views (how a type's objects are listed)

Extension points are registries, not special cases in pages:

- **Query** (`app/src/domain/query.ts`): filters, sort, grouping as plain data (`ViewQuery`) plus a pure
  `applyQuery()`. Everything field-kind specific (filter operators, sort key, group keys, text for
  search) is in one `KIND_RULES` table: a new field kind or operator is added there. Pseudo fields
  `$title`, `$updated`, `$created` can be sorted on; the default query sorts by `$title`.
- **View types** (`app/src/views/`): a `ViewTypeDefinition` (kind, label, icon, default options,
  `normalizeOptions` for stored configs, the `View` component, optional `OptionsEditor`) registered
  in `VIEW_TYPES` (`app/src/views/index.ts`). Today: `table` (title column links to the object; string,
  number, date(time) and object cells edit in place via the shared `ui/FieldEditor`; the last row is empty but for a "+" in the title column, which turns it into an add row
  with inputs per editable column (text aligned with the column); header sorting; grouping = one table per
  group in a collapsible Carbon Accordion; columns as wide as their content on one line while
  there's room, the actions column widened by `FillTable` so the table spans the pane; an editing
  cell overlays its input on the invisibly kept value so the column never resizes; columns are
  selectable per view, the title column too (rows then get an open button); in a narrow pane
  every table restacks as cards, column names as row labels: `.table-wrap` container query) and `cards` (show title, fields, cover = an image or a markdown field rendered in its place, card width (slider: the column count whose width comes closest), cover shape:
  a fixed ratio (image shown whole, the rest filled with its average colour) or the images'
  average ratio (filled, cropped); with no title and no fields a card is just its cover). A view type only
  renders a `QueryResult`; it never filters or sorts itself. Shared cell rendering: `views/cells.tsx`.
- **Saved views** (`app/src/domain/views.ts`, table `views`): name + kind + JSON config `{ query, options }`.
  Every new type gets an ordinary "All" view (table, all objects, sorted by title), created
  with the type in `saveType`; it can be renamed (view settings), edited, starred or deleted like
  any other; "+" adds one ("New", then "New 2", …) as a copy of what is shown, unsaved changes
  included (so it is also "save as new view"), and opens View settings with its name selected.
  "+" sits after the last tab, or in the toolbar while the tab bar is hidden. The
  toolbar has three icon buttons with popovers: Filter, Sort and group, View settings (name, view
  type, its options, delete). The objects page opens the starred view (`views.is_default`, at most one per type,
  set via `setDefaultView`), else the first; with no views left it shows an unsaved table that can
  be saved. Changes are ephemeral: while the shown view differs from
  its saved version, icon buttons beside the star offer Discard changes and Save changes to view
  ("+" saves them as a new view instead). Search is never saved.

### Workspace (tabs and tiling)

- `app/src/workspace/layout.ts`: the layout as data (a tree of splits and panes; panes hold tabs, a tab
  holds a route path) with pure operations (open/close/move/split/resize, `restoreWorkspace`).
  `Workspace.tsx` renders it with Carbon tabs; drag a tab onto a pane's edge to split, onto its
  center or tab bar to move it; dividers resize. Layout is remembered per device (localStorage).
- Every tab renders `AppRoutes` (`app/src/app/routes.tsx`) in its own `MemoryRouter`. There is no
  global router: in-app links are plain `href="#/…"` anchors, intercepted per tab (click = this tab,
  Ctrl/Cmd/middle click = new tab); links in the side nav go to the active tab. Code that
  navigates uses `useNavigate()` (this tab) or `useOpenRelated()` (beside / new tab).
- Pages name their tab through `PageHeader` (its breadcrumb's current item).
- Opening a related item (object from a list/cards, referenced object) goes through
  `useOpenRelated(path, mode)` with `openModeOf(event)`: plain click = this tab; Ctrl/Cmd click =
  beside (the pane to the right, reused or split off; a new tab on windows < 72rem); middle click =
  new tab. Such links carry `data-own-click`.
- The side nav is a Carbon TreeView (`app/src/app/NavTree.tsx`): Bookmarks, Types (with every
  type below it) and Templates; branches remember being open per device.
- There is no header bar. The side nav toggle (filled/outlined panel icon) sits left of the side
  nav's search while the nav is shown; while it is hidden it leads the top-left pane's tab strip,
  like "+" ends each strip (on phones: the active pane's). The side nav can be
  collapsed on desktop too (that toggle;
  remembered per device). Docked, it is resizable by dragging the gutter at its edge
  (`--nav-width`, 12–32rem, remembered per device).
- Each tab keeps its own history for its lifetime (outside navigation is pushed into it); mouse
  back/forward buttons, Alt+←/→ and the browser-back key act on the active tab.
- Closing every tab leaves an empty workspace (no tab is reopened automatically); middle click
  on a tab closes it.
- Phones show only the active pane.

### Data model (sync-ready conventions)

- Tables: `object_types`, `fields`, `objects`, `field_values` (EAV with typed columns
  `value_text | value_number | value_date | value_datetime | value_bool | value_ref | value_json`),
  `meta` (holds `replica_id`).
- Images live in `files` (content-addressed: id = SHA-256, immutable, BLOB in SQLite) and are
  referenced from `field_values.value_file` or from markdown as `files/<sha256>`. Files are stored as soon as they're picked and
  released (`releaseFile` in `SqliteRepository.ts`) in the same transaction as any write that drops
  a reference (changed/removed image, deleted object/field); the object editor releases
  unsaved uploads when it closes. A file is only deleted when no live object uses it. For sync,
  files should move to object storage (or `bytea`) and transfer separately from the row data.
- Reference fields (`object`, `object_list`) carry `fields.target_type_id`, and optionally
  `fields.choice_filter` (JSON filter rules over the target, edited with the views' filter editor:
  `ui/ChoiceFilterEditor.tsx`): pickers offer only matching objects (`choicesFor`); a value
  already chosen that no longer matches stays. Single references live
  in `value_ref`; lists (`string_list`, `object_list`) are JSON arrays in `value_json`, which means a
  list merges as one value during sync.
- Objects have no title field; their label (e.g. in reference pickers) is the first non-empty
  String field (`objectLabel`).
- A type can't be deleted while another type has a reference field pointing at it.
- Primary keys are client-generated UUIDs (no autoincrement), so replicas can create rows offline.
- Every row has `updated_at` (ISO 8601 UTC); `field_values` rows have their own, enabling
  field-level last-writer-wins merges. Updates only touch fields that actually changed.
- Deletes are soft (`deleted_at` tombstones) so they can replicate. Queries filter
  `deleted_at IS NULL`.
- A field's kind and reference target are immutable after creation (changing them would need
  value conversion).

### Sync with Postgres (the server and the sync engine)

Repo layout: `app/` the web app (what Tauri and the phone run), `desktop/` the Tauri shell,
`server/` the sync server (Node 24, runs its TypeScript directly, only dependency `pg`),
`shared/sync.ts` the protocol both sides import (the list of synced tables / columns / types and
the request shapes).

**Topology.** `app ──HTTPS──> server ──> Postgres` (an already running one, `DATABASE_URL`). The
client never talks to Postgres: browsers and the iOS PWA can only do HTTP. One container
(`server/Dockerfile`, `docker-compose.yml` with `DATABASE_URL` and `KUBUS_TOKEN`) serves the
sync API at `/api` and the built web app at `/`, so the phone installs the app from the server
(same origin, no CORS). Auth is one shared bearer token (`KUBUS_TOKEN`); the app's Sync page
(`#/sync`, `pages/SyncPage.tsx`) holds server URL + token + on/off, per device (localStorage
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
  Sync page asks for confirmation first, `isNewServer`). Only an empty server takes the device's data
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

**iOS / home-screen app.** The same web build: `app/public/manifest.webmanifest`, apple-touch-icon and
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

### Known constraints / risks

- **Scale: native types are meant for under ~10,000 objects.** A type's objects are loaded into
  memory and filtered, sorted and grouped there (`applyQuery`); that is fast at this size, so
  there is deliberately no SQL-side querying of native data. Larger data (time series, logs) is
  meant for remote tables (roadmap step 3), where the query is pushed down to the server
  (`serverQuery`); only then does a query engine beyond `applyQuery` pay off. Rendering is not
  virtualized: rows and cards are memoized only. If a 5,000-object type feels slow, first try
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
- **Offline web:** a service worker (not yet added) must cache the app shell so the PWA launches
  without network.
- macOS/Linux Tauri builds use WKWebView/WebKitGTK; OPFS support there is not yet verified.

## Commands

`.npmrc` sets `legacy-peer-deps` because `@carbon/react` drags in a dev-only babel plugin with a
stale peer range.


- `npm run dev`: Tauri desktop app with hot reload (runs `dev:web` on port 1420).
- `npm run dev:web`: same app in a normal browser at http://localhost:1420.
- `npm run typecheck`, `npm test`, `npm run build:web` (to `app/dist`), `npm run build` (desktop bundle).
- Server: `docker compose up -d` (fill in the placeholders in `docker-compose.yml` first; it pulls the image that `.github/workflows/image.yml` publishes to ghcr.io); or `cd server && npm install && npm run dev` with `DATABASE_URL` and `KUBUS_TOKEN` set.

## Conventions

- TypeScript strict, React function components, Carbon components and theme tokens
  (`var(--cds-…)`) instead of custom colors. Theme follows the OS (white / g100).
- **Compact UI: screen space goes to content.** Every Carbon component that comes in sizes uses
  its smallest (`size="sm"` for buttons, inputs, selects, dropdowns, search, accordion,
  breadcrumb; `xs` for modals). Tables use `sm` (2rem rows), not `xs`, because inline editors
  are small (2rem) inputs and must fit the row. Read-only field geometry is tuned to these 2rem
  inputs. Page padding is one `spacing-05`; page titles are heading-04.
- **Popovers, tooltips and dropdown menus use `autoAlign`** (Carbon's floating placement): they
  flip to the side with room and aren't clipped by pane edges. Add it to every new `Popover`,
  `IconButton`, `Dropdown`, `ComboBox`, `FilterableMultiSelect`.
- Buttons with a text label are never borderless: use `primary`, `secondary`, `tertiary` or
  `danger--tertiary`, not `ghost`/`danger--ghost`. Ghost is only for icon-only buttons (toolbars,
  table row actions).
- No spell-check underlines anywhere: `spellcheck="false"` on `<html>` (inherited by all inputs) and
  on the Milkdown content element. Don't re-enable it per input.
- In-app links are `#/…` hrefs (see Workspace); the static build works from any host and inside Tauri.
- SQL uses numbered parameters (`?1, ?2`).
