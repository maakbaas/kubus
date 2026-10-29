# GUI stress suite

A browser test suite that clicks through the whole app and checks layout rules on every page, at
many window sizes and with content of every shape. Not part of `npm test`; CI runs only the smoke tests
of the suites a branch's changes reach (`--smoke --changed`, `.github/workflows/test.yml`): the full suite runs sharded in `full.yml`
(`npm run suite -- gui-NN` / `gui-shard-N` run a suite or a shard with a time budget: `tests/README.md`).

```
npm run test:gui                                  # everything (~265 tests, about an hour; browsers in parallel by free memory)
npm run test:gui:smoke                            # the smoke subset (~23 tests, ~10 minutes): quick checks
npm run test:gui -- --changed --smoke             # smoke tests of the suites covering what changed since origin/main (areas.mjs)
npm run test:gui -- --changed                     # …all their tests
npm run test:gui -- --grep "elsewhere" --repeat 20 # each test 20 times: how flaky is it?
npm run test:gui -- --suite 21 --update-baselines # store new screenshot baselines (a deliberate commit)
npm run test:gui -- --browser webkit --suite "01|02|10|14|20" # WebKit (see below)
npm run test:gui -- --suite 04                    # one suite (regex on the file name)
npm run test:gui -- --grep "phone"                # tests whose "suite › name" matches
npm run test:gui -- --workers 3 --shot-all        # fewer browsers, a screenshot of every checkpoint
npm run test:gui -- --skip theme-color,type-style # leave audit rules out
npm run test:gui -- --list                        # list the tests
npm run test:gui -- --dev                         # against the dev server (port 1420) instead of a build
npm run test:gui -- --name b --port 1431          # a second run alongside the first (own browsers, build, report-b/)
npm run test:gui -- --coverage                    # also collect the app's JS coverage (see below)
npm run test:gui -- --perf                        # only the perf tests (suite 23), each once; perf-summary.json
npm run test:gui -- --perf --perf-compare old.json # …compared per test with an earlier perf-summary.json
```

