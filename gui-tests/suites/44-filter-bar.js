// The collection view's filter bar ("Show filter bar" in View settings): the setting stored with the
// view and kept after a reload, the view's Filter button moving onto the bar (and its states there),
// the date period on the bar (‹ › stepping a rolling or a chosen period, the kind switch, "this one"
// as a rolling period, no period yet, periods up to now and ranges), every step an unsaved edit of
// the view's filter (the * on the tab, Save stores it, switching views discards it) that every
// block follows, and the bar in one row on every window size with nothing moving while it is
// stepped. Every step is followed by the rows shown, the label and what was stored.

const monthName = (day) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });

// --- data -------------------------------------------------------------------------------------

// Published is `pub` days from today (none: empty).
const BOOKS = [
  { title: "Alpha", pub: 0 },
  { title: "Bravo", pub: -1 },
  { title: "Charlie", pub: -3 },
  { title: "Delta", pub: -8 },
  { title: "Echo", pub: -20 },
  { title: "Foxtrot", pub: -45 },
  { title: "Golf", pub: -100 },
  { title: "Hotel", pub: -400 },
  { title: "India", pub: 1 },
  { title: "Juliet", pub: 10 },
  { title: "Kilo", pub: -15 },
  { title: "Lima", pub: -33 },
  { title: "Mike", pub: -65 },
  { title: "November", pub: null },
];
const TITLES = BOOKS.map((b) => b.title);
const pubDay = (b) => (b.pub === null ? null : dayStr(b.pub));
const inDays = (first, last) => BOOKS.filter((b) => pubDay(b) !== null && pubDay(b) >= first && pubDay(b) <= last).map((b) => b.title);
const inPeriod = (kind, offset) => inDays(...periodDays(kind, offset));

function barSpec() {
  return {
    collections: [
      {
        key: "books", name: "Book", plural: "Books", icon: "Book",
        fields: [
          { key: "title", name: "Title", kind: "string" },
          { key: "pub", name: "Published", kind: "date" },
          { key: "logged", name: "Logged", kind: "datetime" },
        ],
        items: BOOKS.map((b) => ({ values: { title: b.title, pub: pubDay(b), logged: new Date().toISOString() } })),
        views: [
          { name: "All", blocks: [{ kind: "table" }] },
          // Two blocks, the bar on: every block follows the view's period.
          { name: "Both", filterBar: true, blocks: [{ kind: "table" }, { kind: "cards" }] },
        ],
      },
      // No date field: a period goes by Updated.
      {
        key: "notes", name: "Note", plural: "Notes", icon: "Book",
        fields: [{ key: "title", name: "Title", kind: "string" }],
        items: [{ values: { title: "One" } }, { values: { title: "Two" } }],
        views: [{ name: "All", filterBar: true, blocks: [{ kind: "table" }] }],
      },
    ],
  };
}

// --- helpers ----------------------------------------------------------------------------------

const FILTER = /^Filter( \(\d+\))?$/;
const barOf = (t) => t.page.locator(".ws-pane--active .filter-bar");
const toolbarOf = (t) => t.page.locator(".ws-pane--active .views-bar").first();
const labelOf = async (t) => (await barOf(t).locator(".filter-bar__label").evaluate((e) => e.textContent)).trim();
const kindBox = (t) => barOf(t).locator(".filter-bar__kind");
const kindShown = async (t) => (await kindBox(t).locator(".cds--list-box__label").innerText()).trim();
const barButton = (t, name) => barOf(t).getByRole("button", { name, exact: true });
const tabsOf = (t) => t.page.locator(".ws-pane--active .views-bar [role=tab]").allInnerTexts();
const activeTab = async (t) => (await t.page.locator(".ws-pane--active .views-bar [role=tab][aria-selected=true]").innerText()).replace(/\s+/g, " ").trim();

/** The titles in a block's table or cards, in the order shown. */
async function titlesOf(t, block = 0) {
  return await t.page.evaluate((block) => {
    const b = document.querySelectorAll(".ws-pane--active .block")[block];
    if (!b) return null;
    const cells = [...b.querySelectorAll("tbody tr")].filter((r) => r.checkVisibility()).map((r) => (r.querySelector("td")?.innerText || "").trim());
    const cards = [...b.querySelectorAll(".item-card__title")].filter((c) => c.checkVisibility()).map((c) => c.innerText.trim());
    return [...cells, ...cards].filter(Boolean);
  }, block);
}
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
/** Waits until the block shows exactly these titles (as a set). */
async function expectRows(t, label, expected, block = 0) {
  let last = null;
  return t.until(`${label}: ${expected.length} row(s)`, async () => {
    last = await titlesOf(t, block);
    if (!last) return "no block";
    return same(last, expected) || `shows ${JSON.stringify(last)}, expected ${JSON.stringify(expected)}`;
  });
}

