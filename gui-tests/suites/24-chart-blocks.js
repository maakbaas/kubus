// Chart blocks: the Chart select through every kind, what is drawn (Carbon Charts' svg read back by
// `facts`) and which settings each offers.

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
      lineStrokes: all("path.line").map((e) => e.getAttribute("stroke") || ""),
      areaFills: all("path.area").map((e) => e.getAttribute("fill") || ""),
      dotFills: uniq(all("circle.dot").map((e) => e.getAttribute("fill") || "")),
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
  Stat: { sections: ["Data", "Value", "Display", "Values", "Size"], has: ["Sparkline", "Sparkline along", "Value", "Of", "Show the name above the number", "Label", "Compare with", "Unit", "Decimals", "Width", "Height", "Aspect ratio"], not: ["Legend", "Measured against", "Full circle"] },
  Histogram: { sections: ["Data", "Display", "Axes", LEGEND, "Size"], has: ["Field", "Split by", "Bins", "X axis title", "Title", "Legend"], not: ["Min", "Max", "Logarithmic", "Draw as", "Compare with", "Parts from"] },
  "Box plot": { sections: ["Data", "Axes", LEGEND, "Size"], has: ["A box per", "Field", "X axis title", "Title", "Legend"], not: ["Show", "Bins", "Min", "Max", "Logarithmic", "Draw as"] },
  Scatter: { sections: ["Data", "Y", "Axes", LEGEND, "Size"], has: ["X", "Size (bubbles)", "Colour by (Split by)", "Y", "Label", "Min", "Max", "Logarithmic", "X axis title"], not: ["Draw as", "Value", "Of", "Parts from", "Bins"] },
  Heatmap: { sections: ["Data", "Value", LEGEND, "Size"], has: ["Columns", "Rows (Split by)", "Value", "Of", "Label", "Unit"], not: ["Logarithmic", "Draw as", "Bins", "Parts from", "Compare with"] },
};

test("kinds: the Chart select through the chart kinds, what is drawn and offered @ desktop", async (t) => {
  const ids = await seeded(t, [{ title: "Weight", options: { ...RICH, chart: "bar" } }]);
  await t.audit("a bar chart");
  const panel = await openSettings(t);
  await t.audit("chart settings (closed sections)");
  const chartSelect = panel.getByLabel("Chart", { exact: true });
  const options = await chartSelect.locator("option").allTextContents();
  await t.check("the Chart select offers every kind tested here", KINDS.every((k) => options.includes(k.label)), options.join(", "));
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
}, { viewport: "desktop", smoke: true });
