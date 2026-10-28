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
  nothing, never the wrong items (so does a value from the page's item that it doesn't have: "Author is this Book's Mentor" on a Book without one). The value input is text for every kind (the braces must be typable);
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
  filter panel (no heading above it: the panel's button says "Filter"). A content switcher (Hour, Day, Week, Month,
  Year, Range) picks the kind; the line under it shows the period ("Any date" while there is none), a blue "Rolling"
  tag while it moves on with time, "by <field>" (the first date or date & time field, none: Updated; Created and
  Updated can be picked) and, once a period is set, ‹ › (the one before / after: a rolling one stays rolling, `week-1`
  "Last week"; a chosen one by its length), the calendar button (the current one) and × (any date). "Which" says which
  one of its kind: counted from now (`hour+0`, `week+0`, `month-1`: `resolveRange` works it out when the filter runs,
  so a saved "this week" stays this week), so far for a week, month or year (`year+0..day+0`, "Year to date"), the last
  n up to now with n beside it (`day-6..day+0` the last 7 days, `hour-23..hour+0`, `month-11..month+0` the last 12
  months, this one included; an hour also offers the last n minutes, `minute-29..minute+0`), or a chosen one (its days
  fixed, `yyyy-mm-dd..yyyy-mm-dd`, both included: its day, hour (00:00 … 23:00), a day of its week, month or year beside
  it; the years run from a century back to now). Range is two chosen days. Switching kind keeps the Which (a chosen
  month becomes the chosen week of its first day; the last n starts at the kind's own n: 24 hours, 7 days, 4 weeks, 12
  months, 3 years). It is stored as the filter's first `between` rule, which the rule list leaves out (a date & time by
  its local day; in an hour or a range of minutes by its local minute, `yyyy-mm-ddTHH:MM..yyyy-mm-ddTHH:MM` with an
  hour `…T14:00..…T14:59`, a date there by its day). On an item page a rolling period can be counted from the page's
  item's date instead ("Counted from": Today or "This measurement's Date"; stored as the value then
  `@$item.<field>`, `anchoredValue` in domain/datePeriod.ts, worked out for each page's item by `resolvePageValues`;
  elsewhere, or for an item without that date, it matches nothing). `between` isn't in the operator menus
  (`operatorsFor`), but the API can set it.
