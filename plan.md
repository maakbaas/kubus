# GUI suite, next round: design rules, stability under load, coverage, baselines, WebKit

## Context

The GUI suite (`npm run test:gui`, `gui-tests/`) now has 14 suites / ~214 tests and caught many
real bugs. Three gaps remain:

1. **Not consistently green.** One test ("editing in place, then elsewhere", suite 12) failed once
   under heavy load: a click on the Done checkbox while Count was being edited neither saved Count
   nor toggled Done (editor still open with "88", checkbox focused but unchanged). The code path:
   `FieldEditor` saves on a document `pointerdown` (capture) → `ItemPage.saveField` →
   `repo.updateItem` + `setItem(getItem)` + `setEditing(null)`; the toggle saves on its own click.
   Likely race: the save re-renders the row between pointerdown and click, so the click lands on a
   replaced element (or the save is skipped). Not yet reproduced deterministically.
2. **No rules for visual consistency.** The audit checks breakage (overflow, overlap, contrast,
   sizes) but not *design*: spacing on the scale, shared edges, rhythm, type styles, radii.
3. **Coverage gaps.** No test touches: AI fields / "Generate again" / AI banner, "Write with AI",
   image upload / paste / drop / lightbox, sync settings and its flows, moving an item between
   spaces, keyboard and drag reordering (`useReorder`), undo / paste in editors, a reference
   field's choice filter, item-view pin / delete, the component field's code dialog, cards
   interactions, search results navigation.

Decisions (from the user): design rules **enforced immediately**; add **screenshot baselines**,
a **WebKit run**, a **load/stress mode**, the **missing features**, and a **fast smoke subset**.
The fonts are now bundled (`app/src/fonts.css`), so the full suite must first be re-run with real
IBM Plex (text widths changed everywhere).

## Step 0 — Re-baseline with the bundled fonts

Run the full suite once on the current head (fonts bundled); fix what the new metrics break
(layout rules, not thresholds). Everything after builds on a green run.

## Step 1 — Stability: load mode, repeat, and the intermittent test fixed at its root

- **Load mode** in the harness: `--cpu <n>` sets `Emulation.setCPUThrottlingRate(n)` through a CDP
  session per test context (`t.page.context().newCDPSession`, as the perf profile used), so any run
  can be slowed 4–6× deterministically. `--repeat <n>` runs each selected test n times (names
  suffixed, results grouped) to measure flakiness.
