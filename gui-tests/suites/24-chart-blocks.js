// Chart blocks: every chart kind (bar, line, area, radar, pie, meter, treemap, word cloud, gauge, stat,
// histogram, box plot, scatter, heatmap) and every setting of it, used through the Block settings
// panel of a chart block. Each setting is followed by what it does to the drawing (Carbon Charts'
// svg read back by `facts`: bars, lines, dots, slices, ticks, legend, thresholds, sizes), then what
// was stored (window.kubus.repo: a block's settings are stored as they are changed) and what is
// drawn after a reload.

const PANE = ".ws-pane--active";

/** Weigh-ins, one every 6 days from 2025-01-01: a date, a datetime, a Phase (some without), numbers (some without a Weight). */
const PHASES = ["Cut", "Bulk", "Maintain"];
const WEIGH_INS = Array.from({ length: 36 }, (_, i) => {
  const day = new Date(Date.UTC(2025, 0, 1 + i * 6));
  const values = {
    name: `Weigh-in ${i + 1}`,
    date: day.toISOString().slice(0, 10),
    moment: new Date(day.getTime() + (i % 5) * 3600000).toISOString(),
    weight: Math.round((82 - i * 0.2 + (i % 4)) * 10) / 10,
    fat: Math.round((20 - i * 0.1) * 10) / 10,
    muscle: 38 + (i % 6),
    bone: 3 + (i % 3) / 10,
    goal: 75,
  };
  if (i % 7 !== 3) values.phase = PHASES[i % 3];
  if (i % 9 === 4) delete values.weight;
  return { key: `w${i}`, values };
});

/** A chart block's series, as stored (the fields as "@key"). */
const S = (id, value, field, extra = {}) => ({ id, value, field, label: "", style: null, axis: "left", transform: "none", window: 3, ...extra });
const BY_PHASE = { by: "field", field: "@phase" };
/** Settings that give every chart kind something to draw. */
const RICH = { chart: "bar", x: BY_PHASE, series: [S("a", "sum", "@weight")], fields: ["@fat", "@muscle", "@bone"], spreadField: "@weight" };

/** The data set: one collection "Weigh-in", one view "Chart" with a chart block per entry of `blocks` ({ title?, options, filters? }). */
function chartSpec(blocks = [{ options: RICH }], extra = {}) {
  return {
    collections: [{
      key: "w", name: "Weigh-in", plural: "Weigh-ins", icon: "Cube",
      fields: [
        { key: "name", name: "Name", kind: "string" },
        { key: "date", name: "Day", kind: "date" },
        { key: "moment", name: "Moment", kind: "datetime" },
        { key: "phase", name: "Phase", kind: "string" },
        { key: "weight", name: "Weight", kind: "number" },
        { key: "fat", name: "Fat", kind: "number" },
        { key: "muscle", name: "Muscle", kind: "number" },
        { key: "bone", name: "Bone", kind: "number" },
        { key: "goal", name: "Goal", kind: "number" },
      ],
      items: WEIGH_INS,
      views: [{ name: "Chart", blocks: blocks.map((b) => ({ kind: "chart", ...b })) }],
      ...extra,
    }],
  };
}

async function seeded(t, blocks, extra) {
  await t.boot();
  const ids = await t.seed(chartSpec(blocks, extra));
  await t.open(t.listPath(ids.collections.w));
  await waitDrawn(t);
  return ids;
}

const blockAt = (t, i = 0) => t.page.locator(`${PANE} .block`).nth(i);
const PANEL = ".toolbar-popover.cds--popover--open";

/** Waits until block `i` shows a chart, a stat or a message (Carbon Charts load on first use). */
async function waitDrawn(t, i = 0) {
  await t.until(`block ${i + 1} is drawn`, () => t.page.evaluate((i) => {
    const b = document.querySelectorAll(".ws-pane--active .block")[i];
    return !!b && !!b.querySelector(".chart-block svg, .stat-block, .chart-block__problem");
  }, i), { timeout: 15000 });
  await t.settle(300);
}

/** Opens block `i`'s Block settings; returns the panel. */
async function openSettings(t, i = 0) {
  if (!(await t.count(PANEL))) await t.openPanel(blockAt(t, i).locator(".section-header").first(), "Block settings");
  return t.page.locator(PANEL).first();
}

/** Opens an accordion section of the panel (once); returns its heading. */
async function section(panel, title) {
  const head = panel.locator("button.cds--accordion__heading", { has: panel.page().locator(".cds--accordion__title", { hasText: new RegExp(`^${title}$`) }) }).first();
  if ((await head.getAttribute("aria-expanded")) !== "true") {
    await head.click();
    await panel.page().waitForTimeout(150);
  }
  return head;
}

/** Picks the option `text` of the select labelled `label` in a section (`nth`: when several rows have one). */
async function choose(t, panel, sectionTitle, label, text, nth = 0) {
  t.at(`${label}: ${text}`);
  if (sectionTitle) await section(panel, sectionTitle);
  await panel.getByLabel(label, { exact: true }).nth(nth).selectOption({ label: text }, { timeout: 5000 });
  await t.page.waitForTimeout(100);
}

/** Types into the text / number input labelled `label`. */
async function fill(t, panel, sectionTitle, label, text, nth = 0) {
  t.at(`${label}: ${text}`);
  if (sectionTitle) await section(panel, sectionTitle);
  const input = panel.getByLabel(label, { exact: true }).nth(nth);
  await input.fill(String(text));
  await t.page.waitForTimeout(100);
}

/** Sets a checkbox (clicks its label when it isn't as wanted). */
async function tick(t, panel, sectionTitle, label, on = true) {
  t.at(`${label}: ${on ? "on" : "off"}`);
  if (sectionTitle) await section(panel, sectionTitle);
  const box = panel.getByRole("checkbox", { name: label, exact: true });
  if ((await box.isChecked()) !== on) await panel.locator("label.cds--checkbox-label", { hasText: label }).first().click();
  await t.page.waitForTimeout(100);
}

/**
 * Moves the thumb of the slider labelled `label` to its minimum or maximum (dragged past the end
 * of its track), or one step on ("+1": a single arrow key; Carbon's sliders in a popover lose the
 * page to "Maximum update depth exceeded" with keys pressed in quick succession, as a held key does).
 */
async function slide(t, panel, label, where) {
  t.at(`${label} slider: ${where}`);
  await section(panel, "Size");
  const item = panel.locator(".cds--form-item", { has: panel.page().locator(`label:text-is("${label}")`) });
  const thumb = item.locator(".cds--slider__thumb").first();
  if (where === "+1") {
    await thumb.focus();
    await t.page.keyboard.press("ArrowRight");
  } else {
    // A drag past the track's end is not always taken (the thumb is read again while the panel settles): until the thumb is at the end.
    const end = where === "min" ? "aria-valuemin" : "aria-valuemax";
    for (let attempt = 0; attempt < 4; attempt++) {
      await thumb.scrollIntoViewIfNeeded();
      const at = await thumb.boundingBox();
      const track = await item.locator(".cds--slider__track").first().boundingBox();
      const y = at.y + at.height / 2;
      await t.page.mouse.move(at.x + at.width / 2, y);
      await t.page.mouse.down();
      await t.page.mouse.move(where === "min" ? track.x - 8 : track.x + track.width + 8, y, { steps: 4 });
      await t.page.mouse.up();
      await t.page.waitForTimeout(250);
      if ((await thumb.getAttribute("aria-valuenow")) === (await thumb.getAttribute(end))) break;
    }
  }
  await t.page.waitForTimeout(250);
}

/** The titles of the panel's sections and the labels of every control in them (all sections opened, then closed again). */
async function controls(panel) {
  return panel.evaluate(async (root) => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const heads = [...root.querySelectorAll("button.cds--accordion__heading")];
    const closed = heads.filter((h) => h.getAttribute("aria-expanded") !== "true");
    closed.forEach((h) => h.click());
    await frame();
    const seen = (el) => el.getClientRects().length > 0;
    const labels = [...root.querySelectorAll("label")].filter(seen).map((l) => l.textContent.trim().replace(/Total items selected.*$/, ""));
    const sections = heads.map((h) => h.querySelector(".cds--accordion__title").textContent.trim());
    closed.forEach((h) => h.click());
    await frame();
    return { sections, labels };
  });
}

/** What block `i` draws, read from its svg and text. */
const facts = (t, i = 0) =>
  t.page.evaluate((i) => {
    const b = document.querySelectorAll(".ws-pane--active .block")[i];
    const root = b.querySelector(".chart-block, .stat-block, .chart-block__problem");
    if (!root) return { kind: "none" };
    const all = (s) => [...root.querySelectorAll(s)];
    const n = (s) => root.querySelectorAll(s).length;
    const cc = new Set();
    root.querySelectorAll("[class*='cds--cc--']").forEach((e) => e.classList.forEach((c) => c.startsWith("cds--cc--") && cc.add(c.slice(9))));
    const holder = root.querySelector(".cds--chart-holder");
    const rect = (el) => (el ? el.getBoundingClientRect() : null);
    const text = (s) => all(s).map((e) => e.textContent.trim());
    const uniq = (list) => list.filter((v, i) => list.indexOf(v) === i);
    return {
      kind: root.classList.contains("stat-block") ? "stat" : root.classList.contains("chart-block__problem") ? "problem" : "chart",
      problem: root.classList.contains("chart-block__problem") ? root.textContent.trim() : "",
      cc: [...cc],
      bars: n("path.bar"),
      barFills: new Set(all("path.bar").map((e) => e.getAttribute("class").replace(/ ?bar ?/, ""))).size,
      lines: n("path.line"),
      dots: n("circle.dot"),
      areas: n("path.area"),
      slices: n("path.slice"),
      arcs: n("path.arc-foreground"),
      boxes: n("path.box"),
      cells: n("rect.heat:not(.heat--1)"),
      leaves: n("rect.leaf"),
      words: n("text.word"),
      meters: n("rect.value"),
      blobs: n("path.blob"),
      deltaArrow: (() => { const a = root.querySelector("polygon"); return a ? `arrow ${a.getAttribute("class") ?? ""}` : ""; })(),
      meterStatus: root.querySelector("rect.value")?.getAttribute("class") ?? "",
      arcD: root.querySelector("path.arc-background")?.getAttribute("d") ?? "",
      thresholdColors: all("line.threshold-line").map((e) => e.getAttribute("style") || e.getAttribute("stroke") || ""),
      thresholds: n("line.threshold-line"),
      // (Carbon draws every tick's text twice: a measuring set.)
      yTicks: uniq(text("g.axis.left g.tick text")),
      xTicks: uniq(text("g.axis.bottom g.tick text")),
      rTicks: uniq(text("g.axis.right g.tick text")),
      axisTitles: text("text.axis-title"),
      lines_: root.innerText.split("\n").map((s) => s.trim()).filter(Boolean),
      legend: text(".legend-item p, .legend-item text").filter(Boolean),
      legendBox: rect(root.querySelector(".cds--cc--legend")),
      holderBox: rect(holder),
      rootBox: rect(root),
      barBoxes: all("path.bar").map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }),
      pathD: all("path.line").map((e) => e.getAttribute("d")),
      svg: !!root.querySelector("svg"),
      tag: root.querySelector(".cds--tag")?.className ?? "",
      tagText: root.querySelector(".cds--tag")?.textContent.trim() ?? "",
    };
  }, i);