const storedView = (t, collectionId, name = "All") => t.page.evaluate(async ([cid, name]) => (await window.kubus.repo.listViews(cid, "default")).find((v) => v.name === name), [collectionId, name]);
/** Stores a change to a view (its filters, say) and opens the page again. */
async function changeView(t, ids, name, patch, key = "books") {
  await t.page.evaluate(async ([cid, name, patch]) => {
    const repo = window.kubus.repo;
    const view = (await repo.listViews(cid, "default")).find((v) => v.name === name);
    await repo.saveView({ ...view, ...patch });
  }, [ids.collections[key], name, patch]);
  await t.open(`${t.listPath(ids.collections[key])}?view=${ids.views[`${key}/${name}`]}`);
}
const periodRule = (ids, value, fieldKey = "pub") => ({ id: "fb-r", fieldId: ids.fields[`books.${fieldKey}`], operator: "between", value });
/** Opens a page of the Both view (the bar on, two blocks) with this period stored (none: no filter). */
async function openBoth(t, ids, value) {
  await changeView(t, ids, "Both", { filters: value ? [periodRule(ids, value)] : [] });
}
const saveView = async (t) => {
  await toolbarOf(t).getByRole("button", { name: "Save changes to view" }).click();
  await t.settle(200);
};
/** Picks a kind in the bar's dropdown. */
async function pickKind(t, name) {
  await kindBox(t).locator("button").first().click();
  await t.page.getByRole("option", { name, exact: true }).click();
  await t.settle(100);
}
/** Where the bar and its controls are: the buttons must not move while it is stepped. */
const boxesOf = (t) =>
  barOf(t).evaluate((bar) => [bar, ...bar.querySelectorAll("button")].map((e) => {
    const r = e.getBoundingClientRect();
    return [Math.round(r.left * 10) / 10, Math.round(r.top * 10) / 10, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10];
  }));
const movedBy = (a, b) => (a.length !== b.length ? "different controls" : a.map((x, i) => x.map((v, k) => Math.abs(v - b[i][k]))).flat().some((d) => d > 1));
const WORDS = { day: ["Today", "Yesterday", "Tomorrow", "days"], week: ["This week", "Last week", "Next week", "weeks"], month: ["This month", "Last month", "Next month", "months"], year: ["This year", "Last year", "Next year", "years"] };

const bookPath = (t, ids, view = "All") => `${t.listPath(ids.collections.books)}${view === "All" ? "" : `?view=${ids.views[`books/${view}`]}`}`;

// --- the setting ------------------------------------------------------------------------------------

test("Show filter bar: stored with the view, kept after a reload, the Filter button moves onto the bar @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(barSpec());
  await t.open(bookPath(t, ids));
  await t.check("no bar by default, the Filter button is in the views bar", (await barOf(t).count()) === 0 && (await toolbarOf(t).getByRole("button", { name: FILTER }).count()) === 1);
  await t.openPanel(toolbarOf(t), "View settings");
  const box = toolbarPanel(t).getByRole("checkbox", { name: "Show filter bar" });
  await t.check("View settings offers Show filter bar, off", (await box.count()) === 1 && !(await box.isChecked()));
  await t.popoverStep("tick Show filter bar", () => box.click({ force: true }), { target: box, scope: ".views-bar" });
  await t.until("the bar shows at once", async () => (await barOf(t).count()) === 1);
  await t.check("while the panel is open the Filter button stays in the views bar (the buttons after it don't move)", (await toolbarOf(t).getByRole("button", { name: FILTER }).count()) === 1 && (await barButton(t, "Filter").count()) === 0);
  await t.until("it is stored with the view", async () => (await storedView(t, ids.collections.books)).filterBar === true);
  await t.check("which is not a change to save", (await activeTab(t)) === "All" && (await toolbarOf(t).getByRole("button", { name: "Save changes to view" }).count()) === 0);
  await t.audit("filter bar on, View settings open", { shotOnFail: true });
  await t.escapeCloses("Escape closes View settings");
  await t.until("the Filter button moves onto the bar once the panel is closed", async () => (await barOf(t).getByRole("button", { name: FILTER }).count()) === 1 && (await toolbarOf(t).getByRole("button", { name: FILTER }).count()) === 0);
  await t.check("the bar sits just below the tab strip, the Filter button first on its left edge", await t.page.evaluate(() => {
    const bar = document.querySelector(".ws-pane--active .filter-bar");
    const views = document.querySelector(".ws-pane--active .views-bar");
    const first = bar.querySelector("button");
    return !!bar && views.getBoundingClientRect().bottom <= bar.getBoundingClientRect().top + 1 && bar.getBoundingClientRect().top - views.getBoundingClientRect().bottom < 40 && Math.abs(first.getBoundingClientRect().left - bar.getBoundingClientRect().left) < 1;
  }));
  await t.audit("filter bar, no period", { shotOnFail: true });
  await t.open(bookPath(t, ids));
  await t.check("after a reload the bar and its Filter button are still there", (await barOf(t).count()) === 1 && (await barOf(t).getByRole("button", { name: FILTER }).count()) === 1 && (await toolbarOf(t).getByRole("button", { name: FILTER }).count()) === 0);
  await t.page.getByRole("tab", { name: "Both" }).click();
  await t.until("the Both view (made with the bar) shows its bar too", async () => (await barOf(t).count()) === 1);
  await t.page.getByRole("tab", { name: "All" }).click();
  // Off again: stays while the panel is open, goes (the Filter button back) when it closes.
  await t.openPanel(toolbarOf(t), "View settings");
  const off = toolbarPanel(t).getByRole("checkbox", { name: "Show filter bar" });
  await t.check("the box is ticked", await off.isChecked());
  await t.popoverStep("untick Show filter bar", () => off.click({ force: true }), { target: off, scope: ".views-bar" });
  await t.until("stored off (the key is gone)", async () => (await storedView(t, ids.collections.books)).filterBar === undefined);
  await t.check("the Filter button isn't anywhere twice nor missing while the panel is open", (await barOf(t).getByRole("button", { name: FILTER }).count()) + (await toolbarOf(t).getByRole("button", { name: FILTER }).count()) === 1);
  await t.escapeCloses("Escape closes View settings");
  await t.until("no bar, the Filter button back in the views bar", async () => (await barOf(t).count()) === 0 && (await toolbarOf(t).getByRole("button", { name: FILTER }).count()) === 1);
  await t.open(bookPath(t, ids));
  await t.check("and so after a reload", (await barOf(t).count()) === 0 && (await storedView(t, ids.collections.books)).filterBar === undefined);
}, { viewport: "desktop", smoke: true });

