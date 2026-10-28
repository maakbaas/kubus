import { describe, expect, it } from "vitest";
import { CHART_KINDS, defaultChartOptions, newSeries, type ChartInput, type ChartOptions, type ChartX } from "../domain/chart";
import { blankField, type Collection, type Item } from "../domain/model";
import type { QueryContext } from "../domain/query";
import { chartSpec, type ChartSpec } from "./chartSpec";

const collection: Collection = {
  id: "books", name: "Book", pluralName: "Books", icon: null, description: "", itemViews: [], spaceIds: null, createdAt: "", updatedAt: "",
  fields: [
    blankField("title", "Title", "string"),
    blankField("genre", "Genre", "string"),
    blankField("pages", "Pages", "number"),
    blankField("rating", "Rating", "number"),
    blankField("year", "Year", "number"),
    blankField("read", "Read", "date"),
  ],
};
const book = (id: string, genre: string, pages: number, rating: number, read: string): Item => ({
  id, collectionId: "books", spaceId: "s", createdAt: "", updatedAt: "", values: { title: `Book ${id}`, genre, pages, rating, year: 2000 + Number(id), read },
});
const books = [book("1", "Novel", 300, 4, "2026-01-05"), book("2", "Novel", 200, 2, "2026-02-10"), book("3", "Poetry", 80, 5, "2026-03-02")];
const ctx: QueryContext = { refLabel: () => "" };
const input = (items = books): ChartInput => ({ collection, items, ctx, locale: "en-GB" });

const byGenre: ChartX = { by: "field", field: "genre", order: "asc", dateStep: "auto", showEmpty: false, top: 0 };
const byMonth: ChartX = { ...byGenre, field: "read", dateStep: "month" };
const sum = (field: string, patch: Partial<ReturnType<typeof newSeries>> = {}) => newSeries({ value: "sum", field, ...patch });
const options = (o: Partial<ChartOptions>): ChartOptions => ({ ...defaultChartOptions(collection), x: byGenre, series: [newSeries()], ...o });
const draw = (o: Partial<ChartOptions>, items = books) => chartSpec(input(items), options(o), "white");
const spec = (o: Partial<ChartOptions>) => {
  const s = draw(o);
  if ("problem" in s) throw new Error(s.problem);
  return s as ChartSpec;
};
type Axis = { title?: string; scaleType?: string; domain?: unknown[]; includeZero?: boolean; stacked?: boolean; percentage?: boolean; main?: boolean;
  correspondingDatasets?: string[]; thresholds?: { value: number; label: string; fillColor: string }[]; ticks?: { formatter(n: number): string }; visible?: boolean; mapsTo?: string };
const axes = (s: ChartSpec) => s.options.axes as Record<"left" | "right" | "bottom", Axis>;

