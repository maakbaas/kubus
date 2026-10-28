# Views and workspace

How collection views, blocks, tabs and tiling work.

## Views (how a collection's items are listed)

Extension points are registries, not special cases in pages:

- **Query** (`app/src/domain/query.ts`): filters, sort, grouping as plain data (`ViewQuery`) plus a pure
  `applyQuery()`. Everything field-kind specific (filter operators, sort key, group keys, text for
  search) is in one `KIND_RULES` table: a new field kind or operator is added there. Pseudo fields
  `$title`, `$updated`, `$created` can be sorted on; the default query sorts by `$title`.
  A filter value may hold `{{ }}` code, typed and shown as raw text (the one place besides
  components where code runs): `resolveFilterValues` / `filterCodeValue` work it out when the filter
  runs, as if its result had been typed (`{{ 1 == 1 }}` is "true"), reading `$now` and, on an item
  page, the page's item as `$item`. A value that can't be compared (failing code, "maybe" for a
  checkbox, text for a number; `filterValueProblem`) is shown as invalid at its input and matches
  nothing, never the wrong items. The value input is text for every kind (the braces must be typable);
  under it, what the code works out to ("= true").
- **And / Or** (`app/src/domain/filterTree.ts`): each rule says how it joins what comes before it
  (`FilterRule.join`: absent = And, narrowing; "or" lets more items in), read in order without precedence
  (`A or B and C` = `(A or B) and C`); the first rule of a filter building on nothing shows "Where". A
  block always builds on its view's filter (on an item page, the page-wide one): its rules come after it
  (`ViewQuery.inherited`, `blockQuery`), so its And rules tighten the view's filter and its Or rules make
  exceptions to it; a block's Filter button is blue while it has rules of its own. A filter's date period
  frames that filter (and-ed with its other rules and what it builds on), so a block's Or can step outside
  the view's period but not its own. A rule without its value yet, or on a missing field, takes no part
  (`waitsForValue`), so a half-written Or never lets everything through. The result is one condition tree
  (`filterTree`), checked locally (`filterOf`) and sent as is to remote sources (`sourceQuery`,
  `SourceCondition`), so every connector filters the same way; a new item is preset only from rules every
  listed item meets (`requiredRules`).
- **Date period** (`app/src/domain/datePeriod.ts`, `views/DatePeriodFilter.tsx`): the top of every
  filter panel. A content switcher (Day, Week, Month, Year, Range) sets the current day / week
  (Sunday to Saturday, like the date pickers' calendars; week 1 holds 1 January) / month / year in
  one click; ‹ › step to the one before / after (a range by its length), the calendar button back
  to the current one, × clears it; Range shows two date inputs. The year dropdown runs from a century back to the current year, never into the future (the year shown stays if outside). It goes by the first date or date &
  time field (none: Updated), or one picked beside the switcher (Created and Updated included). It
  is stored as the filter's first `between` rule, which the rule list leaves out (a date & time by
  its local day). The current day, week, month or year is stored counted from today (`week+0`,
  `month+0`: `resolveRange` works it out when the filter runs), so a saved "this week" stays this
  week and the panel says "This week · …"; so is a range ending today, as days from today
  (`day-6..day+0`, "Last 7 days · …", `rangeOrRolling`); any other period is stored as its days
  (`yyyy-mm-dd..yyyy-mm-dd`, both included; what they are, a week, a month, …, follows from them).
  The current period can't be kept as fixed days, by design. `between` isn't in the operator menus
  (`operatorsFor`), but the API can set it.
