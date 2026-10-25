# GUI stress suite

A browser test suite that clicks through the whole app and checks layout rules on every page, at
many window sizes and with content of every shape. Not part of `npm test` or CI: run it by hand.

```
npm run test:gui                                  # everything (~170 tests; browsers in parallel by free memory)
npm run test:gui -- --suite 04                    # one suite (regex on the file name)
npm run test:gui -- --grep "phone"                # tests whose "suite › name" matches
npm run test:gui -- --workers 3 --shot-all        # fewer browsers, a screenshot of every checkpoint
npm run test:gui -- --skip theme-color,font-scale # leave audit rules out
npm run test:gui -- --list                        # list the tests
npm run test:gui -- --dev                         # against the dev server (port 1420) instead of a build
```

It needs `playwright-cli` on the PATH (`npm install -g @playwright/cli`) and Chrome. It tests a
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
    no broken images, no native controls, …
  - `t.noShift(label, action)`: nothing on screen moves or resizes (and no pane scrolls) while the
    action runs: editing in place, hovering, toggling, collapsing.
  - `t.check(label, condition, detail)`: a named assertion.
  - Every test also fails on any console error or uncaught exception, and page loads are checked
    for layout shift (CLS).

## Suites

| File | What |
|---|---|
| `01-pages-matrix` | every page × 5 content styles (typical, long, unbroken, unicode, short) × 7 window sizes; dark theme; empty database, empty items, no fields |
| `02-shell` | side nav (toggle, branches, overlay, resize gutter), space switcher, global search, sync status, many tabs and the tab width rules, tab close / middle click / history, split panes, divider drag, drag a tab to split |
| `03-click-everything` | every visible control on 14 pages is clicked (and what it opens, one level down), every icon button hovered; audit after each |
| `04-item-editing` | in-place editing of every field kind: label, box and text stay put, nothing else moves, Escape / Enter / click outside; title, checkboxes, lists, collapse, image hover; item views |
| `05-table` | cell editing keeps column widths, add row, sorting, hover, row actions, grouping, 60 columns, 200 / 1000 rows, narrow panes |
| `06-views-blocks` | views (add, rename, star, unsaved changes, delete, 25 views), filters, every block menu, Show as, add / hide / remove blocks, collapse, cards options |
| `07-forms` | creating a collection with every field type, new item form, editor reorder / remove, icon picker, components (failing and wide HTML), spaces, bookmarks, settings, collections overview |
| `08-markdown` | typing every GFM construct, no inner scrolling, huge notes, links, chips, task boxes |
| `09-sweep-and-scale` | live width sweep 320–2560px and height sweep, 60 collections / 80 fields / 30 views, dark theme dialogs, rapid switching |

## Adding to it

A new rule goes into `__audit` in `lib/audit.js` with an entry in `CRITERIA`. A new test is
`test(name, async (t) => { … }, { viewport, dark })` in a suite; tests share nothing but `lib/`.
The `run-code` sandbox has no `require`, `setTimeout` or file system: wait with `t.wait(ms)` /
`t.settle()`, and use Playwright's API on `t.page`. When the app changes on purpose (a deliberate
exception to a rule), exempt it in the rule with a comment saying why, as the existing exemptions do.