test("the Filter button on the bar: grey while open, blue with rules, the same panel @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(barSpec());
  await openBoth(t, ids, null);
  const button = () => barOf(t).getByRole("button", { name: FILTER });
  const state = () => button().evaluate((b) => ({ selected: b.classList.contains("cds--btn--selected") || b.getAttribute("aria-pressed") === "true", active: b.getAttribute("data-active") === "true", open: b.getAttribute("aria-expanded") === "true" }));
  await t.check("not selected, not blue, labelled Filter", JSON.stringify(await state()) === JSON.stringify({ selected: false, active: false, open: false }));
  await button().click();
  await t.settle(150);
  let s = await state();
  await t.check("open: grey (selected), expanded, the filter panel is shown", s.selected && s.open && !s.active && (await toolbarPanel(t).getByRole("button", { name: "Add filter" }).count()) === 1);
  await t.audit("Filter panel open from the bar", { shotOnFail: true });
  // A rule: Title contains "a".
  await toolbarPanel(t).getByRole("button", { name: "Add filter" }).click();
  await t.settle(100);
  const rule = toolbarPanel(t).locator(".query-editor__rule").last();
  await rule.getByLabel("Field", { exact: true }).selectOption({ label: "Title" });
  await rule.getByLabel("Condition", { exact: true }).selectOption({ label: "contains" });
  await rule.getByLabel("Value", { exact: true }).fill("lie");
  await t.settle(150);
  await expectRows(t, "Title contains lie: Charlie, Juliet in the table", ["Charlie", "Juliet"]);
  await expectRows(t, "and in the cards", ["Charlie", "Juliet"], 1);
  await t.escapeCloses("Escape closes the panel opened from the bar");
  s = await state();
  await t.check("closed with a rule: blue, no longer selected, counted in its label", !s.open && !s.selected && s.active && (await barOf(t).getByRole("button", { name: "Filter (1)", exact: true }).count()) === 1);
  await t.check("the view is changed (*) and Save appears", (await activeTab(t)) === "Both *" && (await toolbarOf(t).getByRole("button", { name: "Save changes to view" }).count()) === 1);
  await saveView(t);
  const stored = await storedView(t, ids.collections.books, "Both");
  await t.check("Save stores the rule with the view", stored.filters.length === 1 && stored.filters[0].operator === "contains" && stored.filters[0].value === "lie", JSON.stringify(stored.filters));
  await t.check("the star is gone", (await activeTab(t)) === "Both");
}, { viewport: "desktop" });

// --- the period -------------------------------------------------------------------------------------

