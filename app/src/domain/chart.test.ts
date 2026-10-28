import { describe, expect, it } from "vitest";
import {
  aggregate,
  autoStep,
  chartCategories,
  chartTable,
  dateStepOf,
  defaultChartOptions,
  heatmapCells,
  normalizeChartOptions,
  percentOf,
  radarValues,
  scatterPoints,
  singleValue,
  statusOf,
  topCategories,
  type ChartInput,
  type ChartOptions,
} from "./chart";
import { blankField, type Collection, type Item } from "./model";
import { applyQuery, defaultQuery, type QueryContext } from "./query";

const collection: Collection = {
  id: "books", name: "Book", pluralName: "Books", icon: null, description: "", itemViews: [], spaceIds: null, createdAt: "", updatedAt: "",
  fields: [
    blankField("title", "Title", "string"),
    blankField("genre", "Genre", "string"),
    blankField("pages", "Pages", "number"),
    blankField("read", "Read", "date"),
    blankField("tags", "Tags", "string_list"),
    blankField("rating", "Rating", "number"),
    blankField("goal", "Goal", "number"),
  ],
};

const book = (id: string, genre: string | null, pages: number | null, read: string | null, tags: string[] = [], rating: number | null = null): Item => ({
  id, collectionId: "books", spaceId: "s", createdAt: "", updatedAt: "",
  values: { title: `Book ${id}`, genre, pages, read, tags, rating, goal: 400 },
});

const books = [
  book("1", "Novel", 300, "2026-01-05", ["a", "b"], 4),
  book("2", "Novel", 200, "2026-01-20", ["a"], 2),
  book("3", "Poetry", 80, "2026-03-02", ["b"], 5),
  book("4", null, 120, null, [], null),
];

const ctx: QueryContext = { refLabel: () => "" };
const options = (patch: Partial<ChartOptions> = {}): ChartOptions => ({ ...defaultChartOptions(collection), ...patch });
const input = (groupBy: string | null, items = books): ChartInput => ({
  collection,
  result: applyQuery(collection, items, { ...defaultQuery(), groupBy }, ctx),
  groupField: collection.fields.find((f) => f.id === groupBy),
  ctx,
  locale: "en-GB",
});
const values = (t: ReturnType<typeof chartTable>) => t.points.map((p) => [p.category.label, p.series, p.value]);

describe("chart values", () => {
  it("count, add up, average and find the extremes of a number field", () => {
    const pages = collection.fields[2];
    expect(aggregate(books, "count", undefined)).toBe(4);
    expect(aggregate(books, "sum", pages)).toBe(700);
    expect(aggregate(books, "avg", pages)).toBe(175);
    expect([aggregate(books, "min", pages), aggregate(books, "max", pages)]).toEqual([80, 300]);
    expect(aggregate([book("x", null, null, null)], "sum", pages)).toBeNull();
  });

  it("are a bar per group, empty values left out unless asked for", () => {
    expect(values(chartTable(input("genre"), options()))).toEqual([
      ["Novel", "Books", 2],
      ["Poetry", "Books", 1],
    ]);
    expect(values(chartTable(input("genre"), options({ showEmpty: true, value: "sum", valueField: "pages" })))).toEqual([
      ["Novel", "Sum of Pages", 500],
      ["Poetry", "Sum of Pages", 80],
      ["No value", "Sum of Pages", 120],
    ]);
  });

  it("are one bar of all the items when the block isn't grouped", () => {
    expect(values(chartTable(input(null), options()))).toEqual([["Books", "Books", 4]]);
  });

  it("split each category into series, an item in each of its list's values", () => {
    const t = chartTable(input("genre"), options({ splitBy: "tags" }));
    expect(t.series).toEqual(["a", "b"]);
    expect(values(t)).toEqual([
      ["Novel", "a", 2],
      ["Poetry", "a", 0],
      ["Novel", "b", 1],
      ["Poetry", "b", 1],
    ]);
  });

  it("keep the largest categories, the rest as Other", () => {
    const cats = chartCategories(input("tags"), options({ showEmpty: true }));
    const kept = topCategories(cats, 1, (c) => c.items.length);
    expect(kept.map((c) => [c.label, c.items.length])).toEqual([
      ["a", 2],
      ["Other", 3], // b's and the one without tags (book 1, in a and b, counts in both)
    ]);
  });
});