/** The stored options of block `i` of the view "Chart". */
const stored = (t, ids, i = 0) =>
  t.page.evaluate(async ([c, i]) => (await window.kubus.repo.listViews(c, "default")).find((v) => v.name === "Chart").blocks[i].options, [ids.collections.w, i]);

/** Waits until the stored options of block `i` satisfy `test` (settings are stored a moment after they are changed). */
const storedWhen = (t, ids, label, test, i = 0) =>
  t.until(label, async () => {
    const o = await stored(t, ids, i);
    return test(o) || JSON.stringify(o, (k, v) => (["id", "left", "right", "field", "fields", "spreadField"].includes(k) ? undefined : v)).slice(0, 1200);
  }, { timeout: 8000 });

/** Waits for facts of block `i` to satisfy `test` (an object of facts to a truthy value or a message). */
const drawn = (t, label, test, i = 0, timeout = 8000) =>
  t.until(label, async () => {
    const f = await facts(t, i);
    const r = test(f);
    if (r) return true;
    const { kind, problem, bars, barFills, lines, dots, areas, slices, boxes, cells, xTicks, yTicks, rTicks, legend, lines_ } = f;
    return JSON.stringify({ kind, problem, bars, barFills, lines, dots, areas, slices, boxes, cells, legend, xTicks, yTicks, rTicks, text: lines_ && lines_.slice(0, 14) }).slice(0, 900);
  }, { timeout });

const KINDS = [
  { label: "Bar", cc: "simple-bar" },
  { label: "Line", cc: "line" },
  { label: "Area", cc: "area" },
  { label: "Radar", cc: "radar" },
  { label: "Pie", cc: "donut" },
  { label: "Meter", cc: "meter" },
  { label: "Treemap", cc: "treemap" },
  { label: "Word cloud", cc: "wordcloud" },
  { label: "Gauge", cc: "gauge" },
  { label: "Stat", stat: true },
  { label: "Histogram", cc: "histogram" },
  { label: "Box plot", cc: "boxplot" },
  { label: "Scatter", cc: "scatter" },
  { label: "Heatmap", cc: "heatmap" },
];

// What each kind's panel offers (sections, in order; a few controls it has and has not) with
// the RICH settings: bar charts of the Phase groups, a few number fields.
const LEGEND = "Values and legend";
const OFFERS = {
  Bar: { sections: ["Data", "Series", "Display", "Axes", "Thresholds", LEGEND, "Size"], has: ["X axis", "Order", "Show", "Draw as", "Axis", "Split by", "Compact (a sparkline: no axes, legend or grid)", "Horizontal", "Logarithmic", "Aspect ratio"], not: ["Parts from", "Bins", "Compare with", "Measured against", "Lines", "Donut (the total in the middle)"] },
  Line: { sections: ["Data", "Series", "Display", "Axes", "Thresholds", LEGEND, "Size"], has: ["Draw as", "Lines", "A dot on each value", "Missing values"], not: ["Horizontal", "Parts from", "Bins"] },
  Area: { sections: ["Data", "Series", "Display", "Axes", "Thresholds", LEGEND, "Size"], has: ["Lines", "A dot on each value", "Missing values", "Split by"], not: ["Horizontal", "Spokes"] },
  Radar: { sections: ["Data", "Spokes", LEGEND, "Size"], has: ["A shape per", "Spokes", "Value", "Unit", "Decimals", "Legend", "Height"], not: ["Draw as", "Logarithmic", "Compact (a sparkline: no axes, legend or grid)", "Parts from", "Measured against"] },
  Pie: { sections: ["Data", "Value", "Total", "Display", LEGEND, "Size"], has: ["Parts from", "Parts", "Measured against", "Donut (the total in the middle)", "Label", "Legend"], not: ["Draw as", "Horizontal", "Compare with", "Full circle", "Bins", "Spokes"] },
  Meter: { sections: ["Data", "Value", "Total", LEGEND, "Size"], has: ["Parts from", "Parts", "Measured against", "Legend", "Width"], not: ["Donut (the total in the middle)", "Height", "Aspect ratio", "Compare with"] },
  Treemap: { sections: ["Data", "Value", LEGEND, "Size"], has: ["Parts from", "Parts", "Height"], not: ["Measured against", "Donut (the total in the middle)", "Draw as", "Full circle"] },
  "Word cloud": { sections: ["Data", "Value", LEGEND, "Size"], has: ["Parts from", "Parts", "Label"], not: ["Measured against", "Donut (the total in the middle)", "Horizontal", "Full circle"] },
  Gauge: { sections: ["Value", "Total", "Display", "Values", "Size"], has: ["Value", "Of", "Measured against", "Full circle", "Compare with", "Decimals", "Height", "Width"], not: ["Unit", "Legend", "Parts from", "A shape per", "X axis", "Donut (the total in the middle)"] },
  Stat: { sections: ["Data", "Value", "Display", "Values", "Size"], has: ["Sparkline", "Sparkline along", "Value", "Of", "Show the name above the number", "Label", "Compare with", "Unit", "Decimals", "Width"], not: ["Legend", "Height", "Aspect ratio", "Measured against", "Full circle"] },
  Histogram: { sections: ["Data", "Display", "Axes", LEGEND, "Size"], has: ["Field", "Split by", "Bins", "X axis title", "Title", "Legend"], not: ["Min", "Max", "Logarithmic", "Draw as", "Compare with", "Parts from"] },
  "Box plot": { sections: ["Data", "Axes", LEGEND, "Size"], has: ["A box per", "Field", "X axis title", "Title", "Legend"], not: ["Show", "Bins", "Min", "Max", "Logarithmic", "Draw as"] },
  Scatter: { sections: ["Data", "Y", "Axes", LEGEND, "Size"], has: ["X", "Size (bubbles)", "Colour by (Split by)", "Y", "Label", "Min", "Max", "Logarithmic", "X axis title"], not: ["Draw as", "Value", "Of", "Parts from", "Bins"] },
  Heatmap: { sections: ["Data", "Value", LEGEND, "Size"], has: ["Columns", "Rows (Split by)", "Value", "Of", "Label", "Unit"], not: ["Logarithmic", "Draw as", "Bins", "Parts from", "Compare with"] },
};

for (const vp of ["phone", "desktop", "wide"]) {
  test(`kinds: the Chart select through all 14 kinds, what is drawn and offered @ ${vp}`, async (t) => {
    const ids = await seeded(t, [{ title: "Weight", options: { ...RICH, chart: "bar" } }]);
    await t.audit("a bar chart");
    const panel = await openSettings(t);
    await t.audit("chart settings (closed sections)");
    const chartSelect = panel.getByLabel("Chart", { exact: true });
    const options = await chartSelect.locator("option").allTextContents();
    await t.check("the Chart select lists the 14 kinds", JSON.stringify(options) === JSON.stringify(KINDS.map((k) => k.label)), options.join(", "));
    const groups = await chartSelect.locator("optgroup").evaluateAll((gs) => gs.map((g) => g.label));
    await t.check("in four sections", JSON.stringify(groups) === JSON.stringify(["Compare and over time", "Parts of a whole", "One value", "Spread"]), groups.join(" | "));
    for (const kind of KINDS) {
      t.at(kind.label);
      await chartSelect.selectOption({ label: kind.label });
      await t.settle(300);
      if (kind.stat) await drawn(t, `${kind.label}: a stat is drawn`, (f) => f.kind === "stat", 0);
      else await drawn(t, `${kind.label}: its chart is drawn (${kind.cc})`, (f) => f.kind === "chart" && f.svg && f.cc.includes(kind.cc), 0);
      const f = await facts(t);
      await t.check(`${kind.label}: no message instead of a chart`, f.kind !== "problem", f.problem);
      if (kind.label === "Line") await t.check("Line: a line, no area", f.lines >= 1 && f.areas === 0, JSON.stringify({ l: f.lines, a: f.areas }));
      if (kind.label === "Area") await t.check("Area: the line and its area", f.areas >= 1, `${f.areas} areas`);
      if (kind.label === "Scatter") await t.check("Scatter: dots, no line", f.dots >= 30 && f.lines === 0, JSON.stringify({ d: f.dots, l: f.lines }));
      if (kind.label === "Histogram") await t.check("Histogram: bars of counts", f.bars >= 3, `${f.bars} bars`);
      if (kind.label === "Box plot") await t.check("Box plot: a box per Phase", f.boxes === 3, `${f.boxes} boxes`);
      if (kind.label === "Pie") await t.check("Pie: a slice per Phase", f.slices === 3, `${f.slices} slices`);
      if (kind.label === "Gauge") {
        await t.check("Gauge: one arc", f.arcs === 1, `${f.arcs}`);
        // A gauge as wide as a pane is mostly empty: switching to one narrows a full-width chart (and back).
        await storedWhen(t, ids, "Gauge: a full-width chart narrows to 24rem", (o) => o.chart === "gauge" && o.width === 24);
        await t.check("Gauge: drawn no wider than that", (await facts(t)).rootBox.width <= 24 * 16 + 1, JSON.stringify((await facts(t)).rootBox));
      }
      if (kind.label === "Stat") {
        await storedWhen(t, ids, "Stat: full width again", (o) => o.chart === "stat" && o.width === "full");
        {
          // As wide as the block (a phone's is narrower than 24rem).
          const f = await facts(t);
          const block = await blockAt(t, 0).boundingBox();
          await t.check("Stat: spans the block", f.rootBox.width > Math.min(24 * 16, block.width) - 40, JSON.stringify([f.rootBox.width, block.width]));
        }
      }
      const c = await controls(panel);
      const want = OFFERS[kind.label];
      await t.check(`${kind.label}: its sections`, JSON.stringify(c.sections) === JSON.stringify(want.sections), c.sections.join(", "));
      const missing = want.has.filter((l) => !c.labels.includes(l));
      const extra = want.not.filter((l) => c.labels.includes(l));
      await t.check(`${kind.label}: its controls are shown`, missing.length === 0, `missing ${missing.join(", ")} of ${c.labels.join(" | ")}`);
      await t.check(`${kind.label}: controls of other kinds are not`, extra.length === 0, `shown ${extra.join(", ")}`);
      await t.audit(`${kind.label}: chart and settings`, { shotOnFail: true });
    }
    // The last kind is stored (a block's settings are stored as they are changed), and drawn again after a reload.
    await storedWhen(t, ids, "Heatmap is stored as the chart", (o) => o.chart === "heatmap");
    await t.open(t.listPath(ids.collections.w));
    await drawn(t, "a heatmap after reload", (f) => f.cc.includes("heatmap") && f.cells > 0);
    const again = await openSettings(t);
    await t.check("the Chart select shows Heatmap", (await again.getByLabel("Chart", { exact: true }).inputValue()) === "heatmap");
    await t.audit("after reload");
  }, { viewport: vp, smoke: vp === "desktop" });
}