test("no period yet: Any date, the buttons off; a kind creates the period on the first date field @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(barSpec());
  await openBoth(t, ids, null);
  await t.check("Any date, the kind switch empty", (await labelOf(t)) === "Any date" && (await kindShown(t)) === "Period");
  await t.check("‹ › and this-one are off", (await barButton(t, "Previous").isDisabled()) && (await barButton(t, "Next").isDisabled()) && (await barButton(t, "Most recent").isDisabled()));
  await expectRows(t, "everything", TITLES);
  await t.check("the kinds are Hour, Day, Week, Month, Year (no Range)", await (async () => {
    await kindBox(t).locator("button").first().click();
    const options = await t.page.getByRole("option").allInnerTexts();
    await t.audit("kind switch open", { shotOnFail: true });
    await t.page.keyboard.press("Escape");
    await t.settle(100);
    return JSON.stringify(options) === JSON.stringify(["Hour", "Day", "Week", "Month", "Year"]);
  })());
  await pickKind(t, "Month");
  await expectRows(t, "this month", inPeriod("month", 0));
  await expectRows(t, "this month in the cards too", inPeriod("month", 0), 1);
  await t.check("labelled as the filter panel's line, the switch says Month", (await labelOf(t)).startsWith("This month · ") && (await labelOf(t)).endsWith(monthName(periodDays("month")[0])) && (await kindShown(t)) === "Month", await labelOf(t));
  await t.check("the view is changed (*), nothing stored yet", (await activeTab(t)) === "Both *" && (await storedView(t, ids.collections.books, "Both")).filters.length === 0);
  const barText = await labelOf(t);
  await t.openPanel(barOf(t), "Filter (1)");
  const panel = toolbarPanel(t).locator(".date-period");
  await t.check("the filter panel shows the same period line, by Published", (await panel.locator(".date-period__label").innerText()).trim() === barText && (await panel.getByLabel("by", { exact: true }).locator("option:checked").innerText()) === "Published" && (await panel.getByRole("tab", { name: "Month" }).getAttribute("aria-selected")) === "true");
  await t.escapeCloses("Escape closes the filter panel");
  await saveView(t);
  const stored = (await storedView(t, ids.collections.books, "Both")).filters;
  await t.check("Save stores one between rule, month+0, on Published", stored.length === 1 && stored[0].operator === "between" && stored[0].value === "month+0" && stored[0].fieldId === ids.fields["books.pub"], JSON.stringify(stored));
  // The kinds, one after the other from Any date.
  for (const [kind, value] of [["Hour", "hour+0"], ["Day", "day+0"], ["Week", "week+0"], ["Year", "year+0"]]) {
    await changeView(t, ids, "Both", { filters: [] });
    await pickKind(t, kind);
    await saveView(t);
    const rule = (await storedView(t, ids.collections.books, "Both")).filters[0];
    await t.check(`${kind} from Any date is stored as ${value}`, rule && rule.value === value, JSON.stringify(rule));
    if (kind !== "Hour") await expectRows(t, kind, inPeriod(kind.toLowerCase(), 0));
  }
  // No date field in the collection: the period goes by Updated.
  await t.open(`${t.listPath(ids.collections.notes)}`);
  await t.check("a collection without a date field starts at Any date as well", (await labelOf(t)) === "Any date");
  await pickKind(t, "Week");
  await expectRows(t, "the notes, updated this week", ["One", "Two"]);
  await saveView(t);
  const note = (await storedView(t, ids.collections.notes)).filters[0];
  await t.check("stored on Updated", note.fieldId === "$updated" && note.value === "week+0", JSON.stringify(note));
}, { viewport: "desktop", smoke: true });

test("‹ › step a rolling period (this day … year): rows, label, unsaved *, Save stores it, Discard restores it @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(barSpec());
  for (const kind of ["day", "week", "month", "year"]) {
    const [cur, last, next, unit] = WORDS[kind];
    await openBoth(t, ids, `${kind}+0`);
    await t.check(`${cur}: labelled, the switch says ${kind}, view unchanged`, (await labelOf(t)).startsWith(cur) && (await kindShown(t)).toLowerCase() === kind && (await activeTab(t)) === "Both", await labelOf(t));
    await expectRows(t, cur, inPeriod(kind, 0));
    const step = async (button, offset, text) => {
      await barButton(t, button).click();
      await t.settle(100);
      await expectRows(t, `${kind} ${offset >= 0 ? "+" : ""}${offset}`, inPeriod(kind, offset));
      await expectRows(t, `${kind} ${offset} cards`, inPeriod(kind, offset), 1);
      await t.check(`${kind} ${offset}: labelled "${text}"`, (await labelOf(t)).startsWith(text), await labelOf(t));
      // Back at this week (month, …) is the view as saved.
      await t.check(`${kind} ${offset}: the tab says ${offset === 0 ? "unchanged" : "changed"}`, (await activeTab(t)) === (offset === 0 ? "Both" : "Both *"));
    };
    await step("Previous", -1, last);
    await step("Previous", -2, `2 ${unit} ago`);
    await step("Next", -1, last);
    await step("Next", 0, cur);
    await step("Next", 1, next);
    await step("Next", 2, `In 2 ${unit}`);
    // Back one: stored as a rolling value, not as days.
    await step("Previous", 1, next);
    await saveView(t);
    const value = (await storedView(t, ids.collections.books, "Both")).filters[0].value;
    await t.check(`${kind}: Save stores ${kind}+1, still rolling`, value === `${kind}+1`, value);
    await t.check(`${kind}: no longer changed`, (await activeTab(t)) === "Both");
    // Discard: step, then open another view and come back.
    await barButton(t, "Next").click();
    await t.settle(100);
    await t.check(`${kind}: stepped again, changed`, (await activeTab(t)) === "Both *");
    await t.page.getByRole("tab", { name: "All" }).click();
    await t.settle(100);
    await t.page.getByRole("tab", { name: /^Both/ }).click();
    await t.settle(150);
    await t.check(`${kind}: the view is back as saved (${next})`, (await labelOf(t)).startsWith(next) && (await activeTab(t)) === "Both", await labelOf(t));
    await expectRows(t, `${kind}: discarded`, inPeriod(kind, 1));
  }
  await t.audit("a rolling period on the bar", { shotOnFail: true });
}, { viewport: "desktop", smoke: true });

