# GUI suite

A browser test suite that goes through the whole app and checks layout rules on every page, at many window sizes
and with content of every shape, plus one main-path flow per area (`docs/testing.md`, "GUI suites"). Not part of
`npm test`; CI runs the smoke tests on every push (`test.yml`) and the whole suite sharded when run by hand (`full.yml`).

```
npm run test:gui                                  # everything (~100 tests, about 15 minutes; browsers in parallel by free memory)
npm run test:gui:smoke                            # the smoke tests (~36): what CI runs on every push
npm run test:gui -- --suite 04                    # one suite (regex on the file name)
npm run test:gui -- --grep "phone"                # tests whose "suite › name" matches
npm run test:gui -- --grep "elsewhere" --repeat 20 # each test 20 times: how flaky is it?
npm run test:gui -- --browser webkit --suite "01|02|10|14|20" # WebKit (see below)
npm run test:gui -- --workers 3 --shot-all        # fewer browsers, a screenshot of every checkpoint
npm run test:gui -- --skip theme-color,type-style # leave audit rules out
npm run test:gui -- --list                        # list the tests
npm run test:gui -- --dev                         # against the dev server (port 1420) instead of a build
npm run test:gui -- --name b --port 1431          # a second run alongside the first (own browsers, build, report-b/)
```

It needs `playwright-cli` on the PATH (`npm install -g @playwright/cli`) and Chrome. Without Chrome
(a container with Playwright's Chromium only), point it at another browser with a config file in
`PLAYWRIGHT_MCP_CONFIG`, e.g. `{ "browser": { "browserName": "chromium", "launchOptions":
{ "executablePath": "/path/to/chromium", "chromiumSandbox": false } } }` (no sandbox when running as root).

No test throttles the CPU: that would only measure the same paths again at several times the
cost. A test that fails and then
passes on its retry (`--retries`, default 1) is reported as **flaky** and fails the run; so does a
test whose `--repeat` runs disagree.

A hung test cannot stall the run: one that takes longer than `--test-timeout <s>` (wall clock, default 600; `heavy`
tests get three times that) is recorded as errored ("Timed out"), not retried, and its browser session is killed and
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

## WebKit

`--browser webkit` opens WebKit through `playwright-cli open --browser webkit`; it needs WebKit for
playwright-cli's own Playwright (`node <global node_modules>/@playwright/cli/node_modules/playwright-core/cli.js
install webkit` plus its system packages) and no `PLAYWRIGHT_MCP_CONFIG` pointing at Chromium. The
iOS rules (sticky tab strip, no filter above floating panels, popover placement, dialogs over the
strip, the on-screen keyboard) are in suites 01 (and 35, 36), 02, 10, 14 and 20.

## Suites

Each file's first comment says what it covers. The generic sweeps: `01-pages-typical`, `35` and `36` (the pages matrix:
every page in each content shape, typical content at three window sizes, the others at one or two; `lib/matrix.js`),
`02-shell`, `03` / `40` click everything (desktop / phone; `lib/crawl.js`), `41` hover every icon button, `09` width and
height sweeps and scale, `10` popovers in use, `11` keyboard, hover and dialogs, `14` dark layers, `20` the on-screen
keyboard (Android and iOS). The rest are flows, one or two main-path tests per area. The whole suite stays well inside
the 30 minutes `npm run suite -- full` allows for everything (`docs/testing.md`): a new test pays for itself or another goes.

## Adding to it

A new rule goes into `__audit` in `lib/audit.js` (breakage) or `__design` in `lib/design.js`
(consistency) with an entry in `CRITERIA`. A new test (see `docs/testing.md` for when one is worth it) is
`test(name, async (t) => { … }, { viewport, dark })` in a suite; tests share nothing but `lib/`.
**A suite stays within about 12 minutes of serial test time** (under 10 minutes at 2 workers, CI's, with margin): a suite that grows past it is split into numbered parts, with the shared code in `lib/` (`matrix.js` and `crawl.js` are the two splits so far).
The `run-code` sandbox has no `require`, `setTimeout` or file system: wait with `t.settle()`, and use
Playwright's API on `t.page`. Wait for a state, not a time: `t.editorReady()` after opening an
in-place editor, `t.until(label, fn)` for what a save should show (a fixed `t.wait` is outrun on a
busy machine). Options: `{ viewport, dark, smoke, heavy }`. When the app changes on purpose (a deliberate
exception to a rule), exempt it in the rule with a comment saying why, as the existing exemptions do.