describe("chart dates", () => {
  it("step by day, week, month or year, automatically by how far they spread", () => {
    expect(autoStep("2026-01-01", "2026-01-20")).toBe("day");
    expect(autoStep("2026-01-01", "2026-05-01")).toBe("week");
    expect(autoStep("2026-01-01", "2028-01-01")).toBe("month");
    expect(autoStep("2000-01-01", "2026-01-01")).toBe("year");
    expect(dateStepOf("2026-10-28", "week")).toEqual({ day: "2026-10-25", label: "Week 44 2026" });
    expect(dateStepOf("2026-10-28", "month", "en-GB")).toEqual({ day: "2026-10-01", label: "Oct 2026" });
    expect(dateStepOf("2026-10-28", "year").day).toBe("2026-01-01");
  });

  it("merge a date's groups into steps; a line gets every step, in time order", () => {
    const months = chartCategories(input("read"), options({ dateStep: "month" }));
    expect(months.map((c) => [c.label, c.items.length])).toEqual([
      ["Jan 2026", 2],
      ["Mar 2026", 1],
    ]);
    const line = chartTable(input("read"), options({ dateStep: "month", cumulative: true }), true);
    expect(line.time).toBe(true);
    expect(values(line)).toEqual([
      ["Jan 2026", "Books", 2],
      ["Feb 2026", "Books", 2],
      ["Mar 2026", "Books", 3],
    ]);
  });

  it("make a calendar heatmap of a date not split: weeks by weekdays", () => {
    const cells = heatmapCells(input("read", books.slice(0, 2)), options());
    expect(cells[0]).toEqual({ x: "4 Jan", y: "Mon", value: 1 });
    expect(cells.length).toBe(16); // 5 to 20 January
  });
});

describe("chart kinds", () => {
  it("measure one value against a number or a field (a single item's own)", () => {
    const one = singleValue(collection, [books[0]], options({ chart: "gauge", value: "sum", valueField: "pages", maxField: "goal" }));
    expect(one).toEqual({ value: 300, max: 400, label: "Sum of Pages" });
    expect(percentOf(one.value, one.max)).toBe(75);
    expect(percentOf(42, null)).toBe(42);
    expect(statusOf(75, 50, 90)).toBe("warning");
    expect(statusOf(95, 50, 90)).toBe("danger");
    expect(statusOf(10, 50, null)).toBe("success");
    expect(statusOf(10, null, null)).toBeNull();
  });

  it("put the items with an X and a Y on a scatter", () => {
    const points = scatterPoints(input("genre"), options({ chart: "scatter", xField: "pages", valueField: "rating" }));
    expect(points.map((p) => [p.item.id, p.series, p.x, p.y])).toEqual([
      ["1", "Novel", 300, 4],
      ["2", "Novel", 200, 2],
      ["3", "Poetry", 80, 5],
    ]);
  });

  it("draw a radar shape per group over its spokes, a count averaged", () => {
    const radar = radarValues(input("genre"), options({ chart: "radar", fields: ["pages", "rating"] }));
    expect(radar).toEqual([
      { series: "Novel", spoke: "Pages", value: 250 },
      { series: "Novel", spoke: "Rating", value: 3 },
      { series: "Poetry", spoke: "Pages", value: 80 },
      { series: "Poetry", spoke: "Rating", value: 5 },
    ]);
  });

  it("keep stored options valid", () => {
    const o = normalizeChartOptions({ chart: "pie", value: "median", valueField: "gone", splitBy: "genre", top: 7.6, fields: ["pages", "gone"], max: "x" }, collection);
    expect(o).toMatchObject({ chart: "pie", value: "count", valueField: "pages", splitBy: "genre", top: 8, fields: ["pages"], max: null });
    expect(normalizeChartOptions({ chart: "nope" }, collection).chart).toBe("bar");
    expect([normalizeChartOptions({ width: "s" }, collection).width, normalizeChartOptions({ width: "huge" }, collection).width, normalizeChartOptions({ width: 3 }, collection).width, normalizeChartOptions({ width: 50 }, collection).width]).toEqual([24, 120, 8, 50]);
    expect(normalizeChartOptions({ valueField: null }, collection).valueField).toBeNull();
  });
});