test("‹ › step a chosen period by its kind, a range by its length @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(barSpec());
  for (const kind of ["day", "week", "month", "year"]) {
    const [first, last] = periodDays(kind, -1);
    await openBoth(t, ids, `${first}..${last}`);
    await t.check(`a chosen ${kind}: not a rolling one, the switch says ${kind}`, (await kindShown(t)).toLowerCase() === kind && !/^(Last|This|Today|Yesterday)/.test(await labelOf(t)), await labelOf(t));
    await expectRows(t, `${kind} -1`, inPeriod(kind, -1));
    const panelLine = async () => {
      await t.openPanel(barOf(t), FILTER);
      const text = (await toolbarPanel(t).locator(".date-period__label").innerText()).trim();
      await t.escapeCloses("closes");
      return text;
    };
    for (const [button, offset] of [["Previous", -2], ["Previous", -3], ["Next", -2], ["Next", -1], ["Next", 0]]) {
      await barButton(t, button).click();
      await t.settle(100);
      await expectRows(t, `${kind} ${offset}`, inPeriod(kind, offset));
      await t.check(`${kind} ${offset}: the label is the same as in the filter panel`, (await labelOf(t)) === (await panelLine()), await labelOf(t));
    }
    await saveView(t);
    const [f, l] = periodDays(kind, 0);
    const value = (await storedView(t, ids.collections.books, "Both")).filters[0].value;
    await t.check(`${kind}: stored as the chosen days ${f}..${l}`, value === `${f}..${l}`, value);
  }
  await t.check("a month is named by its month and year", (await (async () => { await openBoth(t, ids, periodDays("month", -2).join("..")); return (await labelOf(t)) === monthName(periodDays("month", -2)[0]); })()));
  // A range of ten days steps by ten days (no kind of its own: the switch is empty).
  const a = dayStr(-25);
  const b = dayStr(-16);
  await openBoth(t, ids, `${a}..${b}`);
  await t.check("a range has no kind in the switch, no most recent", (await kindShown(t)) === "Period" && (await barButton(t, "Most recent").isDisabled()));
  await expectRows(t, "the range", inDays(a, b));
  await barButton(t, "Next").click();
  await expectRows(t, "the ten days after", inDays(dayStr(-15), dayStr(-6)));
  await barButton(t, "Previous").click();
  await barButton(t, "Previous").click();
  await expectRows(t, "the ten days before", inDays(dayStr(-35), dayStr(-26)));
  await t.audit("a range on the bar", { shotOnFail: true });
}, { viewport: "desktop" });

test("the kind switch keeps the period anchored, as the filter panel does @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(barSpec());
  const valueNow = async () => {
    await saveView(t);
    return (await storedView(t, ids.collections.books, "Both")).filters[0].value;
  };
  // [stored period to start from, kind picked, value stored, label start]
  const CASES = [
    ["week-1", "Month", "month+0", "This month"],
    ["month-2", "Year", "year+0", "This year"],
    ["day+0", "Hour", "hour+0", "This hour"],
    [periodDays("month", -1).join(".."), "Year", `${periodDays("year", 0)[0]}..${periodDays("year", 0)[1]}`, `${new Date().getFullYear()}`],
    [periodDays("month", -1).join(".."), "Day", `${periodDays("month", -1)[0]}..${periodDays("month", -1)[0]}`, ""],
    [periodDays("week", -2).join(".."), "Month", null, ""],
    ["day-6..day+0", "Month", "month-11..month+0", "Last 12 months"],
    ["day-6..day+0", "Week", "week-3..week+0", "Last 4 weeks"],
    ["year+0..day+0", "Month", "month+0..day+0", "Month to date"],
    ["year+0..day+0", "Day", "day+0", "Today"],
  ];
  for (const [from, kind, value, text] of CASES) {
    await openBoth(t, ids, from);
    await pickKind(t, kind);
    const stored = await valueNow();
    await t.check(`${from} → ${kind}: ${stored}`, value === null ? /^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/.test(stored) : stored === value, `expected ${value}`);
    await t.check(`${from} → ${kind}: the switch says ${kind}`, (await kindShown(t)) === kind, await kindShown(t));
    if (text) await t.check(`${from} → ${kind}: labelled ${text}`, (await labelOf(t)).startsWith(text), await labelOf(t));
    const days = stored.includes("..") && !stored.includes("+") ? stored.split("..") : null;
    if (days) await expectRows(t, `${from} → ${kind}: the rows of ${stored}`, inDays(days[0], days[1]));
  }
  await openBoth(t, ids, periodDays("week", -2).join(".."));
  await pickKind(t, "Month");
  const [first] = periodDays("week", -2);
  const month = await valueNow();
  const around = new Date(`${first}T12:00:00`);
  const expectMonth = `${ymd(new Date(around.getFullYear(), around.getMonth(), 1))}..${ymd(new Date(around.getFullYear(), around.getMonth() + 1, 0))}`;
  await t.check("a chosen week → Month: the month around its first day", month === expectMonth, `${month} vs ${expectMonth}`);
  // The kind it already is: choosing it again changes nothing, as with the panel's switcher.
  await openBoth(t, ids, "month-1");
  await pickKind(t, "Month");
  await t.check("the kind it already is changes nothing", (await activeTab(t)) === "Both" && (await labelOf(t)).startsWith("Last month"), await labelOf(t));
}, { viewport: "desktop" });

