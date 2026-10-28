# GUI stress suite

A browser test suite that clicks through the whole app and checks layout rules on every page, at
many window sizes and with content of every shape. Not part of `npm test`; CI runs only the smoke tests
of the suites a branch's changes reach (`--smoke --changed`, `.github/workflows/test.yml`): run the rest by hand.

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
npm run test:gui -- --perf                        # only the perf tests (suite 23), each once; perf-summary.json
npm run test:gui -- --perf --perf-compare old.json # …compared per test with an earlier perf-summary.json
```

It needs `playwright-cli` on the PATH (`npm install -g @playwright/cli`) and Chrome. Without Chrome
(a container with Playwright's Chromium only), point it at another browser with a config file in
`PLAYWRIGHT_MCP_CONFIG`, e.g. `{ "browser": { "browserName": "chromium", "launchOptions":
{ "executablePath": "/path/to/chromium", "chromiumSandbox": false } } }` (no sandbox when running as root).

Smoke for quick checks while working; the full run before larger pushes (and twice in a row green
before calling the GUI stable). No test throttles the CPU: that would only measure the same
paths again at several times the cost. A test that fails and then
passes on its retry (`--retries`, default 1) is reported as **flaky** and fails the run; so does a
test whose `--repeat` runs disagree.

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
phones, even padding in toolbar popovers. Each was measured on every page first (`__design({ survey:
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
strip, the on-screen keyboard) are in suites 01, 02, 10, 14 and 20.

## Suites

| File | What |
|---|---|
| `01-pages-matrix` | every page × 5 content styles (typical, long, unbroken, unicode, short) × 7 window sizes; dark theme; empty database, empty items, no fields |
| `02-shell` | side nav (toggle, branches, overlay, resize gutter), space switcher, global search, sync status, many tabs and the tab width rules, tab close / middle click / history, split panes, divider drag, drag a tab to split |
| `03-click-everything` | every visible control on 14 pages is clicked (and what it opens, one level down), every icon button hovered; audit after each |
| `04-item-editing` | in-place editing of every field kind: label, box and text stay put, nothing else moves, Escape / Enter / click outside; title, checkboxes, lists, collapse, image hover; item views |
| `05-table` | cell editing keeps column widths, add row, sorting, hover, row actions, grouping, 60 columns, 200 / 1000 rows, narrow panes scroll sideways with the first column staying put |
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
| `18-sync` | a fake sync server: first connection confirmed, upload to an empty server, the status button in every state, a refused token, disconnect, a server with data replacing this device's |
| `19-editing-more` | undo / redo and pasting in Markdown, undo in the code editor, a reference field's choice filter, moving an item to another space, item views pinned / starred / deleted, a component field's Change component? dialog, cards, search results |
| `20-mobile-keyboard` | a field in a popover (block settings, view settings, icon picker) on phones with the on-screen keyboard coming up the Android way (shorter window) and the iOS way (shorter visual viewport, `t.keyboardUp`): it stays open and focused, keeps its side of its button, fits above the keyboard with the field in sight, typing works |
| `21-baselines` | screenshot baselines of 9 key states (pages of typical content, a popover, a dialog) at desktop and phone, light and dark |
| `22-components-filters-cards` | a field's settings under its name and type; local components (fields, blocks, Markdown code) and saved as shared from the Components page; AI prompt in the field dialog; strike through the item on tables and cards; `{{ }}` code in a filter value and an invalid value; cards with the cover beside the text, the same in narrow and wide panes |
| `23-perf` | perf tests, run only with `--perf` (left out of other runs): the app's hot paths, each phase (a load, a click, a key, to the state it leads to) timed with main-thread busy time, long tasks, elements and heap; seeding, settling and audits reported apart |

## Adding to it

A new rule goes into `__audit` in `lib/audit.js` (breakage) or `__design` in `lib/design.js`
(consistency) with an entry in `CRITERIA`. A new test is
`test(name, async (t) => { … }, { viewport, dark })` in a suite; tests share nothing but `lib/`.
The `run-code` sandbox has no `require`, `setTimeout` or file system: wait with `t.settle()`, and use
Playwright's API on `t.page`. Wait for a state, not a time: `t.editorReady()` after opening an
in-place editor, `t.until(label, fn)` for what a save should show (a fixed `t.wait` is outrun on a
busy machine). Options: `{ viewport, dark, smoke, heavy, perf }`. When the app changes on purpose (a deliberate
exception to a rule), exempt it in the rule with a comment saying why, as the existing exemptions do.