// ---- helpers for the tests of settings -------------------------------------------------------

const num = (s) => parseFloat(String(s).replace(/,/g, "").replace("−", "-").replace(/[^0-9.\-]/g, ""));
const maxTick = (ticks) => Math.max(...ticks.map(num).filter((n) => !Number.isNaN(n)));
const rows = (panel) => panel.locator(".chart-options__series");
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const withWeight = WEIGH_INS.filter((i) => i.values.weight !== undefined);
const sumWeight = (items) => items.reduce((n, i) => n + i.values.weight, 0);
const avgWeight = sumWeight(withWeight) / withWeight.length;
const optionsOf = (loc) => loc.locator("option").allTextContents();

test("bar: the X axis (nothing, a field's values, each item), order, date steps, largest n, items without a value", async (t) => {
  const ids = await seeded(t, [{ options: { chart: "bar", series: [S("a", "sum", "@weight")] } }]);
  const panel = await openSettings(t);
  await drawn(t, "nothing on the X axis: one bar of all items", (f) => f.bars === 1);
  await choose(t, panel, "Data", "X axis", "A field's values");
  await choose(t, panel, null, "Field", "Phase");
  await drawn(t, "a bar per Phase, by value", (f) => f.bars === 3 && sameList(f.xTicks, ["Bulk", "Cut", "Maintain"]), 0);
  await t.audit("X axis: a field's values");
  await tick(t, panel, null, "Show items without a value");
  await drawn(t, "items without a Phase get a No value bar", (f) => f.bars === 4 && f.xTicks.includes("No value"));
  await tick(t, panel, null, "Show items without a value", false);
  await drawn(t, "and lose it again", (f) => f.bars === 3);
  await choose(t, panel, null, "Order", "By value, descending");
  await drawn(t, "descending: Maintain, Cut, Bulk", (f) => sameList(f.xTicks, ["Maintain", "Cut", "Bulk"]));
  await choose(t, panel, null, "Order", "Largest first");
  // The categories with the most items first (equal ones by name).
  const byCount = PHASES.map((p) => [p, WEIGH_INS.filter((i) => i.values.phase === p).length]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map((x) => x[0]);
  await drawn(t, `largest first (${byCount.join(", ")})`, (f) => sameList(f.xTicks, byCount));
  await choose(t, panel, null, "Order", "By value, ascending");

  // Dates: steps.
  await choose(t, panel, null, "Field", "Day");
  const steps = await optionsOf(panel.getByLabel("Date steps", { exact: true }));
  await t.check("a date's steps have no minutes and hours", sameList(steps, ["Automatic", "Day", "Week", "Month", "Year"]), steps.join(", "));
  const months = new Set(withWeight.map((i) => i.values.date.slice(0, 7))).size;
  await choose(t, panel, null, "Date steps", "Month");
  await drawn(t, `by month: ${months} bars`, (f) => f.bars === months && f.xTicks[0].startsWith("Jan"));
  await choose(t, panel, null, "Date steps", "Year");
  await drawn(t, "by year: one bar", (f) => f.bars === 1);
  await choose(t, panel, null, "Date steps", "Day");
  await drawn(t, `by day: a bar per weigh-in with a weight (${withWeight.length})`, (f) => f.bars === withWeight.length);
  await choose(t, panel, null, "Date steps", "Week");
  await drawn(t, "by week: fewer bars than days, more than months", (f) => f.bars > months && f.bars < withWeight.length + 1);
  await choose(t, panel, null, "Field", "Moment");
  const timeSteps = await optionsOf(panel.getByLabel("Date steps", { exact: true }));
  await t.check("a date & time's steps include Hour and Minute", timeSteps.includes("Hour") && timeSteps.includes("Minute"), timeSteps.join(", "));
  await choose(t, panel, null, "Date steps", "Hour");
  await drawn(t, "by hour: bars", (f) => f.bars > 1 && f.bars < 40);

  // The largest n.
  await choose(t, panel, null, "Field", "Name");
  await drawn(t, "a bar per name", (f) => f.bars === withWeight.length);
  await choose(t, panel, null, "Show", "The largest 5, the rest as Other");
  await drawn(t, "the largest 5 and Other: 6 bars", (f) => f.bars === 6 && f.xTicks.includes("Other"));
  await t.audit("the largest 5, the rest as Other");
  await choose(t, panel, null, "Show", "All categories");
  await drawn(t, "all categories again", (f) => f.bars === withWeight.length);

  // Each item along the X axis.
  await choose(t, panel, null, "X axis", "Each item");
  const fieldOptions = await optionsOf(panel.getByLabel("Field", { exact: true }).first());
  await t.check("each item: the Field is a date or a number (or none)", fieldOptions[0].startsWith("None") && fieldOptions.includes("Day") && fieldOptions.includes("Weight") && !fieldOptions.includes("Phase"), fieldOptions.join(", "));
  await choose(t, panel, null, "Field", "None (by title, in the block's order)");
  await drawn(t, "each item by its title: a bar per weigh-in", (f) => f.bars === withWeight.length && f.xTicks[0].startsWith("Weigh-in"));
  await choose(t, panel, null, "Field", "Day");
  await drawn(t, "each item along its Day", (f) => f.bars === withWeight.length);
  await t.audit("each item along a date");
  await storedWhen(t, ids, "the X axis is stored", (o) => o.x.by === "item" && o.x.field !== null && o.x.order === "asc");
  await t.open(t.listPath(ids.collections.w));
  await drawn(t, "after a reload: the same bars", (f) => f.bars === withWeight.length);
  const again = await openSettings(t);
  await t.check("the X axis select shows Each item", (await again.getByLabel("X axis", { exact: true }).inputValue()) === "item");
});

test("bar: series (add, remove, label, draw as, axis, transform, steps averaged, split by)", async (t) => {
  const ids = await seeded(t, [{ options: { chart: "bar", x: BY_PHASE, series: [S("a", "sum", "@weight")] } }]);
  const panel = await openSettings(t);
  await section(panel, "Series");
  const r = rows(panel);
  await t.check("one series, which can't be removed", (await r.count()) === 1 && (await r.nth(0).getByRole("button", { name: "Remove series" }).isDisabled()));
  await drawn(t, "one series: no legend", (f) => f.bars === 3 && f.legend.length === 0);
  await panel.getByRole("button", { name: "Add series" }).click();
  await t.until("a second series row (the sum of the next number field)", async () => (await r.count()) === 2);
  await drawn(t, "two series: two bars per Phase and a legend", (f) => f.bars === 6 && f.barFills === 2 && f.legend.includes("Sum of Weight") && f.legend.includes("Sum of Fat"));
  await t.audit("two series");
  await fill(t, r.nth(0), null, "Label", "Mass");
  await drawn(t, "a label names the series in the legend and its heading", (f) => f.legend.includes("Mass") && !f.legend.includes("Sum of Weight"));
  await t.check("the row's heading is the label", (await r.nth(0).locator(".chart-options__row-title").innerText()) === "Mass");
  await choose(t, r.nth(1), null, "Draw as", "Line");
  await drawn(t, "the second series drawn as a line: bars and a line (a combo)", (f) => f.bars === 3 && f.lines === 1);
  await choose(t, r.nth(1), null, "Axis", "Right");
  await drawn(t, "on the right axis: it has ticks", (f) => f.rTicks.length > 0);
  await section(panel, "Axes");
  const heads = await panel.locator("h4.chart-options__subheading").allTextContents();
  await t.check("the Axes section has a left and a right axis", sameList(heads, ["Left axis", "Right axis"]), heads.join(", "));
  await t.audit("a combo on two axes");
  await choose(t, r.nth(1), null, "Axis", "Left");
  await choose(t, r.nth(1), null, "Draw as", "Dots");
  await drawn(t, "dots: no line, dots", (f) => f.lines === 0 && f.dots >= 3);
  await choose(t, r.nth(1), null, "Draw as", "Bars");

  // The first series' values over the categories.
  const base = maxTick((await facts(t)).yTicks);
  await choose(t, r.nth(0), null, "Show", "Running total");
  await drawn(t, "a running total reaches higher", (f) => maxTick(f.yTicks) > base);
  await choose(t, r.nth(0), null, "Show", "Moving average");
  await t.until("Steps averaged appears (3)", async () => (await r.nth(0).getByLabel("Steps averaged", { exact: true }).inputValue()) === "3");
  await fill(t, r.nth(0), null, "Steps averaged", 99);
  await t.until("99 steps is held to 50", async () => (await r.nth(0).getByLabel("Steps averaged", { exact: true }).inputValue()) === "50");
  await fill(t, r.nth(0), null, "Steps averaged", 4);
  await storedWhen(t, ids, "the transform and its steps are stored", (o) => o.series[0].transform === "moving" && o.series[0].window === 4 && o.series[0].label === "Mass");
  await choose(t, r.nth(0), null, "Show", "Change from the step before");
  await t.check("a change has no Steps averaged", (await r.nth(0).getByLabel("Steps averaged", { exact: true }).count()) === 0);
  await choose(t, r.nth(0), null, "Show", "The values");
  await drawn(t, "the values again", (f) => maxTick(f.yTicks) === base);

  // A count has no field to add up.
  await choose(t, r.nth(1), null, "Value", "Count of items");
  await t.check("a count has no Of", (await r.nth(1).getByLabel("Of", { exact: true }).count()) === 0);
  await drawn(t, "counts are small", (f) => f.legend.some((l) => l.startsWith("Count")) || f.barFills === 2);
  await choose(t, r.nth(1), null, "Value", "Average");
  await choose(t, r.nth(1), null, "Of", "Muscle");
  await drawn(t, "the average of Muscle named in the legend", (f) => f.legend.some((l) => /Average.*Muscle/.test(l)));
  await r.nth(1).getByRole("button", { name: "Remove series" }).click();
  await t.until("removing leaves one series", async () => (await r.count()) === 1);
  await drawn(t, "one series again: no legend", (f) => f.bars === 3 && f.legend.length === 0);

  // Split by a field (not the X axis' own: splitting by what the bars are already is ignored).
  await choose(t, panel, "Data", "Field", "Day");
  await choose(t, panel, null, "Date steps", "Month");
  await choose(t, panel, "Series", "Split by", "Phase");
  await drawn(t, "split by Phase: a legend of the Phases and a bar of each per month", (f) => ["Bulk", "Cut", "Maintain"].every((p) => f.legend.includes(p)) && f.barFills === 3 && f.bars > 14);
  await t.audit("split by Phase");
  await tick(t, panel, "Data", "Show items without a value");
  await drawn(t, "items without a Phase are a series of the split: No value", (f) => f.legend.includes("No value") && f.barFills === 4);
  await storedWhen(t, ids, "the split is stored", (o) => o.splitBy !== null && o.series.length === 1 && o.x.showEmpty === true && o.x.dateStep === "month");
});

test("bar: stacked or side by side, horizontal, compact", async (t) => {
  const ids = await seeded(t, [{ options: { chart: "bar", x: BY_PHASE, series: [S("a", "sum", "@weight"), S("b", "sum", "@fat")] } }]);
  const panel = await openSettings(t);
  await drawn(t, "two series side by side", (f) => f.bars === 6);
  const side = maxTick((await facts(t)).yTicks);
  await choose(t, panel, "Display", "Bars and areas", "Stacked");
  await drawn(t, "stacked: the axis reaches higher", (f) => f.bars === 6 && maxTick(f.yTicks) > side);
  await choose(t, panel, null, "Bars and areas", "Stacked as shares of 100%");
  await drawn(t, "as shares: the axis ends at 100", (f) => maxTick(f.yTicks) === 100);
  await t.audit("stacked as shares of 100%");
  await choose(t, panel, null, "Bars and areas", "Side by side");
  await drawn(t, "side by side again", (f) => maxTick(f.yTicks) === side);
  await tick(t, panel, "Display", "Horizontal");
  await drawn(t, "horizontal: bars longer than they are tall", (f) => f.barBoxes.length === 6 && f.barBoxes.every(([w, h]) => w > h));
  await tick(t, panel, null, "Horizontal", false);
  await drawn(t, "vertical: bars taller than wide", (f) => f.barBoxes.every(([w, h]) => h > w));
  await section(panel, "Series");
  await choose(t, rows(panel).nth(1), null, "Axis", "Right");
  await t.check("one series on the right axis: no Horizontal and no stacking", (await panel.getByLabel("Horizontal", { exact: true }).count()) === 0 && (await panel.getByLabel("Bars and areas", { exact: true }).count()) === 0);
  await choose(t, rows(panel).nth(1), null, "Axis", "Left");
  await tick(t, panel, "Display", "Compact (a sparkline: no axes, legend or grid)");
  await drawn(t, "compact: a low chart with no axes or legend", (f) => f.rootBox.height < 90 && f.yTicks.length === 0 && f.legend.length === 0);
  await t.check("a compact chart has no Axes section and says why Height is gone", (await panel.locator(".cds--accordion__title", { hasText: /^Axes$/ }).count()) === 0 && (await panel.getByText("A compact chart has its own, low height.").count()) === 1);
  await t.audit("a compact bar chart");
  await storedWhen(t, ids, "compact is stored", (o) => o.compact === true && o.stack === "none");
  await tick(t, panel, "Display", "Compact (a sparkline: no axes, legend or grid)", false);
  await drawn(t, "not compact: axes again", (f) => f.yTicks.length > 0 && f.rootBox.height > 200);
});

test("line and area: curve, dots, missing values, stacking", async (t) => {
  const ids = await seeded(t, [{ options: { chart: "line", x: { by: "item", field: "@date" }, series: [S("a", "sum", "@weight")] } }]);
  const panel = await openSettings(t);
  await drawn(t, "a line through the weigh-ins with dots", (f) => f.lines === 1 && f.dots >= 30);
  await choose(t, panel, "Display", "Lines", "Straight");
  await drawn(t, "straight: no curves in the path", (f) => f.pathD[0] && !/C/.test(f.pathD[0]) && /L/.test(f.pathD[0]));
  const straightSegments = ((await facts(t)).pathD[0].match(/L/g) || []).length;
  await choose(t, panel, null, "Lines", "Steps");
  await drawn(t, "steps: twice the segments of a straight line, no curves", (f) => !/C/.test(f.pathD[0] || "") && (f.pathD[0].match(/L/g) || []).length > straightSegments);
  await choose(t, panel, null, "Lines", "Smooth");
  await drawn(t, "smooth: curves", (f) => /C/.test(f.pathD[0] || ""));
  await tick(t, panel, null, "A dot on each value", false);
  await drawn(t, "no dots", (f) => f.dots === 0 && f.lines === 1);
  await tick(t, panel, null, "A dot on each value");
  await drawn(t, "dots again", (f) => f.dots >= 30);
  await choose(t, panel, null, "Missing values", "Connect (the line joins its neighbours)");
  await drawn(t, "connected: one stroke", (f) => (f.pathD[0].match(/M/g) || []).length === 1);
  await choose(t, panel, null, "Missing values", "Leave a gap (the line breaks)");
  await drawn(t, "a gap: the line breaks where a weight is missing", (f) => (f.pathD.join("").match(/M/g) || []).length > 1 || f.lines > 1);
  await t.audit("a line with gaps");
  await storedWhen(t, ids, "curve, dots and missing values are stored", (o) => o.curve === "smooth" && o.points === true && o.missing === "gap");

  // The same as an area, two series stacked.
  await choose(t, panel, null, "Chart", "Area");
  await drawn(t, "an area", (f) => f.areas >= 1);
  await section(panel, "Series");
  await panel.getByRole("button", { name: "Add series" }).click();
  await t.until("a second series", async () => (await rows(panel).count()) === 2);
  await choose(t, rows(panel).nth(1), null, "Draw as", "Area");
  const overlap = maxTick((await facts(t)).yTicks);
  await choose(t, panel, "Display", "Bars and areas", "Stacked");
  await drawn(t, "stacked areas reach higher", (f) => f.areas >= 2 && maxTick(f.yTicks) > overlap);
  await choose(t, panel, null, "Bars and areas", "Stacked as shares of 100%");
  await drawn(t, "shares of 100%", (f) => maxTick(f.yTicks) === 100);
  await t.audit("stacked areas");
});

/** Opens the multi-select of number fields in the panel, picks (or unpicks) `name`, closes it. */
async function toggleNumberField(t, panel, name) {
  const field = panel.locator(".chart-options__fields .cds--list-box__field").first();
  await field.scrollIntoViewIfNeeded();
  await field.click();
  await t.page.getByRole("option", { name, exact: true }).first().click();
  await t.page.keyboard.press("Escape");
  await t.page.waitForTimeout(150);
}

const PARTS = [
  { kind: "Pie", chart: "pie", count: (f) => f.slices },
  { kind: "Meter", chart: "meter", count: (f) => f.meters },
  { kind: "Treemap", chart: "treemap", count: (f) => f.leaves },
  { kind: "Word cloud", chart: "wordcloud", count: (f) => f.words },
];

for (const p of PARTS) {
  test(`parts of a whole: ${p.kind} from categories, number fields and one value, against a total`, async (t) => {
    const ids = await seeded(t, [{ options: { ...RICH, chart: p.chart } }]);
    const panel = await openSettings(t);
    const named = p.kind !== "Treemap"; // a treemap's names show only on hover
    await drawn(t, `${p.kind}: a part per Phase`, (f) => p.count(f) === 3 && (!named || ["Bulk", "Cut", "Maintain"].every((n) => f.lines_.includes(n))));
    await t.audit(`${p.kind} of the Phases`);

    // Several number fields as the parts.
    await choose(t, panel, "Data", "Parts from", "Number fields");
    await drawn(t, `${p.kind}: a part per number field (Fat, Muscle, Bone)`, (f) => p.count(f) === 3 && (!named || (f.lines_.some((l) => /Fat/.test(l)) && f.lines_.some((l) => /Bone/.test(l)))));
    await t.check("the field list is shown", (await panel.locator(".chart-options__fields .field-order__row").count()) === 3);
    await panel.locator(".chart-options__fields").getByRole("button", { name: "Remove field" }).first().click();
    await drawn(t, `${p.kind}: removing a field leaves two parts`, (f) => p.count(f) === 2);
    await toggleNumberField(t, panel, "Fat");
    await drawn(t, `${p.kind}: adding it back makes three`, (f) => p.count(f) === 3);
    await t.audit(`${p.kind} of number fields`);

    // One value against its total (a pie's and a meter's: a treemap and a word cloud draw their parts alone).
    const partOptions = await optionsOf(panel.getByLabel("Parts from", { exact: true }));
    const hasTotal = p.chart === "pie" || p.chart === "meter";
    await t.check(`${p.kind}: ${hasTotal ? "has" : "has no"} Total section`, (await panel.locator(".cds--accordion__title", { hasText: /^Total$/ }).count()) === (hasTotal ? 1 : 0));
    if (p.chart === "treemap") {
      await t.check("a treemap of one value is one rectangle: not offered", !partOptions.some((o) => o.startsWith("One value")), partOptions.join(", "));
    } else {
      await choose(t, panel, null, "Parts from", "One value (against its total)");
      await drawn(t, `${p.kind}: one value`, (f) => p.count(f) === 1);
    }
    if (hasTotal) {
      await choose(t, panel, "Total", "Measured against", "A number");
      await fill(t, panel, null, "Number", 5000);
      if (p.chart === "meter") await drawn(t, "Meter: the value of its total", (f) => f.meters === 1 && f.lines_.some((l) => /of 5,?000/.test(l)));
      else await drawn(t, "Pie: the rest is Remaining", (f) => f.slices === 2 && f.lines_.some((l) => l.includes("Remaining")));
      await t.audit(`${p.kind} against a number`);
      await choose(t, panel, null, "Measured against", "Goal");
      await t.until("a field as the total has no Number", async () => (await panel.getByLabel("Number", { exact: true }).count()) === 0);
      if (p.chart === "meter") await drawn(t, "Meter: of the sum of the Goals (36 x 75)", (f) => f.lines_.some((l) => /of 2,?700/.test(l)));
      else await drawn(t, "Pie: 140 of 2,700 remain", (f) => f.slices === 2 && f.lines_.some((l) => l.includes("Remaining")));
      await choose(t, panel, null, "Measured against", "The sum of the parts");
      await drawn(t, `${p.kind}: against the sum of the parts: no Remaining`, (f) => p.count(f) === 1 && !f.lines_.some((l) => l.includes("Remaining")));
    }
    if (p.chart === "pie") {
      await t.check("a donut says its total in the middle", (await facts(t)).cc.includes("donut"));
      await tick(t, panel, "Display", "Donut (the total in the middle)", false);
      await drawn(t, "Pie: not a donut", (f) => f.cc.includes("pie") && !f.cc.includes("donut"));
      await tick(t, panel, "Display", "Donut (the total in the middle)");
      await drawn(t, "Pie: a donut again", (f) => f.cc.includes("donut"));
    }
    if (p.chart === "meter") {
      // Thresholds colour the meter of one value only.
      await choose(t, panel, "Total", "Measured against", "A number");
      await fill(t, panel, null, "Number", 5000);
      await choose(t, panel, "Data", "Parts from", "Categories (below)");
      await t.until("a meter of several parts has no Thresholds", async () => (await panel.locator(".cds--accordion__title", { hasText: /^Thresholds$/ }).count()) === 0);
      await choose(t, panel, "Data", "Parts from", "One value (against its total)");
      await t.until("a meter of one value has", async () => (await panel.locator(".cds--accordion__title", { hasText: /^Thresholds$/ }).count()) === 1);
      await section(panel, "Thresholds");
      await panel.getByRole("button", { name: "Add threshold" }).click();
      await fill(t, panel, null, "Threshold 1", 40);
      await drawn(t, "Meter: 51% is past a warning at 40%", (f) => /warning/.test(f.meterStatus));
      await panel.getByRole("button", { name: "Add threshold" }).click();
      await drawn(t, "Meter: and past a danger at 50%", (f) => /danger/.test(f.meterStatus));
      await t.audit("a meter with thresholds");
      await storedWhen(t, ids, "the meter's thresholds are stored", (o) => o.thresholds.length === 2 && o.thresholds[0].status === "warning" && o.thresholds[1].status === "danger" && o.thresholdMode === "percent");
      // The label row above the bar (Carbon's meter.showLabels): shown, hidden by its checkbox, stored, still hidden after a reload.
      await drawn(t, "Meter: the label row is shown", (f) => f.lines_.some((l) => /of 5,?000/.test(l)));
      await tick(t, panel, "Value", "Show the label above the meter (its name and total)", false);
      await drawn(t, "Meter: no label row, the bar stays", (f) => f.meters === 1 && !f.lines_.some((l) => /of 5,?000/.test(l)));
      await t.check("Meter: with the label off, its Label text is not offered", (await panel.getByLabel("Label", { exact: true }).count()) === 0);
      await t.audit("a meter without its label");
      await storedWhen(t, ids, "the meter's label is stored as off", (o) => o.showLabel === false);
      await t.open(t.listPath(ids.collections.w));
      await drawn(t, "Meter: still no label row after a reload", (f) => f.meters === 1 && !f.lines_.some((l) => /of 5,?000/.test(l)));
      const reopened = await openSettings(t);
      await tick(t, reopened, "Value", "Show the label above the meter (its name and total)");
      await drawn(t, "Meter: the label row is back", (f) => f.lines_.some((l) => /of 5,?000/.test(l)));
      await storedWhen(t, ids, "the meter's label is stored as on", (o) => o.showLabel === true);
    }
    await storedWhen(t, ids, "the chart is stored", (o) => o.chart === p.chart && (p.chart === "treemap" ? o.parts === "fields" : o.parts === "one"));
    await t.open(t.listPath(ids.collections.w));
    await drawn(t, `${p.kind}: drawn again after a reload`, (f) => p.count(f) >= 1);
  });
}

test("radar: spokes, a shape per group, value", async (t) => {
  const ids = await seeded(t, [{ options: { ...RICH, chart: "radar", fields: ["@fat"] } }]);
  const panel = await openSettings(t);
  await drawn(t, "one spoke is not a radar: a message says so", (f) => f.kind === "problem" && f.problem === "Choose at least three number fields for the spokes.");
  await t.audit("a radar without spokes");
  await section(panel, "Spokes");
  await toggleNumberField(t, panel, "Muscle");
  await t.until("still a message with two spokes", async () => (await facts(t)).kind === "problem");
  await toggleNumberField(t, panel, "Bone");
  await drawn(t, "three spokes: a shape per Phase on Fat, Muscle, Bone", (f) => f.blobs === 3 && ["Fat", "Muscle", "Bone"].every((n) => f.lines_.includes(n)));
  const sum = maxTick((await facts(t)).rTicks.length ? (await facts(t)).rTicks : (await facts(t)).lines_);
  await choose(t, panel, "Spokes", "Value", "Average");
  await drawn(t, "the average instead of the sum: smaller values", (f) => maxTick(f.lines_.filter((l) => /^[\d,.]+$/.test(l))) < sum);
  await t.audit("a radar of three spokes");
  await choose(t, panel, "Data", "A shape per", "Nothing (all items)");
  await drawn(t, "nothing: one shape", (f) => f.blobs === 1);
  await panel.locator(".chart-options__fields").getByRole("button", { name: "Remove field" }).first().click();
  await drawn(t, "a spoke removed: back to the message", (f) => f.kind === "problem");
  await storedWhen(t, ids, "two spokes are stored", (o) => o.fields.length === 2 && o.x.by === "none");
});

test("gauge: value, total, full circle, compare with and thresholds", async (t) => {
  const ids = await seeded(t, [{ options: { ...RICH, chart: "gauge", series: [S("a", "avg", "@weight")] } }]);
  const panel = await openSettings(t);
  await drawn(t, "a gauge of the average weight against 100", (f) => f.arcs === 1 && f.lines_[0] === String(Math.round(avgWeight)) || f.lines_[0] === String(Math.round(avgWeight * 100) / 100));
  await t.check("without Compare with there are no Thresholds", (await panel.locator(".cds--accordion__title", { hasText: /^Thresholds$/ }).count()) === 0);
  await choose(t, panel, "Values", "Decimals", "0");
  await choose(t, panel, "Total", "Measured against", "A number");
  await fill(t, panel, null, "Number", 200);
  await drawn(t, "against 200: 40%", (f) => f.lines_[0] === String(Math.round((avgWeight / 200) * 100)));
  await t.audit("a gauge against 200");
  const half = (await facts(t)).arcD;
  await tick(t, panel, "Display", "Full circle");
  await drawn(t, "a full circle draws another arc", (f) => f.arcD !== "" && f.arcD !== half);
  await tick(t, panel, "Display", "Full circle", false);
  await choose(t, panel, "Display", "Compare with", "Average");
  await choose(t, panel, null, "Compared of", "Fat");
  await drawn(t, "compared with the average Fat: a change arrow", (f) => f.deltaArrow !== "");
  await t.until("Thresholds appears with a comparison", async () => (await panel.locator(".cds--accordion__title", { hasText: /^Thresholds$/ }).count()) === 1);
  await section(panel, "Thresholds");
  const modes = await optionsOf(panel.getByLabel("Thresholds are", { exact: true }));
  await t.check("thresholds are a % of the total or values", sameList(modes, ["A % of the total", "Values"]), modes.join(", "));
  await panel.getByRole("button", { name: "Add threshold" }).click();
  await fill(t, panel, null, "Threshold 1", 30);
  await drawn(t, "40% is past a warning at 30%: a warning arrow", (f) => /warning/.test(f.deltaArrow));
  const statuses = await optionsOf(panel.getByLabel("Threshold 1 status", { exact: true }));
  await t.check("a gauge offers the statuses Carbon has (no Info)", sameList(statuses, ["Target", "Warning", "Danger"]), statuses.join(", "));
  await choose(t, panel, null, "Threshold 1 status", "Danger");
  await drawn(t, "a danger arrow", (f) => /danger/.test(f.deltaArrow));
  await t.audit("a gauge with a danger threshold");
  await choose(t, panel, null, "Thresholds are", "Values");
  await storedWhen(t, ids, "the gauge is stored", (o) => o.total.from === "number" && o.total.number === 200 && o.compare === "avg" && o.thresholds[0].status === "danger" && o.thresholdMode === "absolute" && o.decimals === 0);
  await panel.getByRole("button", { name: "Remove threshold" }).click();
  await drawn(t, "no threshold: no status", (f) => !/danger|warning/.test(f.deltaArrow));
  await choose(t, panel, "Display", "Compare with", "Nothing");
  await drawn(t, "no comparison: no arrow", (f) => f.deltaArrow === "");
  await t.open(t.listPath(ids.collections.w));
  await drawn(t, "after a reload: a gauge", (f) => f.arcs === 1);
});

test("stat: value, label, unit, decimals, sparkline, compare with, change shown as, better", async (t) => {
  const ids = await seeded(t, [{ options: { ...RICH, chart: "stat", x: { by: "field", field: "@date", dateStep: "month" }, series: [S("a", "avg", "@weight")] } }]);
  const panel = await openSettings(t);
  const shown = (n) => String(Math.round(n * 100) / 100);
  await drawn(t, "the average weight with its name and a sparkline", (f) => f.kind === "stat" && f.lines_.includes("Average Weight") && f.lines_.includes(shown(avgWeight)) && f.areas === 1);
  await t.audit("a stat");
  // The name above the number.
  await fill(t, panel, "Value", "Label", "Mean weight");
  await drawn(t, "a label replaces the name", (f) => f.lines_.includes("Mean weight"));
  await tick(t, panel, "Value", "Show the name above the number", false);
  await drawn(t, "no name above the number", (f) => !f.lines_.includes("Mean weight") && !f.lines_.includes("Average Weight"));
  await t.check("the Label goes with the name", (await panel.getByLabel("Label", { exact: true }).count()) === 0);
  await tick(t, panel, "Value", "Show the name above the number");
  // Unit and decimals.
  await fill(t, panel, "Values", "Unit", "kg");
  await drawn(t, "the unit follows the number", (f) => f.lines_.some((l) => l === "kg") || f.lines_.some((l) => l.endsWith("kg")));
  // Compared with a number.
  const percent = ((avgWeight - 70) / 70) * 100;
  await choose(t, panel, "Display", "Compare with", "A number");
  await fill(t, panel, null, "Number", 70);
  await drawn(t, `compared with 70: +${percent.toFixed(1)}% in green (higher is better)`, (f) => f.tagText === `+${percent.toFixed(1)}%` && /green/.test(f.tag) && f.lines_.some((l) => l.startsWith("Compared with 70")));
  await t.audit("a stat compared with a number");
  await choose(t, panel, "Values", "Decimals", "0");
  await drawn(t, `no decimals: +${percent.toFixed(0)}%, and the number whole`, (f) => f.tagText === `+${percent.toFixed(0)}%` && f.lines_.includes(`${Math.round(avgWeight)}kg`));
  await choose(t, panel, null, "Decimals", "As they are");
  await choose(t, panel, null, "Better", "Lower (down green, up red)");
  await drawn(t, "lower is better: the rise is red", (f) => /red/.test(f.tag));
  await choose(t, panel, null, "Better", "Neither (grey)");
  await drawn(t, "neither: grey", (f) => /gray/.test(f.tag));
  await choose(t, panel, null, "Change shown as", "The difference");
  await drawn(t, "the difference, not a %", (f) => /^\+\d+(\.\d+)? kg$/.test(f.tagText) && !f.tagText.includes("%"));
  await fill(t, panel, null, "Number", 90);
  await drawn(t, "compared with 90: a fall with a minus", (f) => f.tagText.startsWith("−"));
  await choose(t, panel, null, "Better", "Higher (up green, down red)");
  await drawn(t, "a fall is red when higher is better", (f) => /red/.test(f.tag));
  // The value taken, and what it can be compared with.
  await choose(t, panel, "Value", "Value", "Last value");
  const compareOptions = await optionsOf(panel.getByLabel("Compare with", { exact: true }));
  await t.check("the last value can be compared with the one before", compareOptions.includes("Previous value"), compareOptions.join(", "));
  await choose(t, panel, "Display", "Compare with", "Previous value");
  await drawn(t, "compared with the previous value", (f) => f.lines_.some((l) => l.startsWith("Compared with the previous value")));
  await choose(t, panel, "Value", "Value", "Average");
  await t.check("Previous value goes away with the last value, and the comparison with it", !(await optionsOf(panel.getByLabel("Compare with", { exact: true }))).includes("Previous value") && (await panel.getByLabel("Compare with", { exact: true }).inputValue()) === "");
  await drawn(t, "no comparison: no change tag", (f) => f.kind === "stat" && f.tagText === "");
  await choose(t, panel, "Display", "Compare with", "A number");
  await fill(t, panel, null, "Number", 90);
  await drawn(t, "compared with 90 again", (f) => f.tagText.startsWith("\u2212"));
  // The sparkline.
  await choose(t, panel, "Data", "Sparkline", "Line");
  await drawn(t, "a line sparkline", (f) => f.lines === 1 && f.areas === 0);
  await choose(t, panel, null, "Sparkline", "None");
  await drawn(t, "no sparkline: no chart", (f) => f.kind === "stat" && f.cc.length === 0);
  await t.check("without a sparkline there is nothing to run along", (await panel.getByLabel("Sparkline along", { exact: true }).count()) === 0);
  await t.audit("a stat without a sparkline");
  await storedWhen(t, ids, "the stat is stored", (o) => o.sparkline === "none" && o.unit === "kg" && o.changeAs === "value" && o.better === "higher" && o.compare === "number" && o.baseline === 90 && o.showLabel === true && o.series[0].label === "Mean weight");
  await t.open(t.listPath(ids.collections.w));
  await drawn(t, "after a reload: the stat with its change", (f) => f.kind === "stat" && f.tagText.startsWith("−"));
});

test("spread: histogram (field, bins, split by, axis titles) and box plot (a box per, field)", async (t) => {
  const ids = await seeded(t, [{ options: { chart: "histogram", spreadField: "@weight" } }]);
  const panel = await openSettings(t);
  await drawn(t, "a histogram of the weights, named after the field and the items", (f) => f.bars >= 3 && f.axisTitles.includes("Weight") && f.axisTitles.includes("Weigh-ins"));
  await t.audit("a histogram");
  await choose(t, panel, "Display", "Bins", "5");
  await drawn(t, "5 bins", (f) => f.bars >= 3 && f.bars <= 6);
  const five = (await facts(t)).bars;
  await choose(t, panel, null, "Bins", "20");
  await drawn(t, "20 bins: more bars", (f) => f.bars > five);
  await choose(t, panel, null, "Bins", "Automatic");
  await choose(t, panel, "Data", "Field", "Fat");
  await drawn(t, "another field: its name on the axis", (f) => f.axisTitles.includes("Fat") && !f.axisTitles.includes("Weight"));
  await choose(t, panel, null, "Field", "Muscle");
  await drawn(t, "a field with few values: few bars", (f) => f.bars >= 3 && f.axisTitles.includes("Muscle"));
  await choose(t, panel, null, "Field", "Weight");
  await choose(t, panel, null, "Split by", "Phase");
  await drawn(t, "split by Phase: a legend and a colour each", (f) => ["Bulk", "Cut", "Maintain"].every((p) => f.legend.includes(p)) && f.barFills >= 3);
  await fill(t, panel, "Axes", "X axis title", "Kilos");
  await fill(t, panel, null, "Title", "How many");
  await drawn(t, "axis titles typed", (f) => f.axisTitles.includes("Kilos") && f.axisTitles.includes("How many"));
  await t.audit("a histogram split by Phase");
  await storedWhen(t, ids, "the histogram is stored", (o) => o.bins === 0 && o.xTitle === "Kilos" && o.splitBy !== null);

  // The same settings as a box plot.
  await choose(t, panel, null, "Chart", "Box plot");
  await drawn(t, "a box plot: one box of all items (the X axis is nothing)", (f) => f.boxes === 1);
  const byOptions = await optionsOf(panel.getByLabel("A box per", { exact: true }));
  await t.check("a box per: nothing or a field's values (not each item)", sameList(byOptions, ["Nothing (all items)", "A field's values"]), byOptions.join(", "));
  await choose(t, panel, "Data", "A box per", "A field's values");
  await choose(t, panel, null, "Field", "Phase");
  await drawn(t, "a box per Phase", (f) => f.boxes === 3 && sameList(f.xTicks, ["Bulk", "Cut", "Maintain"]));
  await tick(t, panel, null, "Show items without a value");
  await drawn(t, "No value gets a box", (f) => f.boxes === 4 && f.xTicks.includes("No value"));
  await t.check("a box plot has every category: no Show", (await panel.getByLabel("Show", { exact: true }).count()) === 0);
  await choose(t, panel, null, "Field", "Phase");
  await t.audit("a box plot");
  await storedWhen(t, ids, "the box plot is stored", (o) => o.chart === "boxplot" && o.x.by === "field" && o.x.showEmpty === true);
  await t.open(t.listPath(ids.collections.w));
  await drawn(t, "after a reload: four boxes", (f) => f.boxes === 4);
});

test("scatter: X, Y fields, size, colour by; clicking a dot opens its item", async (t) => {
  const ids = await seeded(t, [{ options: { chart: "scatter", x: { by: "item", field: "@date" }, series: [S("a", "sum", "@weight")] } }]);
  const panel = await openSettings(t);
  await drawn(t, "a dot per weigh-in with a weight", (f) => f.cc.includes("scatter") && f.dots === withWeight.length && f.lines === 0);
  await section(panel, "Y");
  await panel.getByRole("button", { name: "Add Y field" }).click();
  await t.until("a second Y field", async () => (await rows(panel).count()) === 2);
  await drawn(t, "two Y fields: a dot each and a legend of both", (f) => f.dots > withWeight.length && f.legend.includes("Weight") && f.legend.length >= 2);
  await fill(t, rows(panel).nth(0), null, "Label", "Mass");
  await drawn(t, "a label names the dots", (f) => f.legend.includes("Mass"));
  await rows(panel).nth(1).getByRole("button", { name: "Remove Y field" }).click();
  await t.until("one Y field again", async () => (await rows(panel).count()) === 1);
  await drawn(t, "back to one", (f) => f.dots === withWeight.length);
  await choose(t, panel, "Data", "X", "Muscle");
  await drawn(t, "X is a number field: numbers on the axis", (f) => f.xTicks.every((x) => !Number.isNaN(num(x))) && f.axisTitles.includes("Muscle"));
  await choose(t, panel, null, "Size (bubbles)", "Fat");
  await drawn(t, "a size makes bubbles", (f) => f.cc.includes("bubble"));
  await choose(t, panel, null, "Colour by (Split by)", "Phase");
  await drawn(t, "coloured by Phase", (f) => ["Bulk", "Cut", "Maintain"].every((p) => f.legend.includes(p)));
  await choose(t, panel, null, "Size (bubbles)", "Same size");
  await drawn(t, "same size: dots again", (f) => !f.cc.includes("bubble") && f.dots > 0);
  await choose(t, panel, null, "X", "Day");
  await t.audit("a scatter coloured by Phase");
  await storedWhen(t, ids, "the scatter is stored", (o) => o.chart === "scatter" && o.sizeField === null && o.splitBy !== null && o.x.by === "item" && o.series.length === 1 && o.series[0].label === "Mass");
  // A dot opens its item.
  await t.closeAll();
  await t.page.locator(`${PANE} .chart-block circle.dot`).first().click({ force: true });
  await t.until("clicking a dot opens its item", async () => /\/items\/[0-9a-f-]{36}/.test(t.page.url()) || (await t.page.locator(`${PANE} .item-fields, ${PANE} .item-title`).count()) > 0, { timeout: 8000 });
  await t.audit("the item a dot opened");
});

test("heatmap: columns, rows, a calendar of days", async (t) => {
  const ids = await seeded(t, [{ options: { chart: "heatmap", x: { by: "field", field: "@date" }, series: [S("a", "sum", "@weight")] } }]);
  const panel = await openSettings(t);
  await drawn(t, "a calendar: a cell per day with a weight, weekdays down the side", (f) => f.cells === withWeight.length && ["Sun", "Mon", "Sat"].every((d) => f.lines_.includes(d)));
  await t.audit("a calendar heatmap");
  await t.check("a calendar has no Order or Date steps", (await panel.getByLabel("Order", { exact: true }).count()) === 0 && (await panel.getByLabel("Date steps", { exact: true }).count()) === 0);
  await choose(t, panel, "Data", "Rows (Split by)", "Phase");
  await t.until("steps and order are offered once it is not a calendar", async () => (await panel.getByLabel("Date steps", { exact: true }).count()) === 1);
  await choose(t, panel, null, "Date steps", "Month");
  const months = new Set(withWeight.map((i) => i.values.date.slice(0, 7))).size;
  await drawn(t, `months across, Phases down: at most ${months * 3} cells`, (f) => f.cells > months && f.cells <= months * 3 && !f.lines_.includes("Sun") && f.lines_.includes("Bulk") && f.lines_.includes("Maintain"));
  await choose(t, panel, null, "Rows (Split by)", "Not split");
  await drawn(t, "not split: a date is a calendar again", (f) => f.cells === withWeight.length && f.lines_.includes("Sun"));
  await choose(t, panel, null, "Columns", "A field's values");
  await choose(t, panel, null, "Field", "Phase");
  await drawn(t, "columns of Phases: three cells", (f) => f.cells === 3 && f.lines_.includes("Cut"));
  await choose(t, panel, "Value", "Value", "Count of items");
  await drawn(t, "a count of items", (f) => f.cells === 3);
  await t.audit("a heatmap of Phases");
  await storedWhen(t, ids, "the heatmap is stored", (o) => o.chart === "heatmap" && o.series[0].value === "count" && o.splitBy === null && o.x.by === "field");
});

test("axes: titles, min, max, logarithmic, right axis", async (t) => {
  const ids = await seeded(t, [{ options: { chart: "line", x: { by: "item", field: "@date" }, series: [S("a", "sum", "@weight"), S("b", "sum", "@fat", { axis: "right" })] } }]);
  const panel = await openSettings(t);
  await drawn(t, "two axes fitted to their values", (f) => f.yTicks.length > 0 && f.rTicks.length > 0 && num(f.yTicks[0]) > 0);
  await section(panel, "Axes");
  const groups = panel.locator(".chart-options__group");
  await t.check("a left and a right axis", (await groups.count()) === 2);
  await t.audit("axes");
  await fill(t, panel, "Axes", "X axis title", "Weigh-in day");
  await fill(t, groups.nth(0), null, "Title", "Weight total");
  await fill(t, groups.nth(1), null, "Title", "Fat total");
  await drawn(t, "the titles are drawn", (f) => ["Weigh-in day", "Weight total", "Fat total"].every((x) => f.axisTitles.includes(x)));
  await fill(t, groups.nth(0), null, "Min", 0);
  await drawn(t, "a min of 0 on the left axis", (f) => num(f.yTicks[0]) === 0);
  await fill(t, groups.nth(0), null, "Max", 200);
  await drawn(t, "a max of 200", (f) => maxTick(f.yTicks) >= 200 && maxTick(f.yTicks) <= 220);
  await fill(t, groups.nth(0), null, "Min", "");
  await fill(t, groups.nth(0), null, "Max", "");
  await drawn(t, "emptied: the axis fits its values again", (f) => num(f.yTicks[0]) > 0 && maxTick(f.yTicks) < 100);
  await fill(t, groups.nth(0), null, "Min", 1);
  await fill(t, groups.nth(0), null, "Max", 1000);
  await tick(t, groups.nth(0), null, "Logarithmic");
  await drawn(t, "logarithmic: ticks at powers of ten", (f) => [1, 10, 100].every((n) => f.yTicks.some((x) => num(x) === n)) && f.yTicks.includes("1k"));
  await t.audit("a logarithmic axis");
  await storedWhen(t, ids, "the axes are stored", (o) => o.xTitle === "Weigh-in day" && o.left.title === "Weight total" && o.left.log === true && o.left.min === 1 && o.left.max === 1000 && o.right.title === "Fat total");
  await t.open(t.listPath(ids.collections.w));
  await drawn(t, "after a reload: the titles and the scale", (f) => f.axisTitles.includes("Fat total") && f.yTicks.some((x) => num(x) === 100));
  // No series on the right: the right axis' settings are gone.
  const again = await openSettings(t);
  await section(again, "Series");
  await choose(t, rows(again).nth(1), null, "Axis", "Left");
  await section(again, "Axes");
  await t.check("one value axis", (await again.locator("h4.chart-options__subheading").allTextContents()).join() === "Value axis");
});

test("thresholds on a line: add, value, status, remove", async (t) => {
  const ids = await seeded(t, [{ options: { chart: "line", x: { by: "item", field: "@date" }, series: [S("a", "sum", "@weight")] } }]);
  const panel = await openSettings(t);
  await section(panel, "Thresholds");
  await t.check("a note says where the lines go", (await panel.getByText("Lines on the left axis, from the value up.").count()) === 1);
  await panel.getByRole("button", { name: "Add threshold" }).click();
  await drawn(t, "a threshold line", (f) => f.thresholds === 1);
  await fill(t, panel, null, "Threshold 1", 80);
  const statuses = await optionsOf(panel.getByLabel("Threshold 1 status", { exact: true }));
  await t.check("a line offers Info, Target, Warning and Danger", sameList(statuses, ["Info", "Target", "Warning", "Danger"]), statuses.join(", "));
  const colours = { Info: "support-info", Target: "support-success", Warning: "support-warning", Danger: "support-error" };
  for (const [status, token] of Object.entries(colours)) {
    await choose(t, panel, null, "Threshold 1 status", status);
    await drawn(t, `${status}: the line in ${token}`, (f) => f.thresholds === 1 && f.thresholdColors[0].includes(token));
  }
  await panel.getByRole("button", { name: "Add threshold" }).click();
  await t.until("the next is a danger one above", async () => (await panel.getByLabel("Threshold 2", { exact: true }).inputValue()) === "81" && (await panel.getByLabel("Threshold 2 status", { exact: true }).inputValue()) === "danger");
  await drawn(t, "two lines", (f) => f.thresholds === 2);
  await t.audit("two thresholds");
  await panel.getByRole("button", { name: "Remove threshold" }).first().click();
  await drawn(t, "removing the first leaves one", (f) => f.thresholds === 1);
  await t.check("it is the second, now the first", (await panel.getByLabel("Threshold 1", { exact: true }).inputValue()) === "81");
  await storedWhen(t, ids, "one danger threshold at 81 is stored", (o) => o.thresholds.length === 1 && o.thresholds[0].value === 81 && o.thresholds[0].status === "danger");
  await t.open(t.listPath(ids.collections.w));
  await drawn(t, "after a reload: the line", (f) => f.thresholds === 1);
});

test("values and legend: unit, decimals, legend shown or hidden and where", async (t) => {
  const ids = await seeded(t, [{ options: { chart: "bar", x: BY_PHASE, series: [S("a", "sum", "@weight"), S("b", "sum", "@fat")] } }]);
  const panel = await openSettings(t);
  await drawn(t, "two series: a legend", (f) => f.legend.length === 2);
  await fill(t, panel, "Values and legend", "Unit", "kg");
  await drawn(t, "the unit on the axis", (f) => f.yTicks.length > 0 && f.yTicks.every((x) => x.endsWith("kg")));
  await choose(t, panel, null, "Decimals", "2");
  await drawn(t, "two decimals on the axis", (f) => f.yTicks.every((x) => /\.00 kg$/.test(x)));
  await t.audit("unit and decimals");
  await fill(t, panel, null, "Unit", "");
  await choose(t, panel, null, "Decimals", "As they are");
  await drawn(t, "no unit, as they are", (f) => f.yTicks.every((x) => !x.includes("kg") && !x.includes(".")));
  // Where the legend is.
  const centre = (b) => [b.x + b.width / 2, b.y + b.height / 2];
  const where = {
    Top: (l, h) => centre(l)[1] < h.y + h.height * 0.3,
    Bottom: (l, h) => centre(l)[1] > h.y + h.height * 0.7,
    Left: (l, h) => centre(l)[0] < h.x + h.width * 0.3,
    Right: (l, h) => centre(l)[0] > h.x + h.width * 0.7,
  };
  for (const position of ["Top", "Left", "Right", "Bottom"]) {
    await choose(t, panel, null, "Legend position", position);
    await drawn(t, `legend ${position.toLowerCase()}`, (f) => f.legendBox && where[position](f.legendBox, f.holderBox));
  }
  await choose(t, panel, null, "Legend position", "Right");
  await t.audit("a legend on the right");
  await choose(t, panel, null, "Legend", "Hidden");
  await drawn(t, "hidden: no legend", (f) => f.legend.length === 0);
  await t.check("a hidden legend has no position", (await panel.getByLabel("Legend position", { exact: true }).count()) === 0);
  await choose(t, panel, null, "Legend", "With more than one series or part");
  await section(panel, "Series");
  await rows(panel).nth(1).getByRole("button", { name: "Remove series" }).click();
  await drawn(t, "one series: no legend by itself", (f) => f.legend.length === 0);
  await t.check("and no position to choose", (await panel.getByLabel("Legend position", { exact: true }).count()) === 0);
  await choose(t, panel, "Values and legend", "Legend", "Shown");
  await drawn(t, "shown: the one series in a legend", (f) => f.legend.length === 1);
  await choose(t, panel, null, "Legend position", "Top");
  await storedWhen(t, ids, "legend, unit and decimals are stored", (o) => o.legend === "show" && o.legendPosition === "top" && o.unit === "" && o.decimals === null);
  await t.open(t.listPath(ids.collections.w));
  await drawn(t, "after a reload: the legend on top", (f) => f.legendBox && where.Top(f.legendBox, f.holderBox));
});

test("size: height, aspect ratio and width", async (t) => {
  const ids = await seeded(t, [{ options: { chart: "bar", x: BY_PHASE, series: [S("a", "sum", "@weight")] } }]);
  const panel = await openSettings(t);
  const near = (a, b) => Math.abs(a - b) <= 4;
  const f0 = await facts(t);
  const width = f0.rootBox.width;
  await drawn(t, "24rem high at 4:3 in a wide pane", (f) => near(f.holderBox.height, 384));
  await slide(t, panel, "Height", "min");
  await drawn(t, "8rem high", (f) => near(f.holderBox.height, 128));
  await slide(t, panel, "Height", "max");
  await drawn(t, "48rem high (4:3 of the width is more)", (f) => near(f.holderBox.height, Math.min(768, (width * 3) / 4)));
  await choose(t, panel, null, "Aspect ratio", "2:1");
  await drawn(t, "2:1: as high as half the width", (f) => near(f.holderBox.height, Math.min(768, width / 2)));
  await t.audit("a chart 2:1");
  await slide(t, panel, "Width", "min");
  await drawn(t, "8rem wide, 2:1 of that high", (f) => near(f.rootBox.width, 128) && near(f.holderBox.height, 64));
  await slide(t, panel, "Width", "+1");
  await drawn(t, "one step wider: 9rem", (f) => near(f.rootBox.width, 144));
  await choose(t, panel, null, "Aspect ratio", "None: the height");
  await drawn(t, "no aspect ratio: the height", (f) => near(f.holderBox.height, 768));
  await slide(t, panel, "Width", "max");
  await drawn(t, "Full width: as wide as the pane", (f) => near(f.rootBox.width, width));
  await storedWhen(t, ids, "the size is stored", (o) => o.height === 48 && o.aspect === "none" && o.width === "full");
  await slide(t, panel, "Width", "min");
  await storedWhen(t, ids, "8rem wide is stored", (o) => o.width === 8);
  await t.open(t.listPath(ids.collections.w));
  await drawn(t, "after a reload: still 8rem wide and 48rem high", (f) => near(f.rootBox.width, 128) && near(f.holderBox.height, 768));
});

// The Width slider runs 8 to 99 rem and ends in Full width: no maximum, the block fills its pane, wide or narrow.
for (const vp of ["phone", "desktop", "wide"]) {
  test(`width: 99rem caps a chart, the last stop is Full width (${vp})`, async (t) => {
    const ids = await seeded(t, [{ options: { chart: "bar", x: BY_PHASE, series: [S("a", "sum", "@weight")] } }]);
    const panel = await openSettings(t);
    const near = (a, b) => Math.abs(a - b) <= 4;
    const pane = async () => (await t.page.locator(PANE).boundingBox()).width;
    const item = () => panel.locator(".cds--form-item", { has: panel.page().locator('label:text-is("Width")') });
    const thumb = () => item().locator(".cds--slider__thumb").first();
    const now = async () => (await thumb().getAttribute("aria-valuenow")) + "/" + (await thumb().getAttribute("aria-valuemax"));
    await section(panel, "Size");
    await t.check("a new chart is at Full width: the slider's last stop", (await now()) === "100/100", await now());
    const labels = await item().innerText();
    await t.check("the slider labels its ends 8rem and Full width", /8rem/.test(labels) && /Full width/.test(labels), labels);
    const full = (await facts(t)).rootBox.width;
    await t.check("Full width fills the pane (less its padding)", full > (await pane()) - 80, JSON.stringify([full, await pane()]));
    // One step back from the end: 99rem, the most a number can be.
    await thumb().focus();
    await t.page.keyboard.press("ArrowLeft");
    await storedWhen(t, ids, "one step back is 99rem", (o) => o.width === 99);
    await drawn(t, "99rem caps the chart (or it fills a pane narrower than that)", (f) => near(f.rootBox.width, Math.min(99 * 16, full)));
    if (full > 99 * 16 + 8) await t.check("99rem is narrower than a wide pane", (await facts(t)).rootBox.width < full - 4, "");
    await t.audit(`99rem wide (${vp})`);
    await t.page.keyboard.press("ArrowRight");
    await storedWhen(t, ids, "the last stop is stored as Full width", (o) => o.width === "full");
    await drawn(t, "Full width again fills the pane", (f) => near(f.rootBox.width, full));
    await t.open(t.listPath(ids.collections.w));
    await drawn(t, "after a reload: still Full width", (f) => near(f.rootBox.width, full));
    const again = await openSettings(t);
    await section(again, "Size");
    await t.check("after a reload the slider is at its last stop", (await again.locator(".cds--slider__thumb").last().getAttribute("aria-valuenow")) === "100");
  }, { viewport: vp });
}

test("a stored width of 100rem or more (the old maximum was 120) is Full width", async (t) => {
  const ids = await seeded(t, [{ options: { chart: "bar", x: BY_PHASE, series: [S("a", "sum", "@weight")], width: 120 } }]);
  const wide = (await facts(t)).rootBox.width;
  const paneW = (await t.page.locator(PANE).boundingBox()).width;
  await t.check("a chart stored at 120 fills the pane", wide > paneW - 80, JSON.stringify([wide, paneW]));
  const panel = await openSettings(t);
  await section(panel, "Size");
  const item = panel.locator(".cds--form-item", { has: panel.page().locator('label:text-is("Width")') });
  await t.check("its slider is at Full width", (await item.locator(".cds--slider__thumb").first().getAttribute("aria-valuenow")) === "100");
});

test("a chart that can't be drawn says why, and is mended in the settings", async (t) => {
  const blocks = [
    { title: "Nothing to add up", options: { chart: "bar", x: BY_PHASE, series: [S("a", "sum", null)] } },
    { title: "No items", filters: [{ field: "name", operator: "contains", value: "zzz" }], options: RICH },
    { title: "One spoke", options: { ...RICH, chart: "radar", fields: ["@fat"] } },
    { title: "No spread field", options: { chart: "histogram", spreadField: null } },
    { title: "No field to measure", options: { chart: "gauge", series: [S("a", "sum", null)] } },
    { title: "No Y field", options: { chart: "scatter", x: { by: "item", field: "@date" }, series: [S("a", "sum", null)] } },
  ];
  const ids = await seeded(t, blocks);
  const want = ["Choose the field to add up.", "No items to chart.", "Choose at least three number fields for the spokes.", "Choose the number or date field whose values to spread.", "Choose the field to measure.", "Choose the fields for X and Y."];
  for (const [i, message] of want.entries()) await drawn(t, `${blocks[i].title}: "${message}"`, (f) => f.kind === "problem" && f.problem === message, i);
  await t.audit("six charts that say why not");
  // Mend the first: the field to add up.
  const panel = await openSettings(t, 0);
  await choose(t, panel, "Series", "Of", "Weight");
  await drawn(t, "with a field the bars are drawn", (f) => f.kind === "chart" && f.bars === 3, 0);
  await t.closeAll();
  // And the histogram: its field.
  const second = await openSettings(t, 3);
  await choose(t, second, "Data", "Field", "Weight");
  await drawn(t, "with a field the histogram is drawn", (f) => f.kind === "chart" && f.bars >= 3, 3);
  await t.audit("two mended");
  await storedWhen(t, ids, "the mended field is stored", (o) => o.series[0].field !== null, 0);
});

test("on an item page: Of this item or these items", async (t) => {
  const spec = chartSpec([{ options: RICH }]);
  spec.collections[0].itemViews = [{ name: "Main", layout: { fields: null, blocks: [{ kind: "chart", title: "Weight", collection: "w", options: { chart: "stat", scope: "page", series: [S("a", "sum", "@weight")] } }] } }];
  await t.boot();
  const ids = await t.seed(spec);
  await t.open(t.itemPath(ids.collections.w, ids.items["w/w0"]));
  await waitDrawn(t);
  await drawn(t, "this item's weight alone", (f) => f.kind === "stat" && f.lines_.includes(String(WEIGH_INS[0].values.weight)));
  await t.audit("a stat of this item");
  const panel = await openSettings(t);
  await choose(t, panel, "Data", "Of", "These items");
  await drawn(t, "these items: the sum of all weights", (f) => f.kind === "stat" && f.lines_.includes(String(Math.round(sumWeight(withWeight) * 100) / 100)));
  await choose(t, panel, null, "Of", "This item");
  await drawn(t, "this item again", (f) => f.lines_.includes(String(WEIGH_INS[0].values.weight)));
  await t.audit("the item's settings");
});
