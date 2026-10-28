import { describe, expect, it } from "vitest";
import { CHART_KINDS, defaultChartOptions, type ChartInput, type ChartOptions } from "../domain/chart";
import { blankField, type Collection, type Item } from "../domain/model";
import { applyQuery, defaultQuery, type QueryContext } from "../domain/query";
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
const input = (groupBy: string | null): ChartInput => ({
  collection,
  result: applyQuery(collection, books, { ...defaultQuery(), groupBy }, ctx),
  groupField: collection.fields.find((f) => f.id === groupBy),
  ctx,
  locale: "en-GB",
});
const spec = (o: Partial<ChartOptions>, groupBy: string | null = "genre") => {
  const s = chartSpec(input(groupBy), { ...defaultChartOptions(collection), ...o }, "white");
  if ("problem" in s) throw new Error(s.problem);
  return s as ChartSpec;
};

describe("chartSpec", () => {
  it("draws every chart type once its settings are chosen", () => {
    const settings: Partial<ChartOptions> = { valueField: "pages", xField: "year", fields: ["pages", "rating", "year"], maxField: "pages" };
    for (const { kind } of CHART_KINDS) expect(spec({ ...settings, chart: kind }).data.length, kind).toBeGreaterThan(0);
  });

  it("makes a bar per group, split into grouped or stacked bars, or a combo with a second value", () => {
    expect(spec({}).chart).toBe("SimpleBarChart");
    expect(spec({}).data).toEqual([
      { group: "Books", key: "Novel", value: 2 },
      { group: "Books", key: "Poetry", value: 1 },
    ]);
    expect(spec({ splitBy: "rating" }).chart).toBe("GroupedBarChart");
    const stacked = spec({ splitBy: "rating", stacked: true });
    expect([stacked.chart, (stacked.options.axes as { left: { stacked?: boolean } }).left.stacked]).toEqual(["StackedBarChart", true]);
    const horizontal = spec({ horizontal: true }).options.axes as { left: { mapsTo: string } };
    expect(horizontal.left.mapsTo).toBe("key");
    const combo = spec({ second: "avg", secondField: "rating" });
    expect(combo.chart).toBe("ComboChart");
    expect(combo.data).toContainEqual({ group: "Average Rating", key: "Poetry", value: 5 });
  });

  it("draws a line over time, as areas, compact as a sparkline", () => {
    const line = spec({ chart: "line", dateStep: "month" }, "read");
    expect(line.chart).toBe("LineChart");
    expect(line.data[0]).toEqual({ group: "Books", date: new Date(2026, 0, 1), value: 1 });
    expect((line.options.axes as { bottom: { scaleType: string } }).bottom.scaleType).toBe("time");
    expect(spec({ chart: "line", area: true }, "read").chart).toBe("AreaChart");
    expect(spec({ chart: "line", area: true, splitBy: "genre", percent: true }, "read").chart).toBe("StackedAreaChart");
    const compact = spec({ chart: "line", compact: true }, "read").options;
    expect([compact.height, (compact.axes as { left: { visible: boolean } }).left.visible]).toEqual(["4rem", false]);
  });

  it("says what is missing instead of drawing nothing", () => {
    const problem = (o: Partial<ChartOptions>) => chartSpec(input("genre"), { ...defaultChartOptions(collection), ...o }, "white");
    expect(problem({ chart: "scatter" })).toEqual({ problem: "Choose the fields for X and Y." });
    expect(problem({ chart: "radar", fields: ["pages"] })).toHaveProperty("problem");
    expect(chartSpec({ ...input("genre"), result: { groups: [], total: 0 } }, defaultChartOptions(collection), "white")).toEqual({ problem: "No items to chart." });
  });

  it("shows one value as a share of its max, coloured by its thresholds", () => {
    const gauge = spec({ chart: "gauge", value: "sum", valueField: "pages", max: 1000, warnAt: 50, dangerAt: 90 }, null);
    expect(gauge.data).toEqual([{ group: "value", value: 58 }]);
    expect((gauge.options.gauge as { status: string }).status).toBe("warning");
    const meter = spec({ chart: "meter", value: "sum", valueField: "pages", max: 1000, warnAt: 50 }, null);
    expect(meter.options.meter).toEqual({ status: { ranges: [{ range: [0, 50], status: "success" }, { range: [50, 100], status: "warning" }] } });
    const bullet = spec({ chart: "bullet", value: "sum", valueField: "pages", max: 250 });
    expect(bullet.data).toEqual([
      { title: "Novel", group: "Sum of Pages", value: 500, marker: 250 },
      { title: "Poetry", group: "Sum of Pages", value: 80, marker: 250 },
    ]);
  });

  it("puts a scatter's items on X and Y, each dot naming its item", () => {
    const scatter = spec({ chart: "scatter", xField: "pages", valueField: "rating" });
    expect(scatter.data[0]).toEqual({ group: "Novel", x: 300, y: 4, title: "Book 1", itemId: "1" });
    expect(spec({ chart: "scatter", xField: "pages", valueField: "rating", sizeField: "year" }).chart).toBe("BubbleChart");
  });
});