- **Limit** (a block's Filter panel, beside Add filter: "Show [100] items at a time"; `ViewBlock.limit`, saved with the
  view): how many items it shows at first and each "Show more" adds; empty is all. Unset it is 100, or all for a block
  that needs every item (a chart: `BlockUses.all`; `blockLimit`). A remote collection is asked that many rows a page
  (all: every page, one after the other). The Filter button is blue while a Limit is set.
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
  all its columns together (none is pinned), a fade at an edge with more beyond it; while the pane scrolls down its
  header row stays in view a margin below the pane's top (`--table-head-gap`, covered by the page's background once
  it moved) until the table's end (moved down, as sticky can't reach past the
  sideways scroller: by a CSS scroll-driven animation in step with the scroll where the browser has them, Chrome and
  Safari 26, `data-head-follow`; else by `FillTable` on each scroll, a frame behind); `FillTable`, also the
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
  the dots as a chart colours its series: Carbon Charts' palette for that many groups (1 to 5, else 14; its own
  `--cds-charts-…` tokens for the theme, its stylesheet loaded with MapLibre: `chartPalette`), with a legend and how
  many items have no place; ungrouped they are a one-series chart's colour. Dots and route lines are drawn as a
  lollipop chart's: a 4px dot in its colour at 30% with a 1.5px outline, filled when hovered, on a disc of the
  page's background (a line stops at its edge); 1px lines. Hovering a dot shows (unless the block's Fields chooses none: then no tooltip, and a tap opens
  the item at once) Carbon Charts' own tooltip, as a chart's: the item's title (bold, a
  link, with its dot's colour bar) and a row per field of the block (name and value as text, `fieldText`), at most
  270px wide, rows ellipsized; beside the dot (right, else left), past the map's box but inside the pane; the pointer can move onto it (it hides `HIDE_DELAY` after leaving
  both); clicking a dot opens the item (`openModeOf`); on touch screens the first tap shows it and its title opens it. The
  map fits the dots when which items are shown changes, not when one is edited. Zoom buttons are Carbon icon
  buttons, and "Show all" only with more than one place; the wheel zooms and one finger moves the map (no
  cooperative gestures), and there is no attribution box. Route joins the dots in the block's order with a line, one
  per group in its colour (`routeJson`). The style is one for all maps (Settings → Maps, `app/mapStyle.ts`, docs/sync.md:
  the server's settings). Block settings: Location, Longitude, Route and Height (see below)),
  and
  `chart` (`views/ChartBlock.tsx`: settings and view; `domain/chart.ts`: the values, pure; `views/chartSpec.ts`: Carbon
  Charts' component, data and options for them; `views/ChartCanvas.tsx`: Carbon Charts itself, a lazily loaded chunk with
  d3, so the app doesn't load it until a chart is shown). The block's filter and sort pick its items; everything else is the
  chart's own (`ChartOptions`, all in Block settings, stored right away), so its grouping (Sort and group) isn't used. The
  settings are a Chart select (13 types in sections: Compare and over time: Bar, Line, Area, Radar; Parts of a whole: Pie,
  Meter, Treemap, Word cloud; One value: Gauge, Stat; Spread: Histogram, Box plot, Scatter, Heatmap) and an accordion whose
  sections are fixed per type (Data, Series, Value, Total, Display, Axes, Thresholds, Values and legend, Size), all closed
  when the settings open; a setting
  that doesn't apply because of another one is disabled with the reason under it, never hidden, and a setting depends only
  on those above it. Switching type keeps every setting (`switchKind`: a gauge narrows a full-width chart, a scatter
  places each item, a radar or parts from fields with none chosen take the series' fields). Series, and the
  number fields of parts or spokes (listed under their multi-select, in the order drawn), are reordered like other lists (`ui/useReorder.tsx`: drag a row's handle, or arrow keys on it; Delete removes the selected).
  - **Of** (on an item page, for a block of the page's own collection): these items, or this item alone (`scope: "page"`,
    `chartItems`: then the block has no filter), e.g. a pie of this person's fat, muscle and bone mass.
  - **X axis** (`ChartX`): nothing (one category of all items), a field's values (any field grouping could use: its
    groups by value either way or the largest first; a date's merged into steps: minute and hour (of a date & time, local),
    day, week (Sunday to Saturday), month, year, or automatic by how far the dates spread (a date & time within three
    hours in minutes, within three days in hours: `autoTimeStep`); a line or area gets every step from the first to the
    last; "No value" when asked ("Show items without a value", only offered where it does something: not for a line of
    dates, where it has no place, unless the chart is split, whose "No value" series it also adds); the largest n, the rest "Other"), or each item, at its value of a date or number field (a point per
    measurement, on a time or number axis) or without one by its title in the block's order. A radar's shapes, a box
    plot's boxes, a heatmap's columns and parts from categories are the X axis too.
  - **Series** (bar, line, area): any number (`ChartSeries`), each a count or the sum / average / minimum / maximum / first
    / last value of a number field (number fields and AI or component fields giving numbers, `numberFields`), with a
    label, drawn as bars, lollipops, a line, an area or dots (the chart's own style, the type's: Bar bars, …, is stored as
    none, so it follows the type), on the left or right axis, and
    shown as its values, a running total, the change from the step before or a moving average (`transformValues`). Split
    by (a field) splits every series ("Pages · Novel" with several; at most 12, the rest "Other"). One style on one axis
    is Carbon's own chart; mixed styles or a right axis are its combo chart (`comboChartTypes` per style). Bars and areas
    side by side, stacked or as shares of 100%; horizontal when every series is bars on the left axis; lines smooth,
    straight or in steps, with or without dots; missing values (an average of no items) joined over or, "Leave a gap", a break in a line or unstacked area
    (Carbon breaks where a value is empty; a count or sum of none is 0, not missing); compact (a sparkline: no axes, legend or grid). A scatter's series are its Y fields, its X a number or
    date field, Size makes bubbles and Split by colours the dots; clicking a dot opens its item.
  - **Parts of a whole** (pie or donut, meter, treemap, word cloud; `partsOf`): the X axis's categories (by the first
    series' value), number fields (each made into one by its aggregate: fat, muscle and bone mass) or one value, against
    a Total: the sum of the parts, a number or a field (made into one like the value). A total larger than the parts
    adds a "Remaining" slice; a meter shows it as its empty part (Carbon's proportional meter); one value on a meter is a
    bar of its share. A gauge measures its value against its total likewise (none: the value is a %), shows its % (Carbon's
    gauge: no unit, the decimals as set), and the increase or decrease from a comparison value (any value, and "Previous
    value" after the Last value, or a number; Carbon's delta arrow). A stat (`StatView`, like Grafana's stat panel, made
    of Carbon parts; Carbon Charts has none): centred: the value's name (unless "Show the name above the number" is off), the number (heading-06, its unit a step smaller), the
    change from what it is compared with beside it as a Carbon tag with an up or down arrow ("Compared with the
    average (79.2 kg)" below), as a % or the difference ("Change
    shown as"), green or red by which way is better ("Better": higher, lower, neither: grey), and a sparkline across the block below (4rem, as a compact chart; full width by default, Width narrows it): the value along its X axis ("Sparkline along") as Carbon's compact area
    or line chart (`chartSpec` of a stat is it; in its tag's colour, Carbon's `color.scale`: support-success,
    support-error, grey for neither), or none (`statOf`, `baselineOf` in domain/chart.ts).
  - **Spread**: a histogram's field (a number or a date: dates on a time axis), bins and Split by; a box plot's field (a
    box per X category); a heatmap's columns (the X axis) × rows (Split by), or with a date X axis and not split a
    calendar (weeks × weekdays; empty cells left undrawn).
  - **Axes**: the X axis's title; the left and (while a series uses it) right axis' title, min, max and logarithmic scale.
    Without a min, bars and stacked areas start at 0 and lines, areas and dots fit their values (`includeZero: false`, `FIT`
    in chartSpec.ts), so a weight from 80 to 70 shows its trend.
  - **Thresholds**: info, target, warning and danger levels (`THRESHOLD_STATUSES`: blue, green, yellow, red lines;
    a gauge or meter takes Carbon's statuses only, a target as its success, and doesn't offer info); lines on a bar, line or area chart's left axis, a gauge's status (Carbon colours
    only its delta arrow with it: offered only while it compares with something) and a meter's status ranges (there a % of the total or values: `thresholdPercent`, `statusOf`, `statusRanges`).
  - **Values and legend**: a unit and decimals for axes and tooltips, decimals for a gauge (`formatValue`); the legend automatic (with
    more than one series or part), shown or hidden, and where.
  - **Size**: Height (see below) and Width (a slider like the cards', 8 to 120rem (about 1920px) at most; a gauge as wide
    as a pane is mostly empty, so switching to one makes a full-width chart 24rem).
  A setting still to choose (a field, three spokes) or nothing to chart says so instead of an empty chart. The chart follows
  the theme (`white` / `g100`); Carbon's toolbar is off. A remote collection's chart loads all its rows for the active filters (`useRemoteResult` with `uses.all`: pages of `MAX_SOURCE_PAGE` (10,000) rows one after the other, a progress bar of the rows in against the source's total and Cancel under it; after Cancel the chart shows the rows in and "Load all rows" goes on).
  A chart, a map and a component block showing HTML have the same Height setting (`BLOCK_HEIGHT` and
  `normalizeBlockHeight` in `domain/views.ts`, the slider `views/HeightSlider.tsx`: 8 to 48rem, 24 for a new block;
  a chart's old Small / Medium / Large reads as 16 / 24 / 32) and Aspect ratio beside it (`ASPECT_RATIOS`: none, 2:1,
  16:9, 3:2, 4:3, 1:1, 3:4; 4:3 unless set, `AspectSelect`): the block is as tall as the less of the two, worked out
  in CSS from its own width (`blockHeightCss`: `min(<Height>rem, 100cqi × h / w)`, its box a size container), so a
  desktop-wide block takes its Height and a phone-narrow one keeps its shape. That height is the most the block takes: what fills its box (a
  map, a chart, HTML at 100%) gets it all, what is less tall takes its own height and no empty room is left: a pie,
  donut, gauge or radar narrower than the height is fitted to its drawing (`ChartCanvas`, measured after Carbon
  draws it, again when its width changes), HTML with a height of its own is that tall (it scrolls inside beyond the
  height). The component's own aspect ratio setting is gone (a stored `frameRatio` is kept, unused); a component
  field's HTML that fills its box is 24rem tall. ChartCanvas hands Carbon the same data and options objects while
  nothing in them changed (`useStableSpec`): Carbon redraws on new ones, which hid the tooltip under the pointer. New
  options (or type) are a new Carbon chart (keyed on them): Carbon merges new options into its old ones, so a setting
  taken out (a threshold, an axis's min) stayed drawn until a reload; new data alone is drawn in place.
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
  or with Escape on an empty box; the blocks filter once typing pauses 150 ms, an emptied box at once; while it has text, a block listing items with none matching is
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
  shown space's native collections below it), Remotes (`#/remotes`, once the server has a remote
  connection or remote collections exist: `useRemotesShown`; the space's remote collections below it)
  and Components; branches remember being open per
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