test("the most recent button jumps to this hour / day / week / month / year as a rolling period @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(barSpec());
  const CASES = [
    [periodDays("week", -3).join(".."), "This week", "week+0", "week"],
    [periodDays("month", -5).join(".."), "This month", "month+0", "month"],
    [periodDays("year", -2).join(".."), "This year", "year+0", "year"],
    [periodDays("day", -9).join(".."), "Today", "day+0", "day"],
    ["month-3", "This month", "month+0", "month"],
    ["week+4", "This week", "week+0", "week"],
    ["day-6..day+0", "Today", "day+0", "day"],
    ["year+0..day+0", "This year", "year+0", "year"],
  ];
  for (const [from, name, value, kind] of CASES) {
    await openBoth(t, ids, from);
    await t.check(`${from}: the button is named ${name}`, (await barButton(t, name).count()) === 1 && !(await barButton(t, name).isDisabled()));
    await barButton(t, name).click();
    await t.settle(100);
    await expectRows(t, `${from} → ${name}`, inPeriod(kind, 0));
    await t.check(`${from} → ${name}: labelled, changed`, (await labelOf(t)).startsWith(name) && (await activeTab(t)) === "Both *", await labelOf(t));
    await saveView(t);
    const stored = (await storedView(t, ids.collections.books, "Both")).filters[0].value;
    await t.check(`${from} → ${name}: stored as the rolling ${value}, not as days`, stored === value, stored);
  }
  await openBoth(t, ids, null);
  await pickKind(t, "Hour");
  await t.check("the hour's button is This hour", (await barButton(t, "This hour").count()) === 1);
  await barButton(t, "Previous").click();
  await t.check("an hour back is Last hour", (await labelOf(t)).startsWith("Last hour"));
  await barButton(t, "This hour").click();
  await t.check("and This hour jumps back", (await labelOf(t)).startsWith("This hour"));
  await t.audit("most recent", { shotOnFail: true });
}, { viewport: "desktop" });

test("periods up to now (last n, so far) have nothing before or after; the bar says so @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(barSpec());
  const [yFirst] = periodDays("year", 0);
  const CASES = [
    ["day-6..day+0", "Last 7 days", inDays(dayStr(-6), dayStr(0)), "Today", "Day"],
    ["day-29..day+0", "Last 30 days", inDays(dayStr(-29), dayStr(0)), "Today", "Day"],
    ["month-11..month+0", "Last 12 months", inDays(periodDays("month", -11)[0], periodDays("month", 0)[1]), "This month", "Month"],
    ["year+0..day+0", "Year to date", inDays(yFirst, dayStr(0)), "This year", "Year"],
    ["month+0..day+0", "Month to date", inDays(periodDays("month")[0], dayStr(0)), "This month", "Month"],
  ];
  for (const [value, text, rows, latest, kind] of CASES) {
    await openBoth(t, ids, value);
    await expectRows(t, text, rows);
    await t.check(`${text}: labelled, ‹ › off, most recent is ${latest}, the switch says ${kind}`, (await labelOf(t)).startsWith(text) && (await barButton(t, "Previous").isDisabled()) && (await barButton(t, "Next").isDisabled()) && !(await barButton(t, latest).isDisabled()) && (await kindShown(t)) === kind, await labelOf(t));
  }
  await t.audit("Year to date on the bar", { shotOnFail: true });
}, { viewport: "desktop" });