It needs `playwright-cli` on the PATH (`npm install -g @playwright/cli`) and Chrome. Without Chrome
(a container with Playwright's Chromium only), point it at another browser with a config file in
`PLAYWRIGHT_MCP_CONFIG`, e.g. `{ "browser": { "browserName": "chromium", "launchOptions":
{ "executablePath": "/path/to/chromium", "chromiumSandbox": false } } }` (no sandbox when running as root).

Smoke for quick checks while working; the full run before larger pushes (and green once
before calling the GUI stable). No test throttles the CPU: that would only measure the same
paths again at several times the cost. A test that fails and then
passes on its retry (`--retries`, default 1) is reported as **flaky** and fails the run; so does a
test whose `--repeat` runs disagree.

A hung test cannot stall the run: one that takes longer than `--test-timeout <s>` (wall clock, default 600; `heavy`
tests get three times that, `--coverage` doubles it) is recorded as errored ("Timed out"), not retried, and its browser session is killed and
reopened; the run goes on.

Every test also fails when the app loads a font, script, style or image from another host: the
app is offline first and must look the same without a network (IBM Plex is bundled, `app/src/fonts.css`). It tests a
bundled build of the app in `gui-tests/.build`, made with `NODE_ENV=development` (so the dev-only
`window.kubus.repo` the tests seed data through stays, and React logs its warnings, which count as
console errors) and served by `vite preview` on port 1430 (`--port`) for the run. The build is
redone only when something in `app/`, `shared/` or `package-lock.json` is newer than it (~20–50 s).
Pages load about 40% faster than from the dev server, which sends hundreds of modules one by one.
`--dev` tests the dev server instead (reused when running, else started); `--base-url` an app
already running elsewhere.

Output: `gui-tests/report/index.html` (open it in a browser) with every test, every checkpoint and
its screenshot; failing elements are outlined and numbered in the screenshot. `results.json`
beside it has the same data. The exit code is 1 when any checkpoint failed.

## Coverage

`--coverage` collects which lines of `app/src` and `shared/` the tests run: the build is made with source maps (redone once if it
was made without), and every test starts V8's precise coverage over CDP in its Chromium page (taken before each page load, which
discards the old page's scripts, and at the end). Each test's data goes gzipped to `coverage/gui-v8/tN.json.gz` (`coverage/gui-v8-<name>/`
with `--name`), about 100–400 KB; the folder is emptied at the start of a run. It needs the build (not `--dev` or `--base-url`) and Chromium; the
SQLite worker's own code is not included. `npm run coverage:report` maps the data through the source maps to the files in `app/src`
and merges it with the unit tests' (`docs/testing.md`, Coverage). Try it on a few tests:
`npm run test:gui -- --suite 02 --grep "resize gutter" --workers 1 --coverage`.

## Memory

A browser session peaks at about 1.7 GB on ordinary tests (the app with its SQLite worker, plus a
renderer per sandboxed HTML frame) and at several GB on the heavy ones (the 1000-row table alone
is 84k DOM nodes). So the runner:

- picks the number of browsers from the free memory (at most 3; `--workers` overrides);
- runs tests marked `{ heavy: true }` last, one at a time, in a single fresh browser;
- restarts each browser every 8 tests (`--recycle`), and after a test that errored;
- waits before a test while less than 1.5 GB is free (`--min-free`);
- closes its browsers on Ctrl+C. A hard kill can't be caught: the daemons and their Chromes
  survive it, so the next run ends any `kubus-gui-*` session still running before it starts.

The audit only styles elements within about a screen of the view (positions first, styles for
those): on a big page that is the difference between a minute and a second per checkpoint.

## How it works

- `run.mjs` lists the tests, opens N `playwright-cli` browser sessions and runs each test with
  `playwright-cli run-code`: the test's code (lib + suite) is one `async page => {}` function.
- Every test gets a fresh browser context: its own OPFS database, localStorage and viewport. It
  seeds what it needs (`lib/data.js`: `t.seed(spec)`, content generators, `profileSpec`,
  `matrixSpec`, `wsLayout` for tab and split layouts) and opens pages with `t.open(path)`.
  What suites share besides the data lives in `lib/`: `lib/locators.js` (the open panel, popover and dialog, Carbon dropdowns and picking an option), the
  suite's own calendar in `lib/data.js`; suites are plain scripts in one scope with `lib/`, so a suite can't declare a name `lib/` already has.
- Checkpoints are the pass/fail criteria, each recorded with a screenshot:
  - `t.audit(label)`: the layout audit (`lib/audit.js`, `CRITERIA` lists every rule): no page or
    pane overflow, nothing sticking out or cut off, no overlapping text or controls, every control
    clickable, Carbon's small sizes, no ghost buttons with text, accessible names, popovers inside
    the window, type scale, theme colours only, the tab strip rules, no nested scrolling, unique ids,
    no broken images, no native controls, WCAG AA text contrast, open popovers hanging at their button, aria-expanded matching, …
  - `t.noShift(label, action)`: nothing on screen moves or resizes (and no pane scrolls) while the
    action runs: editing in place, hovering, toggling, collapsing.
  - `t.popoverStep(label, action, { target, scope })`: a step inside an open popover (typing,
    toggling, picking, adding a row): it stays open, its button stays put, its panel keeps the edge it
    hangs from and its width (no jump, no flip), the control used stays under the pointer, and nothing
    in `scope` moves (the bars behind it). `t.dialogStep` is the same for dialogs (their top edge holds;
    they grow downwards).
  - `t.escapeCloses(label)`: Escape closes the open popover / menu / dialog, nothing is left floating,
    and focus returns to the popover's button.
  - `t.focusInfo()`: where focus is, whether it is in sight and whether it is drawn (a focus ring),
    for the keyboard walk.
  - `t.check(label, condition, detail)`: a named assertion.
  - Every test also fails on any console error, uncaught exception or failed request for one of the
    app's own files, and page loads are checked for layout shift (CLS).

## Design rules

`lib/design.js` checks visual consistency on every `t.audit`, next to the breakage rules of
`lib/audit.js` (ids in `CRITERIA`): spacing on Carbon's scale, one left edge per page (and one right
edge), equal gaps between fields and between blocks, icon buttons at a 32px pitch, text in the type
styles the app uses, checkbox labels centred on their boxes, square corners and shadows only where
Carbon has them, 1–2px borders, ellipsized text readable whole somewhere, 24px touch targets on
phones, even padding in toolbar popovers, every block (item pages too) inside its page's content box with its header on the
page header's right edge, and on a phone-wide pane the content box = window minus spacing-05 each side. Each was measured on every page first (`__design({ survey:
true })` returns what a rule sees by value); what the app does almost everywhere became the rule.
Carbon's own components keep their insides; derived values (centring a line in a 2rem row, a
centred column) and documented exceptions are listed in the rule with the reason.

## Screenshot baselines

`t.baseline(name)` (suite `21-baselines`) saves a PNG of the window, compared in `run.mjs` with
`gui-tests/baselines/<name>@<viewport>[-dark].png` (pixelmatch: a pixel differs above a colour
distance of 0.1; the baseline fails when more than 0.1% differ, the difference image in the report).
Deterministic: bundled fonts, no animations, the pointer out of the way, the caret hidden, seeded data
and no times of day on the pages chosen. After a deliberate visual change, `--update-baselines`
and commit the PNGs. Pixels still depend on the machine's browser build and font rasterisation: the
baselines match Playwright's Chromium on Linux (a cloud session's), not CI's Chrome, so CI leaves
suite 21 out.

## WebKit

`--browser webkit` opens WebKit through `playwright-cli open --browser webkit`; it needs WebKit for
playwright-cli's own Playwright (`node <global node_modules>/@playwright/cli/node_modules/playwright-core/cli.js
install webkit` plus its system packages) and no `PLAYWRIGHT_MCP_CONFIG` pointing at Chromium. The
iOS rules (sticky tab strip, no filter above floating panels, popover placement, dialogs over the
strip, the on-screen keyboard) are in suites 01 (and 35-39), 02, 10, 14 and 20.

## Suites

| File | What |
|---|---|
| `01-pages-typical` | the pages matrix, part 1: every page with typical content × 7 window sizes (the pages and the test are in `lib/matrix.js`; each part stays within the ~10 minute budget per suite) |
| `35-pages-long` .. `38-pages-short` | the pages matrix, parts 2-5: every page with long (all sizes but wide), unbroken, unicode and short content × 7 window sizes |
| `39-pages-dark-empty` | the pages matrix, part 6: long content on the wide window; dark theme; empty database, empty items, no fields |
| `02-shell` | side nav (toggle, branches, overlay, resize gutter), space switcher, global search, sync status, many tabs and the tab width rules, tab close / middle click / history, split panes, divider drag, drag a tab to split |
| `03-click-everything-desktop` | every visible control of 16 pages is clicked on a desktop window (and what it opens, one level down); audit after each. The crawl is in `lib/crawl.js` (shared with 40-42) |
| `40-click-everything-phone` | the same on a phone window |
| `41-hover-icon-buttons-desktop` | every icon button of nine pages hovered (desktop): its tooltip stays in the window and covers nothing important; six tests of a page or two each |
| `42-hover-icon-buttons-phone` | the same on a phone window |
| `04-item-editing` | in-place editing of every field kind: label, box and text stay put, nothing else moves, Escape / Enter / click outside; title, checkboxes, lists, collapse, image hover; item views |
| `05-table` | cell editing keeps column widths, add row, sorting, hover, row actions, grouping, 60 columns, 200 / 1000 rows, narrow panes scroll sideways (all columns together), the header row held while the pane scrolls down |
| `06-views-blocks` | views (add, rename, star, unsaved changes, delete, 25 views), filters, every block menu, Show as, add / hide / remove blocks, collapse, cards options |
| `07-forms` | creating a collection with every field type, new item form, editor reorder / remove, icon picker, components (failing and wide HTML), spaces, bookmarks, settings, collections overview |
| `08-markdown` | typing every GFM construct, no inner scrolling, huge notes, links, chips, task boxes |
| `09-sweep-and-scale` | live width sweep 320–2560px and height sweep, 60 collections / 80 fields / 30 views, dark theme dialogs, rapid switching |
| `10-popovers-in-use` | every toolbar popover used like a person would (typing a character at a time, toggling, picking, adding and removing rows, a dialog from it): nothing jumps, it stays open, Escape closes it and returns focus, no leaks; one at a time, click-through, scrolling and resizing with one open, two panes |
| `11-keyboard-hover-dialogs` | Tab through every page (every stop in sight, with a focus ring, no hidden stops, never stuck), dialogs (focus inside, Tab kept inside, Escape, focus back), hovering any control moves nothing, typing and choosing in dialogs |
| `12-combinations` | an edit in one pane shows in the other, one click from one field's edit to the next, edits surviving a resize / tab switch / side nav, popovers while the layout changes around them, arrangement kept across a reload |
| `13-live-changes` | data changing underneath (another pane, a sync): an open editor keeps what is typed, the open item / collection deleted elsewhere, fields renamed / added / removed under an open table, a burst of writes |
| `14-dark-layers` | every popover, menu, tooltip and dialog in the dark theme, audited open (contrast included) |
| `15-ai` | AI fields against a fake OpenAI-style endpoint (`page.route`): values filling in, Generate again with a nudge, a value typed over and "Replace what you typed?", a 429, a failure and Retry, many values asking first, no model set up, Write with AI |
| `16-media` | image field upload / replace / remove / drop (files made in the page), the lightbox, images pasted and dropped into Markdown (stored as files), a missing image |
| `17-reorder` | reordering by keyboard, by drag (the line inside the list, other rows still, one move on drop) and as a selected group: collection editor fields, a block's Fields, View settings blocks; Delete asks first |
| `18-sync` | a fake sync server: first connection confirmed, upload to an empty server, the status button in every state, a refused token, disconnect, a server with data replacing this device's, a server of another sync version (status and Settings name the side to update; changes stay queued and go once it matches) |
| `19-editing-more` | undo / redo and pasting in Markdown, undo in the code editor, a reference field's choice filter, moving an item to another space, item views pinned / starred / deleted, a component field's Change component? dialog, cards, search results |
| `20-mobile-keyboard` | a field in a popover (block settings, view settings, icon picker) on phones with the on-screen keyboard coming up the Android way (shorter window) and the iOS way (shorter visual viewport, `t.keyboardUp`): it stays open and focused, keeps its side of its button, fits above the keyboard with the field in sight, typing works; after rotating and back (with or without either keyboard, an iOS-panned visual viewport) a touch at every control's centre reaches it, the workspace is the window and `--keyboard-inset` is current; iOS's whole sequence for the lowest field of a panel below its button and of a panel above a button near the bottom (block settings, filter value, view settings, icon search): focus, the visual viewport panned before it shrinks, scrolls recorded: the same field stays focused, shown and in sight, never blurred, the window never scrolled, and put back at 0,0 after "Done" |
| `21-baselines` | screenshot baselines of 9 key states (pages of typical content, a popover, a dialog) at desktop and phone, light and dark |
| `22-components-filters-cards` | a field's settings under its name and type; local components (fields, blocks, Markdown code) and saved as shared from the Components page; AI prompt in the field dialog; strike through the item on tables and cards; `{{ }}` code in a filter value and an invalid value; cards with the cover beside the text, the same in narrow and wide panes |
| `28-settings-pages` | every Settings section against a fake server and a fake language model (`page.route`): `?section=` deep links and tabs (phone too); Server (Test connection ok / wrong token / unreachable / not Kubus, Save only when changed, Disconnect and "Connect to this server?" ask); Sync (switching on asks, Download images, wiping local / server asks, a failed wipe); Backup (Download backup: a real SQLite file named by the day holding the items and images; Restore from backup: asks, Cancel / Escape change nothing, the data comes back, sync is left off and then a first connection; a text, empty, damaged, non-Kubus or newer-version file is refused with its reason); Connections (add, edit, delete, every kind's own fields, Time limit, secrets never shown again, a refused save, `?source=`); AI (Requests, the server's model and the device's own, key set / removed, model lists, Test, Save only when changed); Maps (the server's style or the device's); API tokens (made, shown once, copied, revoked); the source picker of a new remote collection; every section filled in at phone and laptop widths |
| `26-query-filter-sort-group` | the query panels with the table's rows asserted against the data: every Condition of every field kind, And / Or between rules, Value from the page's item, Remove filter; Sort by (every field, both directions, empty last) and Direction; Group by (every groupable field) and Group order, collapsed groups and blocks kept; the date period (Hour to Year, Which: counted from today / so far / the last n / a chosen one, Previous / Next, Any date, by Published / Logged / Created / Updated, Counted from the page's item's date, Range); a block's filter on top of its view's (And narrows, Or lets more in, the period frames both), Limit; "Filter all blocks" on an item page; a reference field's Choices; the panels on phones and laptops |
| `44-filter-bar` | the collection view's filter bar ("Show filter bar" in View settings): the setting stored with the view and kept after a reload, the Filter button moving onto the bar (held while View settings is open; grey while open, blue with rules, the same panel), the date period on the bar with the rows of every block asserted: no period yet (Any date, a kind creates it on the first date field, else Updated), ‹ › on a rolling and a chosen period and on a range, the kind switch keeping the window, "most recent" jumping to the rolling this week / month / …, periods up to now, every step an unsaved edit (* on the tab, Save stores it, switching views discards it, other rules stay); the bar in one row at 320 px to 1440 px with the audit, the label readable whole, nothing moving while stepping, the panels and the kind switch open, dark theme, keyboard; the pages matrix (01, 35-39) also audits a view with the bar and a period (`matrixSpec(…, { filterBar: true })`) |
| `23-perf` | perf tests, run only with `--perf` (left out of other runs): the app's hot paths, each phase (a load, a click, a key, to the state it leads to) timed with main-thread busy time, long tasks, elements and heap; seeding, settling and audits reported apart |
| `24-chart-blocks` | the Chart block: the Chart select through all 14 kinds (what is drawn, which sections and controls are offered, phone and desktop), then each kind's options (X axis, order, date steps, largest n, series, Draw as, axis, transform, stack, curve, missing values, parts of a whole and their total, spokes, gauge and stat's compare with, bins, scatter fields, heatmap, axes, thresholds, unit, decimals, legend, height, aspect ratio, width) with the result drawn and stored, kept after a reload; a chart that can't be drawn says why; Of this item on an item page |
| `25-map-and-view-options` | the Map block against a stubbed OpenFreeMap (Location text or Latitude / Longitude, Show as route, zoom, a dot hovered and clicked), Cards (Show title, Cover beside the text, Card width, Cover, Cover shape), Table (Title links, Items shown at a time, Show more), the Component and Markdown blocks, a block's Name, Hide empty fields and header, the Collection picker of an item page's block; each change read back from the stored view and after a reload |
| `29-remotes-collections-search` | the Remotes page against a fake server (`page.route`): the side nav branch, a new remote collection from a source and table, editing (hidden columns, read again), duplicate / delete, a remote block's pages, Show more, the loading bar with its × (first page and every row, aligned with the header buttons, keyboard, Load rows / Load all rows after); the Collections page (groups by space, sort, description in place, duplicate, delete asks first); the collection editor (new, rename / add / remove with the Remove fields? dialog, title, spaces, cancel, remote vs local fields); search (hit groups, highlights, where a hit leads, nothing found, tags, the 50+ count, the search bar in a pane) |
| `27-field-kinds-settings` | field kinds and their settings in the collection editor and the field dialog: the type menu lists every kind and each brings its own settings (Refers to, the toggle icons, strike through, component code and Output, Value AI prompt); every kind stored with its settings and shown again after a reload; validation (names, a reference without a collection), a type changed before saving, a removed field, plural / singular name and description, the Title choice, a list of items edited in an item |
| `31-item-page-components` | the item page's Details and Page layout popovers (View name, Fields are editable, Hide empty fields, Fields) read back from the stored item view and after a reload; item views added, unsaved block changes discarded / saved, deleted; a block whose collection is gone; Generate again against a fake model; the New item form (defaults, errors, every kind stored, Cancel); the Components list (kinds, duplicate, delete with Also delete these fields), creating / editing a component, code errors, every Output, the preview (item, grouped by, fields), AI prompt Try against a fake model, Save as shared / back to Local, a component field edited in place |
| `32-page-gaps` | the rarer paths of the collection and item pages, each asserted by its result: a collection with no saved view in a space (the virtual All stored by "+", a bookmark, a rename, an added block, Save changes, a folded block), blocks removed (asked first, from the block and from View settings, the last one stays) and a view deleted, an item deleted from its page (asked first, a failing delete says so), a wrapped text edited in its own box (table cell, item page), stored images inside an HTML field, the table's add row (invalid value, leaving it, a failed save, Escape), an AI prompt empty for the item and Try against a failing model; item and collection pages at 360 / 390 / 412 px: content box spans the window minus the padding, every block (chart and map included) fits it and shares one right edge for header and "⋮" |
| `33-sync-shell-gaps` | a server whose database was wiped or replaced (status button, Settings → Sync, Replace this device's data? asks, an empty server is uploaded to), a tab dropped on each pane edge (the split and where the tab lands, kept after a reload), a #tag in a component's frame (click here, Ctrl+click beside, middle click in a new tab) |
| `34-markdown-editing` | the Markdown editor's own behaviours, each read back from the stored Markdown: Tab in a table (next cell, a new row from the last), task boxes clicked in the editor, the typed `[text](url)` rule, `#tag` decorations (not in code or links) and clicks, plain / Ctrl clicks on links, the link hover popover (Open, Edit dialog, Remove), links typed by name stored by id, the code-language picker, stored images, the table row / column handles (add, delete, header rows), pasted and dropped images |
| `43-backlinks` | Backlinks, the items that link to an item, as a block on its page: offered in an item page block's Collection picker only; a table with one row per link (Markdown links to an item or one of its fields, a reference field, a list of items; not collection / view / new-item links, text fields, self links) read back from the repository and after a reload; rows appearing and disappearing live as links change in another pane's Markdown (typed in the editor) and in reference fields; group by Collection (order, saved, collapsed), filter and sort on its fields; cards, a Component block over `$items` / `$groups` / `$fields`, a chart; read-only (no row actions, add row or cell editing, unlike a table beside it); rows leaving with deleted / moved items, removed fields, deleted collections; a remote collection's row; phone and dark theme; an empty page |
| `45-merged-collections` | A block listing several collections (Block settings → Collections): Invoices (native) with Shop sales (a remote table behind a faked server) as one table; fields of one name are one column, fields only one has are empty for the other's rows, Collection names a row's collection; sorted by date with Show more asking the remote part only when its rows are used up; group by Collection with summed sizes; a bar chart of Amount by month stacked by Collection and a stat of the total (all rows loaded); the view's filter, its date period stepped by month, reaching both; Fields → Merge fields (a hand merge, stored with the block, undone); read-only rows that open their own item or remote row; a deleted collection shown as a problem with the other's rows kept |
| `30-workspace-shell-actions` | the shell's behaviour, each step followed by its result (page, stored layout, stored data): click / Ctrl+click (beside, or a new tab on narrow windows) / middle click, side nav and "+", per-tab history (Alt+arrows, mouse buttons), reload keeping tabs, closing tabs (neighbour active, split collapsing, empty workspace); Spaces (new, rename in place, switch, delete with its question, the only space, what each space lists, one workspace per space, an item moved); Bookmarks (button on an item and a view, side nav, label refreshed, the page: sort, New bookmark, remove, per space); Help tabs and deep links; `/` redirect and Not found for bad routes and ids |


## Adding to it

A new rule goes into `__audit` in `lib/audit.js` (breakage) or `__design` in `lib/design.js`
(consistency) with an entry in `CRITERIA`. A new test is
`test(name, async (t) => { … }, { viewport, dark })` in a suite; tests share nothing but `lib/`.
**A suite stays within about 12 minutes of serial test time** (under 10 minutes at 2 workers, CI's, with margin): a suite that grows past it is split into numbered parts, with the shared code in `lib/` (`matrix.js` and `crawl.js` are the two splits so far); `tests/run.mjs` warns when a suite's last measured time (`report/results.json`) is over its budget.
The `run-code` sandbox has no `require`, `setTimeout` or file system: wait with `t.settle()`, and use
Playwright's API on `t.page`. Wait for a state, not a time: `t.editorReady()` after opening an
in-place editor, `t.until(label, fn)` for what a save should show (a fixed `t.wait` is outrun on a
busy machine). Options: `{ viewport, dark, smoke, heavy, perf }`. When the app changes on purpose (a deliberate
exception to a rule), exempt it in the rule with a comment saying why, as the existing exemptions do.
