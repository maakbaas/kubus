# Kubus

Kubus (Dutch for "cube", after its icon; a working name) is a personal knowledge management app in the spirit of Obsidian, but backed by a
relational (CRUD/SQL) store instead of Markdown files: user-defined collections (Book, Person, …)
with typed fields, items, views made of blocks, components (`{{ }}` code over `$item`, `$items`, …),
spaces, bookmarks, and an optional Postgres sync server.

## Detailed docs (read the one you need before working in that area)

These are plain paths, not `@` imports on purpose: imports are inlined into every session, which
is what this split avoids. Keep them current when behaviour changes.

- `docs/features.md`: every feature in detail: field types, toggle icons, GFM-only Markdown editor,
  in-place item editing, collection icons and app icon, components, blocks, field order and item
  views, spaces, bookmarks, link schemes, global search, schema-change policy.
- `docs/views-and-workspace.md`: query (`applyQuery`, `KIND_RULES`), block types (table, cards,
  component, markdown), saved views; workspace tabs, tiling, side nav, tab history, tab width.
- `docs/data-model.md`: tables, EAV `field_values`, files, references, soft deletes, UUIDs;
  scale limits, SAH-pool VFS danger, storage location, iOS eviction.
- `docs/sync.md`: server, sync engine (outbox triggers, merge, first connection), files (upload,
  download, thumbnails, clean-up), the server's settings (Settings → AI and Connections), remote sources and their
  connectors, the HTTP API (headless device) and webhooks, iOS home-screen app, known sync limits.
- `docs/migrations.md`: schema changes: the device's and the server's migrations, sync between versions
  (`SYNC_VERSION` / `SYNC_COMPATIBLE`), the steps of a change.
- `docs/testing.md`: the test suites (vitest projects `domain`, `storage`, `sync`, `api`, `app`, `connectors`,
  `server`; the GUI suites), what each covers and needs (Postgres), what to run for a change, and CI.
- `docs/vision.md`: the "one hub" vision (native + remote sources, capabilities), the roadmap and
  every open item, numbered (other docs refer to them as "roadmap #n"; keep the list there only).

## Rules that always apply

- **Carbon only** (`@carbon/react`): Carbon components for every control, never native inputs or
  hand-rolled widgets; theme tokens (`var(--cds-…)`), no custom colors.
- **Markdown is strictly GFM**: Milkdown loads only CommonMark + GFM presets; no syntax plugins.
  The editor reports changes synchronously (`changes` plugin); don't use Milkdown's debounced
  listener plugin.
- **Local first, one codebase**: all logic and storage in the web frontend (SQLite WASM in a worker,
  OPFS). Every asset is bundled, nothing from a CDN (IBM Plex: `app/src/fonts.css`, Carbon's CDN
  `@font-face` rules are dropped in `vite.config.ts`): the app looks the same offline. Tauri is only a window (only plugin: `opener`); native capabilities go behind an interface
  in `app/src/platform/` with a web fallback.
- **Every schema change is a migration; no data is ever lost** (`docs/migrations.md`, read it first).
  `app/src/data/schema.sql` is the newest schema; with it goes the next migration in
  `app/src/data/migrations.ts` (from the first release's `schema-v1.sql`, never edited, nor are released
  migrations). A synced table/column also goes in `shared/sync.ts` with `SYNC_VERSION` raised (and
  `SYNC_COMPATIBLE` when older devices would get the new data wrong); the outbox triggers and the server's
  added tables/columns follow from it (`data/schema.ts`, `server/src/schema.ts`), anything else on the server
  is a migration in `server/src/migrations.ts`. Devices and servers of other versions keep syncing: never
  drop a column or value a side doesn't know.
- **Never install the SAH-pool VFS while another worker may hold its files** (it deletes the
  database): keep `acquireDbLock` / `poolFilesFree` in `worker.ts`.
- Changing the app identifier `com.kubus.app`, database / pool names, the lock or `kubus.*` storage
  keys orphans existing data.
- **Code lives only in components** (and filter values, whose `{{ }}` is worked out when the filter
  runs: `resolveFilterValues` in `domain/query.ts`): item values are data, never run. A component is shared (table
  `components`) or local (written in place, stored with its field or block; a Markdown block's text is
  a static one); there are no `$variables`, only the built-ins. A component is a field (`$item`),
  block (`$items`, `$groups`, `$fields`, `$all`) or static component (neither), never both
  (`componentUses`, `placeProblem` in `domain/components.ts`); with Value "AI prompt" (`ai`) it is the prompt of
  an AI field (kind `ai`: a Component field asking AI, its values stored).
- **The Help page text** (`app/src/help/components.md`) documents components and `{{ }}` code (`$` names, outputs, AI
  prompt) and is also what "Write with AI" gives the model: update it whenever that language changes.