test("every change from the bar is an edit of the view's filter: * on the tab, Save, Discard; other rules stay @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(barSpec());
  const rules = [{ id: "fb-t", fieldId: ids.fields["books.title"], operator: "contains", value: "o" }, periodRule(ids, "month+0")];
  await changeView(t, ids, "Both", { filters: rules });
  await expectRows(t, "o in the title, this month", inPeriod("month", 0).filter((x) => x.toLowerCase().includes("o")));
  await t.check("not changed to start with", (await activeTab(t)) === "Both" && (await toolbarOf(t).getByRole("button", { name: "Save changes to view" }).count()) === 0);
  await barButton(t, "Previous").click();
  await t.settle(100);
  await expectRows(t, "last month still narrowed by the other rule", inPeriod("month", -1).filter((x) => x.toLowerCase().includes("o")));
  await t.check("changed: * and Save", (await activeTab(t)) === "Both *" && (await toolbarOf(t).getByRole("button", { name: "Save changes to view" }).count()) === 1);
  await t.check("nothing is stored before Save", (await storedView(t, ids.collections.books, "Both")).filters[1].value === "month+0");
  await t.openPanel(barOf(t), "Filter (2)");
  await t.check("the filter panel lists the other rule only, the period in its date line (the same text)", (await toolbarPanel(t).locator(".query-editor__rule").count()) === 1 && (await toolbarPanel(t).locator(".date-period__label").innerText()).trim() === (await labelOf(t)));
  // Edited in the panel: the bar follows.
  await toolbarPanel(t).locator(".date-period").getByRole("button", { name: "Previous", exact: true }).click();
  await t.settle(100);
  await t.check("a step in the panel shows on the bar", (await labelOf(t)).startsWith("2 months ago"), await labelOf(t));
  await t.escapeCloses("closes");
  await expectRows(t, "two months back, narrowed", inPeriod("month", -2).filter((x) => x.toLowerCase().includes("o")));
  await saveView(t);
  const stored = (await storedView(t, ids.collections.books, "Both")).filters;
  await t.check("Save stores both rules, the period where it was", stored.length === 2 && stored[0].value === "o" && stored[1].value === "month-2", JSON.stringify(stored));
  await t.open(bookPath(t, ids, "Both"));
  await t.check("after a reload, as saved", (await labelOf(t)).startsWith("2 months ago") && (await activeTab(t)) === "Both");
}, { viewport: "desktop" });

test("every block of the view follows the period; a block's own filter narrows it further @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(barSpec());
  await openBoth(t, ids, "week+0");
  await expectRows(t, "table: this week", inPeriod("week", 0));
  await expectRows(t, "cards: this week", inPeriod("week", 0), 1);
  for (const [button, offset] of [["Previous", -1], ["Previous", -2], ["Next", -1]]) {
    await barButton(t, button).click();
    await t.settle(100);
    await expectRows(t, `table ${offset}`, inPeriod("week", offset));
    await expectRows(t, `cards ${offset}`, inPeriod("week", offset), 1);
  }
  await pickKind(t, "Year");
  await expectRows(t, "table: Year", inPeriod("year", 0));
  await expectRows(t, "cards: Year", inPeriod("year", 0), 1);
  // A block with a filter of its own: the period frames it.
  const own = [{ id: "fb-own", fieldId: ids.fields["books.title"], operator: "contains", value: "o" }];
  await t.page.evaluate(async ([cid, own]) => {
    const repo = window.kubus.repo;
    const view = (await repo.listViews(cid, "default")).find((v) => v.name === "Both");
    await repo.saveView({ ...view, filters: [{ id: "fb-r", fieldId: view.filters[0]?.fieldId ?? "$updated", operator: "between", value: "year+0" }], blocks: view.blocks.map((b, i) => (i === 1 ? { ...b, filters: own } : b)) });
  }, [ids.collections.books, own]);
  await t.open(bookPath(t, ids, "Both"));
  await expectRows(t, "table: the period only", inPeriod("year", 0));
  await expectRows(t, "cards: the period and its own filter", inPeriod("year", 0).filter((x) => x.toLowerCase().includes("o")), 1);
  await barButton(t, "Previous").click();
  await t.settle(100);
  await expectRows(t, "table: last year", inPeriod("year", -1));
  await expectRows(t, "cards: last year, narrowed", inPeriod("year", -1).filter((x) => x.toLowerCase().includes("o")), 1);
}, { viewport: "desktop" });

// --- layout ---------------------------------------------------------------------------------------------