- **Page-wide filter** (item pages): with more than one block listing items (`uses.query`), the page toolbar gets "Filter all blocks", the collection views' filter panel (`QueryEditor`, date period included) over the fields of all those collections (`pageFilterScope`; a name several share gets its collection behind it; remote collections included: a remote block hands the rules to its source like its own filter, `sourceQuery`, connector-neutral, so a block of a remote table can show this month's rows). It is `ItemLayout.filters`, unsaved until Save changes like a block's filter. Like a view's filter, each block builds on it (And / Or above): a block takes the rules on its collection's fields and, if native, the pseudo fields (`pageFiltersFor`) and ignores the rest. With one block, or none, it doesn't apply.
- **Block types** (`app/src/views/`): a `BlockTypeDefinition` (kind, label, icon, default options,
  `normalizeOptions` for stored configs, `uses` = which common menus apply (filter/sort,
  fields with labels / hide empty), the `View` component, optional `OptionsEditor` in
  the block's "Block settings" menu (gear icon), below "Show as") registered in `BLOCK_TYPES` (`app/src/views/index.ts`). What
  every type shares (filter, sort and group, fields) is the block's, never in options, so
  it carries over when the type is switched. The types: `table` (title column links to the item; string,
  number, date(time) and item cells edit in place via the shared `ui/FieldEditor` (the view’s "Fields are editable" in View settings, `ViewState.editable`, a view change like its filter; an item view’s own for blocks on item pages; it also gives the add row; checkboxes toggle either way, in every block type); the last row is empty but for a "+" in the title column, which turns it into an add row
  with inputs per editable column (text aligned with the column); header sorting; grouping = one table per
  group in a collapsible Carbon Accordion; columns as wide as their content on one line while
  there's room, the actions column widened by `FillTable` so the table spans the pane; an editing
  cell overlays its input on the invisibly kept value so the column never resizes; columns are
  selectable per view, the title column too (rows then get an open button); a table looks the
  same at every width: one too wide for its pane (a phone, a narrow tiled pane) scrolls sideways,
  its first column staying put (sticky, unless it is half the table or more), a fade at an edge with more beyond it; `FillTable`, also the
  tables of the app's own pages) and `cards` (show title, fields, cover = an image or a markdown field rendered in its place, card width (slider: the column count whose width comes closest), cover shape:
  a fixed ratio (image shown whole, the rest filled with its average colour) or the images'
  average ratio (filled, cropped); with no title and no fields a card is just its cover; a card looks
  the same at every width (labels beside values, a label wrapping when the card is very narrow);
  "Cover beside the text" puts the cover at the card's left instead of on top, at every width (a
  list row where one card fills the row)),
  `component` (`views/ComponentBlock.tsx`),
  `map` (`views/MapView.tsx`: the items as dots on a vector map, MapLibre GL with OpenFreeMap's styles and tiles, the
  one thing the app loads from elsewhere; MapLibre is loaded on demand, `views/mapLibre.ts`, its worker bundled. An
  item's place is read from its fields, `domain/geo.ts`: Location is a text field or a component giving text with both
  coordinates, "52.37, 4.89", "geo:52.37,4.89" or a map link with "@lat,lon" / "q=lat,lon", or a number field
  with the latitude, then Longitude a second number field; a first guess by field name. The block's grouping colours
  the dots, Carbon's categorical palette for the theme, with a legend and how many items have no place; ungrouped
  they are `--cds-interactive`. Hovering a dot shows a Carbon popover with the item's title and the block's fields,
  clicking it opens the item (`openModeOf`); on touch screens the first tap shows it and its title opens it. The
  map fits the dots when which items are shown changes, not when one is edited. Zoom buttons are Carbon icon
  buttons; the wheel scrolls the page, Ctrl/Cmd + wheel zooms (cooperative gestures). Block settings: Location,
  Longitude, Map style (automatic: light / dark like the app; Liberty, Bright) and Height),
  and
  `chart` (`views/ChartBlock.tsx`: settings and view; `domain/chart.ts`: the values, pure; `views/chartSpec.ts`: Carbon
  Charts' component, data and options for them; `views/ChartCanvas.tsx`: Carbon Charts itself, a lazily loaded chunk with
  d3, so the app doesn't load it until a chart is shown). Like a table, its filter picks the items and its grouping (Sort
  and group) makes the categories: grouped by Status it is a bar per status, with nothing to set; not grouped, one
  category of all its items. A date's groups are merged into steps (Date steps: day, week (Sunday to Saturday), month,
  year, or automatic by how far the dates spread); a line gets every step from the first to the last, in time order.
  Its settings (`ChartOptions`, all in Block settings): Chart (13 types in sections: Compare: Bar, Radar, Bullet; Over
  time: Line; Parts of a whole: Pie, Treemap, Word cloud; Spread: Histogram, Box plot, Scatter, Heatmap; One value:
  Gauge, Meter), Value (Count of items, or the Sum / Average / Minimum / Maximum of a number field: number fields and
  AI or component fields giving numbers, `numberFields`), Split by (a second field: series, at most 12, the rest
  "Other"), Show (the largest n categories, the rest "Other"), Show items without a value ("No value"), Height, Width (a slider like the cards', 8 to 120rem (about 1920px) at most; saved as Full / Small / Medium / Large it reads as 120 / 24 / 40 / 64rem; a
  gauge as wide as a pane is mostly empty, so switching to one makes a full-width chart 24rem), and
  per type: Bar horizontal, stacked, lollipops, a second value drawn as a line on its own axis (Carbon's combo chart;
  also for Line); Line fill the area (stacked areas when split, optionally as shares of 100%), running total, compact
  (a sparkline: no axes, legend or grid); Pie donut (the total in its centre); Radar its spokes (three or more number
  fields; a count is averaged); Histogram its field and bins; Box plot its field (a box per group); Scatter X (a
  number or date), Y and Size (bubbles), a dot per item, clicking one opens it; Heatmap categories × Split by, or,
  grouped by a date and not split, a calendar (weeks × weekdays; empty cells left undrawn); Gauge, Meter and Bullet
  measure against a number, a field (its values made into one the same way: on a block of one item, that item's
  own, "Pages read of Pages") or nothing (the value is a %), Gauge and Meter turn yellow / red from a warning and
  danger share, Meter can show the groups as parts of a whole, Bullet a bar per group against its target. A setting
  still to choose (a field, three spokes) or nothing to chart says so instead of an empty chart. The chart follows
  the theme (`white` / `g100`); Carbon's toolbar is off. A remote collection's chart loads all its rows for the active filters (`useRemoteResult` with `uses.all`: pages of 500 one after the other, a progress bar and Cancel under it: the bar is how far the last row's place in the order (group, first sort column, else key; numbers, dates, or text by its first letters) lies between the first row's and the opposite order's first row, asked once, never the source's count; after Cancel the chart shows the rows in and "Load all rows" goes on). 
  `markdown` (`views/MarkdownBlock.tsx`) is a block with its own Markdown text, stored in the block's options: a local static component (GFM whose `{{ }}` sections may use `$now`, nothing about items); it is shown (rendered) and edited (as written) exactly like a Markdown field (same read-only box, `FieldEditor`); "Save as shared component" in its Block settings stores the text as a new shared static component (named like the block) and turns the block into a component block showing it. A component block shows a shared component (`options.componentId`), picked in its Block settings, which also have "Edit component" (its page) and "New component" (named in a dialog, picked, and opened beside the page to be written, `NewBlockComponentModal`): a block's code is never written in a popover. Its own component (`options.local`) was written in Block settings by earlier versions and still shows; its settings then offer only "Save as shared component". "Add block" is a menu (`views/AddBlockButton.tsx`): a block of each type ("New component…" for a component block, as above) and one per shared block or static component. A block type only
  renders a `QueryResult` (and the resolved fields); it never filters or sorts itself. Shared
  cell rendering: `views/cells.tsx`; data for blocks: `useCollectionData`, actions: `useItemActions`.
- **Saved views** (`app/src/domain/views.ts`, table `views`, per space): name + JSON config
  `{ filters, blocks, editable, collapsed }` (`parseViewConfig`).
  Every new collection gets an ordinary "All" view (table, all items, sorted by title) in the space it is made in, created
  with the collection in `saveCollection`; it can be renamed (view settings), edited, starred or deleted like
  any other; "+" adds one ("New", then "New 2", …) as a copy of what is shown, unsaved changes
  included (so it is also "save as new view"), and opens View settings with its name selected.
  "+" sits after the last tab. The tab bar's right end holds the view's tools after Discard /
  Save, delete, star and bookmark: Search (opens a search bar below the tabs; closes when emptied
  or with Escape on an empty box; while it has text, a block listing items with none matching is
  left out, `BlockView`), Filter (the view's) and View settings (name, blocks);
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
  shown space's collections below it), Remotes (its remote collections, while it has any; a branch
  without a page) and Components; branches remember being open per
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