describe("chartSpec", () => {
  it("draws every chart type once its settings are chosen", () => {
    const settings: Partial<ChartOptions> = { series: [sum("pages"), sum("rating")], fields: ["pages", "rating", "year"], spreadField: "pages", total: { from: "number", number: 1000, field: null } };
    for (const { kind } of CHART_KINDS) {
      const x = kind === "scatter" ? { ...byGenre, by: "item" as const, field: "year" } : byGenre;
      expect(spec({ ...settings, x, chart: kind }).data.length, kind).toBeGreaterThan(0);
    }
  });

  it("makes a bar per group, grouped or stacked when split", () => {
    const simple = spec({});
    expect(simple.chart).toBe("SimpleBarChart");
    expect(simple.data).toEqual([
      { group: "Books", key: "Novel", value: 2 },
      { group: "Books", key: "Poetry", value: 1 },
    ]);
    expect(axes(simple).bottom).toMatchObject({ scaleType: "labels", domain: ["Novel", "Poetry"], title: "Genre" });
    // A bar's value axis starts at 0, its title the one series' name.
    expect(axes(simple).left).toMatchObject({ title: "Books" });
    expect(axes(simple).left.includeZero).toBeUndefined();
    expect(spec({ splitBy: "rating" }).chart).toBe("GroupedBarChart");
    expect(spec({ series: [newSeries(), sum("pages")] }).chart).toBe("GroupedBarChart");
    const stacked = spec({ splitBy: "rating", stack: "stacked" });
    expect([stacked.chart, axes(stacked).left.stacked]).toEqual(["StackedBarChart", true]);
    expect(axes(spec({ horizontal: true })).left.mapsTo).toBe("key");
    expect(spec({ series: [newSeries({ style: "lollipop" })] }).chart).toBe("LollipopChart");
  });

  it("stacks as shares of 100%", () => {
    const percent = spec({ splitBy: "rating", stack: "percent" });
    expect(percent.chart).toBe("StackedBarChart");
    expect(axes(percent).left).toMatchObject({ stacked: true, percentage: true });
    expect(axes(percent).left.ticks!.formatter(50)).toBe("50%");
    expect(spec({ chart: "area", x: byMonth, splitBy: "genre", stack: "percent" }).chart).toBe("StackedAreaChart");
    // Lollipops don't stack.
    const lollipops = spec({ splitBy: "rating", stack: "percent", series: [newSeries({ style: "lollipop" })] });
    expect([lollipops.chart, axes(lollipops).left.percentage]).toEqual(["LollipopChart", undefined]);
  });

  it("draws a line over time, fitted, as areas, compact as a sparkline", () => {
    const line = spec({ chart: "line", x: byMonth });
    expect(line.chart).toBe("LineChart");
    expect(line.data[0]).toEqual({ group: "Books", date: new Date(2026, 0, 1), value: 1 });
    expect(axes(line).bottom.scaleType).toBe("time");
    expect(axes(line).left.includeZero).toBe(false);
    expect(line.options.curve).toBe("curveMonotoneX");
    expect(spec({ chart: "line", x: byMonth, curve: "step" }).options.curve).toBe("curveStepAfter");
    expect(spec({ chart: "line", x: byMonth, points: false }).options.points).toEqual({ enabled: false });
    expect(spec({ chart: "area", x: byMonth }).chart).toBe("AreaChart");
    const compact = spec({ chart: "line", x: byMonth, compact: true }).options;
    expect([compact.height, (compact.axes as Record<string, Axis>).left.visible, (compact.legend as { enabled: boolean }).enabled]).toEqual(["4rem", false, false]);
  });

  it("keeps an area an area with a second series on the right axis", () => {
    const s = spec({ chart: "area", x: byMonth, series: [newSeries(), sum("pages", { axis: "right" })] });
    expect(s.chart).toBe("ComboChart");
    expect(s.options.comboChartTypes).toEqual([{ type: "area", correspondingDatasets: ["Books", "Sum of Pages"] }]);
    expect(axes(s).left).toMatchObject({ main: true, correspondingDatasets: ["Books"], title: "Books" });
    expect(axes(s).right).toMatchObject({ correspondingDatasets: ["Sum of Pages"], title: "Sum of Pages" });
  });

  it("makes a combo of mixed styles, each its Carbon type", () => {
    const s = spec({ series: [newSeries(), sum("pages", { style: "line" }), sum("rating", { style: "points", axis: "right" }), newSeries({ style: "lollipop", label: "Also" })] });
    expect(s.chart).toBe("ComboChart");
    expect(s.options.comboChartTypes).toEqual([
      { type: "grouped-bar", correspondingDatasets: ["Books", "Also"] },
      { type: "line", correspondingDatasets: ["Sum of Pages"] },
      { type: "scatter", options: { points: { enabled: true } }, correspondingDatasets: ["Sum of Rating"] },
    ]);
    expect(axes(s).left.correspondingDatasets).toEqual(["Books", "Sum of Pages", "Also"]);
    // A line drawn over bars is a timeline-less category axis; horizontal applies only to bars.
    expect(axes(spec({ horizontal: true, series: [newSeries(), sum("pages", { style: "line" })] })).bottom.mapsTo).toBe("key");
    const stacked = spec({ stack: "stacked", series: [newSeries(), newSeries({ label: "B" }), sum("pages", { style: "line" })] });
    expect((stacked.options.comboChartTypes as { type: string }[])[0].type).toBe("stacked-bar");
  });

  it("sets an axis's title, min, max and log", () => {
    const set = spec({ left: { title: "Count", min: 1, max: null, log: false } });
    expect(axes(set).left).toMatchObject({ title: "Count", domain: [1, 2] });
    expect(axes(spec({ left: { title: "", min: null, max: 10, log: false } })).left.domain).toEqual([0, 10]);
    expect(axes(spec({ left: { title: "", min: null, max: null, log: true } })).left.scaleType).toBe("log");
  });

  it("draws thresholds as lines on the value axis", () => {
    const s = spec({ thresholds: [{ value: 1, status: "info" }, { value: 2, status: "warning" }, { value: 5, status: "danger" }, { value: 8, status: "target" }] });
    expect(axes(s).left.thresholds).toMatchObject([
      { value: 1, label: "Info", fillColor: "var(--cds-support-info)" },
      { value: 2, label: "Warning", fillColor: "var(--cds-support-warning)" },
      { value: 5, label: "Danger", fillColor: "var(--cds-support-error)" },
      { value: 8, label: "Target", fillColor: "var(--cds-support-success)" },
    ]);
  });

  it("gives values their unit and decimals, and changes the spec with them", () => {
    const s = spec({ series: [sum("pages")], unit: "p", decimals: 1 });
    expect(axes(s).left.ticks!.formatter(300)).toBe("300.0 p");
    const tip = (s.options.tooltip as { valueFormatter(v: unknown, label: string): string }).valueFormatter;
    expect([tip(300, "Sum of Pages"), tip("Novel", "Genre")]).toEqual(["300.0 p", "Novel"]);
    expect(JSON.stringify(s)).not.toBe(JSON.stringify(spec({ series: [sum("pages")], unit: "kg", decimals: 1 })));
    const donut = spec({ chart: "pie", series: [sum("pages")], unit: "p" });
    const center = (donut.options.donut as { center: { number: number; numberFormatter(n: number): string } }).center;
    expect([center.number, center.numberFormatter(center.number)]).toEqual([580, "580 p"]);
  });

  it("makes a pie of fields, the rest of a total as Remaining", () => {
    const s = spec({ chart: "pie", parts: "fields", fields: ["pages", "rating"], total: { from: "number", number: 1000, field: null } });
    expect(s.data).toEqual([
      { group: "Pages", value: 580 },
      { group: "Rating", value: 11 },
      { group: "Remaining", value: 409 },
    ]);
  });

  it("shows one value on a meter, or parts on a proportional one", () => {
    const one = spec({ chart: "meter", parts: "one", series: [sum("pages")], total: { from: "number", number: 1000, field: null }, thresholds: [{ value: 50, status: "warning" }] });
    expect(one.data).toEqual([{ group: "Sum of Pages: 580 of 1000", value: 58 }]);
    expect(one.options.meter).toEqual({ status: { ranges: [{ range: [0, 50], status: "success" }, { range: [50, 100], status: "warning" }] } });
    const parts = spec({ chart: "meter", parts: "fields", fields: ["pages", "rating"], total: { from: "number", number: 1000, field: null } });
    // Carbon's statuses only: a target is its success, an info none of its own (left out).
    const targets = spec({ chart: "meter", parts: "one", series: [sum("pages")], total: { from: "number", number: 1000, field: null }, thresholds: [{ value: 20, status: "info" }, { value: 50, status: "target" }] });
    expect(targets.options.meter).toEqual({ status: { ranges: [{ range: [0, 20], status: "success" }, { range: [50, 100], status: "success" }] } });
    expect(parts.data).toEqual([{ group: "Pages", value: 580 }, { group: "Rating", value: 11 }]);
    expect((parts.options.meter as { proportional: { total: number } }).proportional.total).toBe(1000);
  });

  it("gives a gauge its status by its thresholds (a % of the total or values), its % with the decimals", () => {
    const gauge = (o: Partial<ChartOptions>) =>
      spec({ chart: "gauge", series: [sum("pages")], total: { from: "number", number: 1000, field: null }, thresholds: [{ value: 50, status: "warning" }, { value: 90, status: "danger" }], ...o });
    const percent = gauge({});
    expect(percent.data).toEqual([{ group: "value", value: 58 }]);
    expect((percent.options.gauge as { status: string }).status).toBe("warning");
    expect((gauge({ thresholdMode: "absolute" }).options.gauge as { status: string }).status).toBe("danger");
    // Carbon hands the number over as text.
    const shown = gauge({ decimals: 1, unit: "p" }).options.gauge as { numberFormatter(n: number | string): string };
    expect([shown.numberFormatter("58"), shown.numberFormatter(57.94)]).toEqual(["58.0", "57.9"]);
  });

  it("puts a scatter's items on X and Y, a series per Y field, each dot naming its item", () => {
    const x: ChartX = { ...byGenre, by: "item", field: "pages" };
    const scatter = spec({ chart: "scatter", x, series: [sum("rating"), sum("year")], splitBy: null });
    expect(scatter.chart).toBe("ScatterChart");
    expect(scatter.data[0]).toEqual({ group: "Rating", x: 300, y: 4, title: "Book 1", itemId: "1" });
    expect(new Set(scatter.data.map((d) => d.group))).toEqual(new Set(["Rating", "Year"]));
    expect(axes(scatter).left.includeZero).toBe(false);
    expect(spec({ chart: "scatter", x, series: [sum("rating")], sizeField: "year" }).chart).toBe("BubbleChart");
    const dated = spec({ chart: "scatter", x: { ...x, field: "read" }, series: [sum("rating")] });
    expect([dated.data[0].x, axes(dated).bottom.scaleType]).toEqual([new Date(2026, 0, 5), "time"]);
  });

  it("says what is missing instead of drawing nothing", () => {
    expect(draw({ chart: "scatter", x: { ...byGenre, by: "item", field: null } })).toEqual({ problem: "Choose the fields for X and Y." });
    expect(draw({ chart: "radar", fields: ["pages"] })).toHaveProperty("problem");
    expect(draw({ series: [newSeries(), newSeries({ value: "sum" })] })).toEqual({ problem: "Choose the field of series 2." });
    expect(draw({ chart: "pie", parts: "fields", fields: [] })).toEqual({ problem: "Choose the number fields that are the parts." });
    expect(draw({ chart: "histogram", spreadField: null })).toHaveProperty("problem");
    expect(draw({}, [])).toEqual({ problem: "No items to chart." });
  });
  it("breaks a line at a missing value when asked (a gap), else joins over it", () => {
    const byMonth2: ChartX = { ...byGenre, field: "read", dateStep: "month" };
    const books3 = [books[0], books[2]]; // January and March: February has none
    const avg = newSeries({ value: "avg", field: "pages" });
    const joined = chartSpec(input(books3), options({ chart: "line", x: byMonth2, series: [avg] }), "white") as ChartSpec;
    expect(joined.data.map((d) => (d as { value: number | null }).value)).toEqual([300, 80]);
    const gapped = chartSpec(input(books3), options({ chart: "line", x: byMonth2, series: [avg], missing: "gap" }), "white") as ChartSpec;
    expect(gapped.data.map((d) => (d as { value: number | null }).value)).toEqual([300, null, 80]);
    // Bars leave it out either way.
    const bars = chartSpec(input(books3), options({ chart: "bar", x: byMonth2, series: [avg], missing: "gap" }), "white") as ChartSpec;
    expect(bars.data).toHaveLength(2);
  });
});
