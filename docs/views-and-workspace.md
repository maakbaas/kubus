# Views and workspace

How collection views, blocks, tabs and tiling work.

## Views (how a collection's items are listed)

Extension points are registries, not special cases in pages:

- **Query** (`app/src/domain/query.ts`): filters, sort, grouping as plain data (`ViewQuery`) plus a pure
  `applyQuery()`. Everything field-kind specific (filter operators, sort key, group keys, text for
  search) is in one `KIND_RULES` table: a new field kind or operator is added there. Pseudo fields
  `$title`, `$updated`, `$created` can be sorted on; the default query sorts by `$title`.
- **Block types** (`app/src/views/`): a `BlockTypeDefinition` (kind, label, icon, default options,
  `normalizeOptions` for stored configs, `uses` = which common menus apply (filter/sort,
  fields with labels / hide empty), the `View` component, optional `OptionsEditor` in
  the block's "Block settings" menu (gear icon), below "Show as") registered in `BLOCK_TYPES` (`app/src/views/index.ts`). What
  every type shares (filter, sort and group, fields) is the block's, never in options, so
  it carries over when the type is switched. Today: `table` (title column links to the item; string,
  number, date(time) and item cells edit in place via the shared `ui/FieldEditor` (the view’s "Fields are editable" in View settings, `ViewState.editable`, a view change like its filter; an item view’s own for blocks on item pages; it also gives the add row; checkboxes toggle either way, in every block type); the last row is empty but for a "+" in the title column, which turns it into an add row
  with inputs per editable column (text aligned with the column); header sorting; grouping = one table per
  group in a collapsible Carbon Accordion; columns as wide as their content on one line while
  there's room, the actions column widened by `FillTable` so the table spans the pane; an editing
  cell overlays its input on the invisibly kept value so the column never resizes; columns are
  selectable per view, the title column too (rows then get an open button); in a narrow pane
  every table restacks as cards, column names as row labels: `.table-wrap` container query) and `cards` (show title, fields, cover = an image or a markdown field rendered in its place, card width (slider: the column count whose width comes closest), cover shape:
  a fixed ratio (image shown whole, the rest filled with its average colour) or the images'
  average ratio (filled, cropped); with no title and no fields a card is just its cover) and
  `component` (`views/ComponentBlock.tsx`). `markdown` (`views/MarkdownBlock.tsx`) is a block with its own Markdown text, stored in the block's options (not a reusable component): plain GFM, no `{{ }}` code; it is shown and edited exactly like a Markdown field (same read-only box, `FieldEditor`); "Save as component" in its Block settings stores the text as a new static component (named like the block) and turns the block into a component block showing it: shared text, reusable across views, where code can be added. "Add block" is a menu (`views/AddBlockButton.tsx`): a block of each type and one per block or static component. A block type only
  renders a `QueryResult` (and the resolved fields); it never filters or sorts itself. Shared
  cell rendering: `views/cells.tsx`; data for blocks: `useCollectionData`, actions: `useItemActions`.
- **Saved views** (`app/src/domain/views.ts`, table `views`, per space): name + JSON config
  `{ filters, blocks }` (`views.kind` = the first block's; views stored before blocks, as
  `{ query, options }`, are read as one block by `parseViewConfig`).
  Every new collection gets an ordinary "All" view (table, all items, sorted by title) in the space it is made in, created
  with the collection in `saveCollection`; it can be renamed (view settings), edited, starred or deleted like
  any other; "+" adds one ("New", then "New 2", …) as a copy of what is shown, unsaved changes
  included (so it is also "save as new view"), and opens View settings with its name selected.
  "+" sits after the last tab. The tab bar's right end holds the view's tools after Discard /
  Save, delete, star and bookmark: Search (opens a search bar below the tabs; closes when emptied
  or with Escape on an empty box), Filter (the view's) and View settings (name, blocks);
  each block's own menus (Filter, Sort and group, Fields, Block settings: name, show as, type options) are in its header. The collection page opens the starred view (`views.is_default`, at most one per collection and space,
  set via `setDefaultView`), else the first; a space without stored views shows a virtual "All" table (id `default`; stored when
  changed, renamed or joined by another view), so a collection always has a view and the last can't be
  deleted. Changes are ephemeral: while the shown view differs from
  its saved version, a Save changes to view icon button stands left of the bar's buttons, never in
  the "⋮" menu ("+" saves them as a new view instead); there is no Discard: opening another view drops them. Search is never saved. A shown view without unsaved changes follows its stored settings when they change elsewhere (sync, another pane) instead of turning into "changed".

## Workspace (tabs and tiling)

- `app/src/workspace/layout.ts`: the layout as data (a tree of splits and panes; panes hold tabs, a tab
  holds a route path) with pure operations (open/close/move/split/resize, `restoreWorkspace`).
  `Workspace.tsx` renders it with Carbon tabs; drag a tab onto a pane's edge to split, onto its
  center or tab bar to move it; dividers resize. Layout is remembered per device (localStorage).
- Every tab renders `AppRoutes` (`app/src/app/routes.tsx`) in its own `MemoryRouter`. There is no
  global router: in-app links are plain `href="#/…"` anchors, intercepted per tab (click = this tab,
  Ctrl/Cmd/middle click = new tab); links in the side nav go to the active tab. Code that
  navigates uses `useNavigate()` (this tab) or `useOpenRelated()` (beside / new tab).
- Pages name their tab through `PageHeader` (its breadcrumb's current item).
- Opening a related item (item from a list/cards, referenced item) goes through
  `useOpenRelated(path, mode)` with `openModeOf(event)`: plain click = this tab; Ctrl/Cmd click =
  beside (the pane to the right, reused or split off; a new tab on windows < 72rem); middle click =
  new tab. Such links carry `data-own-click`.
- The side nav is a Carbon TreeView (`app/src/app/NavTree.tsx`): Bookmarks, Collections (with the
  shown space's collections below it) and Components; branches remember being open per
  device. The space switcher (`ui/SpaceSwitcher.tsx`, always shown) sits in the nav's top row beside the
  menu toggle; its last entry "Manage spaces" opens `#/spaces` (no nav entry).
- There is no header bar. The side nav toggle (filled/outlined panel icon) sits left of the space
  switcher while the nav is shown; while it is hidden it leads the top-left pane's tab strip,
  like "+" ends each strip (on phones: the active pane's). The side nav can be
  collapsed on desktop too (that toggle;
  remembered per device). Docked, it is resizable by dragging the gutter at its edge
  (`--nav-width`, 12–32rem, remembered per device).
- Each tab keeps its own history for its lifetime (outside navigation is pushed into it); mouse
  back/forward buttons, Alt+←/→, the browser-back key and, on touch screens, a swipe in from the
  left / right screen edge (the app's own touch listeners in `Workspace.tsx`) act on the active
  tab. The browser's own history isn't used for this (no iOS-specific history handling).
- Closing every tab leaves an empty workspace (no tab is reopened automatically); middle click
  on a tab closes it.
- Phones show only the active pane.
- **Tab width** (`fit` in `PaneView`, `Workspace.tsx`, plus `.ws-pane__tabs` in `styles.css`): a
  tab's natural width is its text plus padding and close button. Cap = min(16rem, 80% of the room
  for tabs), where the room is the `.cds--tabs` box minus the scroll buttons while they show
  (never the tab list's own width: it is only as wide as its tabs, so a lone tab would cap itself).
  When the tabs don't fit, the longest are cut (labels end in "…") to one width, as wide as still
  lets all fit, and shorter tabs keep their whole label until the cut reaches them (each width is set
  from `fit`; flexbox would shrink every tab in proportion). A tab keeps at least its close button and
  6rem of text, so short names ("Locations") are never cut; when even that doesn't fit the list scrolls
  (Carbon's buttons) and the active tab is centred. A label's width is its text's exact width rounded up
  (a Range: Safari rounds `scrollWidth` down, and a fraction short cut "Tasks" to "Ta…"). Recomputed on
  title / active-tab changes, strip resizes (`ResizeObserver`) and font loads (`loadingdone`).