- **The language model key stays where it is set**: a device's own on the device (`kubus.ai`, `app/src/app/ai.ts`),
  the server's in its own settings table (`server_settings`, set in Settings → AI, used only by its proxy
  `server/src/ai.ts`). Never sync a key, put it in the synced data or send the server's to a device; the same goes for
  a remote source's password (`server/src/settings.ts`: write-only, dropped when its address changes).
- Same words in code and UI (see Terminology); no "type", "object", "template", "entry".

## Terminology

| UI         | Code / DB                                   |
|------------|---------------------------------------------|
| Collection | `Collection` / `collections`                |
| Item       | `Item` / `items`                            |
| Field      | `FieldDef` / `fields`                       |
| View       | collection view: `CollectionView` / `views`; item view: `ItemView` / `collections.item_views` |
| Block      | `ViewBlock` (in a view's config, an item view's layout); its kind: "Show as" / `BlockTypeDefinition` |
| Layout     | `FieldLayout` (a block's fields), `ItemLayout` (the fields and blocks of an item view) |
| Component  | `Component` / `components`                  |
| Space      | `Space` / `spaces`                          |

A Collection defines fields and holds its items (Books); an Item is one of them (a particular
book). "View" is both how a collection's items are listed (collection view: its blocks) and how
one item's page looks (item view, whose layout is its fields and blocks); say "collection view" /
"item view" only where both could be meant. A Block shows items one way (table, cards, a
component) inside a view. A Component is rendering ({{ }} code over the built-in $ names), shared
(reusable, by name) or local (written in one place): a field, block or static component by the
built-ins it uses; with "AI prompt" its text is a prompt for an AI field.
A Space keeps items apart while sharing collections. A field's own kind is called "Field type" in the UI.

## Architecture

```
React UI (Carbon)  ──>  Repository interface  ──>  SqliteRepository  ──>  SQLite (WASM) in a Web Worker
app/src/pages, app/src/ui       app/src/data/repository.ts     app/src/data/sqlite/       persisted in OPFS (SAH-pool VFS)
```

Repo layout: `app/` the web app (what Tauri and the phone run), `desktop/` the Tauri shell,
`server/` the sync server (Node 24, dependencies `pg` and `@sqlite.org/sqlite-wasm`), `shared/` what
both import (`sync.ts` the sync protocol, `files.ts`, `router.ts`, `api.ts`), `app/src/headless` the
headless device that answers the server's HTTP API (bundled into `server/headless`).

- **Repository boundary.** The UI only talks to `Repository` (`app/src/data/repository.ts`).
- **Change feed.** After every committed write the repository emits a `DataChange` via
  `repo.subscribe`; anything that shows data refreshes through `useDataChanges`
  (`app/src/app/useDataChanges.ts`), not via whoever made the edit. Sync emits the same changes.
- **Writes are change sets**: each mutating repository method commits its statements in one
  transaction (`SqlClient.write`; `WorkerSqlClient` in the browser, `DirectSqlClient` in Node).
- **Items are loaded once and shared** (`app/src/app/itemCache.ts`, `useItems`). Unchanged items
  keep their identity, which memoized rows (`ItemRow` / `ItemCard`) and `withComputed` rely on:
  don't copy or rebuild items needlessly. Reference pickers use `Repository.listLabels`. Stable
  `ItemActions` delegate to the latest handlers; keep new actions delegating the same way.
- **Domain model** (`app/src/domain`) is storage-agnostic. `fieldKinds.ts` is the registry of field
  kinds; `ui/FieldInput.tsx` holds the matching editors.
- **Extension points are registries**, not special cases in pages: `KIND_RULES` in
  `domain/query.ts`, `BLOCK_TYPES` in `views/index.ts`.
- **The API goes through the headless device's Repository, never into Postgres.** `/api/v1`
  routes (`app/src/headless/api.ts`) are thin translations onto `Repository` methods; the server
  only stores rows and file bytes. Keep `app/src/help/api.md` (Help → API) current with them.
- **Remote collections are read-only** (`Collection.source`, `domain/sources.ts`): their blocks get rows from
  the source a page at a time (`useRemoteResult`: it filters, sorts and groups), never from the item cache, and
  whatever edits items checks `isRemote` (their `ItemActions` have no `remove` / `setValue`). App and server talk
  connector-neutral (`shared/sources.ts`); everything database-specific stays in `server/src/connectors/`.
- **Workspace**: every tab renders `AppRoutes` in its own `MemoryRouter`; in-app links are plain
  `href="#/…"` anchors; navigate with `useNavigate()` (this tab) or `useOpenRelated()`.

## Commands

`.npmrc` sets `legacy-peer-deps` because `@carbon/react` drags in a dev-only babel plugin with a
stale peer range.

- `npm run dev`: Tauri desktop app with hot reload (runs `dev:web` on port 1420).
- `npm run dev:web`: same app in a normal browser at http://localhost:1420.
- `npm run typecheck`, `npm run build:web` (to `app/dist`), `npm run build` (desktop bundle).
- `npm test`: every vitest project; `npm test -- --project sync` one part, `npm run test:changed` the tests reaching
  files changed since origin/main. The server's projects need `npm ci --prefix server` and Postgres
  (`KUBUS_TEST_POSTGRES`): `docs/testing.md`. Run the projects of what a change touches before pushing.
- `npm run build:headless`: the headless device for the server (`server/headless`, git-ignored); without it the
  server's `/api/v1` answers 503. Rebuild it after app changes when running the server locally.
- `npm run test:gui`: the GUI stress suite (CI runs only smoke tests; `gui-tests/README.md`): every page, size and content shape through
  `playwright-cli` against a development-mode build it makes and serves itself (`--dev`: the dev server), layout rules
  as pass/fail criteria, HTML report with screenshots in `gui-tests/report/`. `npm run test:gui:smoke`: its ~23-test smoke
  subset; `--changed`: the suites covering the files changed since origin/main (`gui-tests/areas.mjs`); `--repeat n`; `--perf`: the perf tests only (suite 23, each once; `perf-summary.json`, `--perf-compare`); screenshot baselines in `gui-tests/baselines/` (`--update-baselines` after a
  deliberate visual change).
- Server: `docker compose up -d` (change the passwords in `docker-compose.yml` first; it starts its own Postgres and pulls the image that `.github/workflows/image.yml` publishes to ghcr.io); or `cd server && npm install && npm run dev` with `DATABASE_URL` and `KUBUS_TOKEN` set.
- Browser automation (playwright-cli) runs in a subagent on the cheapest model (`model: "haiku"`).

## Conventions

- TypeScript strict, React function components, Carbon components and theme tokens
  (`var(--cds-…)`) instead of custom colors. Theme follows the OS (white / g100).
- **Compact UI: screen space goes to content.** Every Carbon component that comes in sizes uses
  its smallest (`size="sm"` for buttons, inputs, selects, dropdowns, search, accordion;
  `xs` for modals). The page header's breadcrumb is the exception: the normal size, body text. Tables use `sm` (2rem rows), not `xs`, because inline editors
  are small (2rem) inputs and must fit the row. Read-only field geometry is tuned to these 2rem
  inputs. Page padding is one `spacing-05`; page titles are heading-04.
- **Toolbar popover buttons** show their panel's state: grey (selected) only while open; a blue
  icon while its settings are in effect (a filter, a sort other than by title / grouping); Fields
  and settings menus are never marked.
- **Design rules** (the GUI suite's `gui-tests/lib/design.js` enforces them): spacing from Carbon's scale (`var(--cds-spacing-…)`,
  all declared at the root of `styles.css`), a page's parts on its breadcrumb's left edge, equal gaps between fields and
  between blocks, icon buttons touching (32px pitch), text in Carbon's type styles (weights 300/400/600), square corners,
  shadows only on floating layers, 1–2px borders, ellipsized text readable whole (a title or tooltip), 24px touch targets.
- **Nothing moves under the pointer while a panel or dialog is used** (the GUI suite checks it):
  what a change in a toolbar panel would add to the bar or header around its button (Save /
  Discard, a switch) is held with `usePanelsOpen().hold` until the panel closes; dialogs hang from a
  fixed top edge and grow downwards (styles.css), never re-centred.
- **Dialogs and focus**: a Modal rendered only while shown gets `open` from `useMountedDialog()`
  (Carbon moves focus into a dialog only when `open` turns true; it also gives focus back to the
  opener); Escape closes toolbar popovers from their button too, and an Escape on a closed Carbon
  dropdown is passed on to its dialog or popover (`escapeThroughDropdowns`, Carbon swallows it).
- **Popovers never make the page scroll**: toolbar popover panels are capped to the room beside their button (`--popover-room`, set by `ToolbarPopover`) and scroll inside; the icon picker is capped likewise.
  The room is what an on-screen keyboard leaves (the visual viewport: iOS doesn't resize the window for it), and while a
  field in the panel has focus the panel keeps its side of the button (`ui/panelRoom.ts`; suite `20-mobile-keyboard`).
- **Safari / iOS rules** (each has its reason in a comment in `styles.css`):
  - No `filter` on an ancestor of a floating panel; shadows around popovers are box-shadows
    (Safari 26 makes a filter a containing block for `position: fixed`; Floating UI doesn't know).
  - The top tab strip stays `position: sticky; top: 0` with a solid background, and nothing fixed
    sits above it: iOS takes the status bar colour from it (and blurs the bar otherwise).
  - No `apple-mobile-web-app-status-bar-style: black-translucent` (an unremovable fade on iOS 26.1+).
  - No `-webkit-overflow-scrolling: touch` (a stacking context on iOS: dialogs fell under the strip).
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