// Window sizes: the bar is one row without horizontal scroll, the buttons stay put while stepping.
for (const vp of ["phone-small", "phone", "tablet", "laptop", "desktop"]) {
  test(`the bar fits in one row and nothing moves while ‹ › step it @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(barSpec());
    await openBoth(t, ids, "week+0");
    const fits = async (label) => {
      const m = await t.page.evaluate(() => {
        const bar = document.querySelector(".ws-pane--active .filter-bar");
        const body = document.querySelector(".ws-pane--active .ws-pane__body");
        const pane = body.getBoundingClientRect();
        const label = bar.querySelector(".filter-bar__label");
        const r = bar.getBoundingClientRect();
        const centres = [...bar.children].map((c) => { const b = c.getBoundingClientRect(); return b.top + b.height / 2; });
        const rows = { size: Math.max(...centres) - Math.min(...centres) <= 2 ? 1 : 2 };
        return {
          height: Math.round(r.height), rows: rows.size, scrollsSideways: body.scrollWidth > body.clientWidth + 1 || bar.scrollWidth > bar.clientWidth + 1,
          inside: [...bar.querySelectorAll("button")].every((b) => b.getBoundingClientRect().left >= pane.left - 1 && b.getBoundingClientRect().right <= pane.right + 1),
          labelWidth: Math.round(label.getBoundingClientRect().width), clipped: [...label.children].some((c) => c.scrollWidth > c.clientWidth + 1), title: label.getAttribute("title"), text: label.textContent.trim(),
          small: [...bar.querySelectorAll("button")].every((b) => b.getBoundingClientRect().height >= 24 && b.getBoundingClientRect().height <= 32),
        };
      });
      await t.check(`${label}: one row (${m.height}px), nothing sideways, all inside the pane`, m.height <= 40 && m.rows === 1 && !m.scrollsSideways && m.inside, JSON.stringify(m));
      await t.check(`${label}: the label (${m.labelWidth}px) is whole or ellipsized with its text as the tooltip`, !m.clipped || m.title === m.text, JSON.stringify(m));
      await t.check(`${label}: compact buttons`, m.small, JSON.stringify(m));
      return m;
    };
    const first = await fits("this week");
    await t.audit("this week", { shotOnFail: true });
    // ‹ › repeatedly: the buttons and the bar stay where they are, from the first step (the view turns changed) on.
    const before = await boxesOf(t);
    let wide = first;
    for (let i = 0; i < 6; i++) {
      await barButton(t, i < 3 ? "Previous" : "Next").click();
      await t.settle(60);
      const now = await boxesOf(t);
      if (movedBy(before, now)) await t.check(`step ${i + 1}: the buttons and the bar stay where they were`, false, JSON.stringify([before, now]));
      wide = await fits(`step ${i + 1}`);
    }
    await t.check("six steps: the buttons and the bar never moved", !movedBy(before, await boxesOf(t)));
    await t.noShift("one more step: nothing in the bar moves", () => barButton(t, "Next").click(), { scope: ".filter-bar", except: [".filter-bar__label"] });
    // The longest label: a last-n period, its words and days.
    await openBoth(t, ids, "day-6..day+0");
    const long = await fits("last 7 days");
    await t.check("Last 7 days is readable whole somewhere (label or tooltip)", long.title === long.text && long.text.startsWith("Last 7 days"), long.text);
    await t.audit("last 7 days", { shotOnFail: true });
    // The kind switch and the filter panel from the bar, audited open.
    await kindBox(t).locator("button").first().click();
    await t.settle(150);
    await t.audit("kind switch open", { shotOnFail: true });
    await t.check("its options are all inside the window", await t.page.evaluate(() => [...document.querySelectorAll("[role=option]")].every((o) => { const r = o.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })));
    await t.escapeCloses("Escape closes the kind switch");
    await t.openPanel(barOf(t), FILTER);
    await t.audit("Filter panel open from the bar", { shotOnFail: true });
    await t.check("the panel is inside the window", await t.page.evaluate(() => { const r = document.querySelector(".toolbar-popover__panel").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1; }));
    await t.escapeCloses("Escape closes the panel");
  }, { viewport: vp, smoke: vp === "phone" });
}

test("the bar in the dark theme, and from the keyboard @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(barSpec());
  await openBoth(t, ids, "month-1");
  await t.audit("bar, dark", { shotOnFail: true });
  // Tab to ‹ and press it: the period before.
  await barButton(t, "Previous").focus();
  await t.page.keyboard.press("Enter");
  await t.settle(100);
  await expectRows(t, "two months back", inPeriod("month", -2));
  await t.check("the button keeps focus and its place", await barButton(t, "Previous").evaluate((b) => document.activeElement === b));
  await t.page.keyboard.press("Enter");
  await t.settle(100);
  await expectRows(t, "three months back", inPeriod("month", -3));
  // The kind switch with the arrow keys.
  const combo = kindBox(t).locator("button").first();
  await combo.focus();
  await t.page.keyboard.press("Enter");
  await t.settle(100);
  await t.audit("kind switch open, dark", { shotOnFail: true });
  await t.page.keyboard.press("ArrowDown");
  await t.page.keyboard.press("Enter");
  await t.settle(150);
  await t.check("a kind chosen with the keys", (await kindShown(t)) !== "Period" && (await activeTab(t)) === "Both *", await kindShown(t));
}, { viewport: "desktop", dark: true });