- **Reproduce** the intermittent case: `--grep "editing in place, then elsewhere" --cpu 6 --repeat 20`.
  Add an event trace while it runs (pointerdown/mousedown/click targets with `isConnected`, the
  editor's save calls, React commits via a `MutationObserver` on the row) to see which happens.
- **Fix in the app**, depending on the trace:
  - if the row is re-mounted between press and click: keep the toggle's element stable during a
    save (rows keyed by field id already; check `entries` / `FieldCollapse.Provider` keys in
    `pages/ItemPage.tsx` ~line 560–630 and the `hideEmpty` filter that re-includes `editing`), and
    defer `setItem` / `setEditing(null)` after the save to the end of the current input (a
    `pointerup`/`click` microtask) so a click started before the save completes on the same element;
  - if the save is skipped: guard `FieldEditor.save` (`saving` ref, `ui/FieldEditor.tsx` ~line 94)
    so a pending save is awaited rather than dropped, and make `ItemPage.saveField`'s shared
    `saving` ref a counter (two concurrent saves — Count from pointerdown, Done from its click — reset
    it early today, letting the change feed overwrite state mid-save).
  Keep the test as it is; add a throttled copy of it to the smoke subset.
- **Remove timing guesses from tests**: replace fixed `t.wait(200)` after opening editors with
  `t.editorReady()` (waits for `.field-editor` and focus inside it) across suites 04/12/13; replace
  "settle then read" after saves with waits on the expected DOM state (`expect`-style polling helper
  `t.until(label, fn, timeout)` that records a checkpoint).
- **Gate**: the full suite green twice in a row, plus suites 04/05/10/12/13 green under `--cpu 4`.
- **Flake report**: tests that fail then pass on retry are listed as "flaky" in the report (today
  retries only cover *errors*); a flaky test counts as a failure of the run.

## Step 2 — Design rules, captured from the current GUI and enforced everywhere

Add `gui-tests/lib/design.js` (concatenated like `audit.js`; rules run inside `t.audit` with
their own ids in `CRITERIA`, same exemption style: a selector plus a comment saying why).
Each rule is first measured on all pages (a one-off survey script prints the histogram), the
dominant pattern becomes the rule, outliers are fixed in `app/src/styles.css`.

| Rule id | Pass/fail criterion (derived from what the GUI does now) |
|---|---|
| `spacing-scale` | Every non-zero computed margin, padding and gap of app elements is on Carbon's spacing scale (2, 4, 8, 12, 16, 24, 32, 40, 48, 64, 80, 96, 160 px) or a listed Carbon-internal value (e.g. 7px small-table cell padding, 1px border compensation). Today `styles.css` mostly uses `--cds-spacing-02/03/05`, plus raw values like `0.375rem`, `4.5rem`, `5rem`. |
| `edge-align` | In each pane the content's left text edge is shared: breadcrumb, page title (after its icon), description, first view tab label, block header names, field labels, first table column text and the add-row's "+" start at the same x (±1px), or at the one documented inset (item-page field labels: content edge + spacing-05, per the existing comment). Same for the right edge: page-header actions, the views bar's last icon, block header menus, table row actions end at one x. |
| `rhythm` | Vertical gaps between sibling sections are equal within a page: between item fields, between blocks, between the separator lines and the labels below them; header → tabs → first block distances identical on collection and item pages. |
| `toolbar-pitch` | Icon buttons in one row sit at a 32px pitch with no gaps or overlaps (extends `toolbar-align`, which only checks the vertical centres). |
| `type-style` | Each text's (font-size, line-height, letter-spacing, weight) matches one Carbon type style the app uses (body-01, body-compact-01, code-02, heading-compact-01, heading-04, label-01, helper-text-01…); weights only 300/400/600. Supersedes `font-scale`. |
| `baseline` | Text side by side shares a baseline: a stacked card's label and value, a checkbox and its label, a tab's label and close icon, an icon-label's icon centred on the text's first line. |
| `radius` | Square corners (Carbon): border-radius 0 except listed Carbon parts (checkbox 2px, toggle, tag, slider thumb, the md inline code). |
| `shadow` | Box-shadows only on floating layers (popovers, menus, dialogs, dragged rows) and focus/selection insets. |
| `border` | Border widths only 0/1/2px; separators full-width within their section and on the same x as the text edge rule above. |
| `truncation-hint` | Text cut with "…" exposes its full text (a `title`, a tooltip, or an accessible name containing it). |
| `touch-target` | On phone viewports, controls are ≥24×24px or have ≥24px between their centres (WCAG 2.5.8). |
| `popover-padding` | Toolbar popover panels and dialogs have equal padding on all sides (one spacing token) and their first control's text aligns with the panel's heading. |

Enforced immediately: rules land with the app fixes needed to make them pass, in one change per
rule (rule + fixes + documented exemptions), keeping the suite green after each.

## Step 3 — Coverage: the missing features (new suites)

Reuse `t.openPanel`, `t.popoverStep`, `t.dialogStep`, `t.escapeCloses`, `external()` from suite
13, `profileSpec`/`matrixSpec` (`lib/data.js`). Network fakes via `t.page.route` (Playwright).

- **15-ai**: a fake OpenAI-style endpoint (`page.route` on the configured address) returning
  scripted replies: AI field values fill in, the banner, "Generate again" popover with a nudge,
  typed-over values and the "Replace what you typed?" dialog, a 429 pausing everything, the
  "Generate N AI values?" confirmation; "Write with AI" in the component editor filling the form.
  Seed AI settings through `prefs` (`kubus.ai`). All with the popover/dialog step checks.
- **16-media**: image field upload (`setInputFiles`), paste and drop into the Markdown editor,
  the lightbox (open, keyboard, Escape, focus back), broken image handling.
- **17-reorder**: keyboard reordering (`useReorder`: select, arrows, space) and drag reordering
  in collection editor fields, Fields popover, View settings blocks; no jumps of rows not moved,
  drop indicators inside their list.
- **18-sync**: settings form with a fake `/api` (`page.route`): connect, first-connection
  replace confirmation, status icon states and popover, disconnect.
- **19-editing-more**: undo/redo in Markdown and code editors, paste of text / links / `{{ }}`,
  a reference field's choice filter, moving an item between spaces (Details), item-view pin /
  star / delete, a component field's code dialog (Change component / Discard / Keep editing),
  cards: click, checkbox in a card, open in new tab (middle click), search page results opening.

## Step 4 — Screenshot baselines

- `--update-baselines` writes PNGs to `gui-tests/baselines/<page>@<viewport>[-dark].png` for ~20
  key states (the matrix pages at desktop/phone, light/dark, typical content, plus a few popovers
  and dialogs open). Normal runs compare with a per-pixel tolerance (e.g. ≤0.1% of pixels differing
  by more than a small threshold), using Playwright's screenshot in-page compare is unavailable in
  `run-code`, so diff in `run.mjs` with `pngjs` + `pixelmatch` (dev dependencies) and put the diff
  image in the report.
- Determinism: bundled fonts, `reducedMotion`, fixed dates (`Date` frozen through an init script for
  "Created/Updated"), caret hidden, seeded data only.
- Baselines live in git; updating them is a deliberate commit.

## Step 5 — WebKit run

- `--browser webkit` passes through to `playwright-cli open --browser webkit` (config file per
  browser). Install WebKit (`npx playwright install webkit` + its system deps); if the environment
  can't, document it and run WebKit locally on macOS.
- A WebKit subset (`--suite "01|02|10|14" --browser webkit`) covering the iOS rules in CLAUDE.md:
  sticky tab strip, no filter ancestors of floating panels, popovers placement, dialogs over the strip.
  Expect and fix WebKit-only failures; exempt only documented engine differences.

## Step 6 — Fast smoke subset

- Tests tagged `{ smoke: true }` (≈25 tests, ~10 minutes): typical content matrix at phone and
  desktop, one click-everything page, edit-in-place at desktop, table add/edit, each popover suite at
  desktop, keyboard walk, live changes, the intermittent test under `--cpu 4`, 5 screenshot baselines.
  `npm run test:gui:smoke` = `--smoke`. README: smoke for quick checks, full before larger pushes.

## Step 7 — GUI code follow-ups the work above calls for

- Tooltip cost: every Carbon tooltip reads computed styles on each render (`Popover` layout effect);
  tables still mount one per visible icon button. Option: render icon buttons' tooltips lazily
  (an app `IconButton` wrapper mounting Carbon's on first hover/focus without replacing the button
  element), measured with the existing 200-row relative timing.
- Replace raw rem values in `styles.css` with spacing tokens as `spacing-scale` forces them.
- Optional: embed the bundled fonts in sandboxed HTML frames (data URLs, ~200 KB per frame) so
  component HTML matches the app; decide after measuring.

## Critical files

- `gui-tests/lib/harness.js` (load mode, `until`, `editorReady`, baseline capture), `gui-tests/lib/audit.js`
  (`CRITERIA`), new `gui-tests/lib/design.js`, `gui-tests/run.mjs` (`--cpu`, `--repeat`, `--browser`,
  `--smoke`, `--update-baselines`, flaky reporting, baseline diff), `gui-tests/suites/15-…19-*.js`,
  `gui-tests/baselines/`, `gui-tests/README.md`.
- App: `app/src/ui/FieldEditor.tsx`, `app/src/pages/ItemPage.tsx` (save race), `app/src/styles.css`
  (design-rule fixes), possibly `app/src/ui/ToggleInput.tsx`, a lazy-tooltip wrapper in `app/src/ui/`.
- Docs: CLAUDE.md conventions (design rules summarised), `docs/features.md` where behaviour changes.

## Verification

- After each step: `npm run typecheck`, `npm test`, the affected suites via `run.mjs --grep/--suite`.
- Stability: intermittent test `--cpu 6 --repeat 20` all green; suites 04/05/10/12/13 under `--cpu 4`.
- Final gate: full suite green twice in a row (Chromium), WebKit subset green, smoke green under
  `--cpu 4`, baselines matching; report shows 0 flaky. Commit and push after each step.
