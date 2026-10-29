import { describe, expect, it } from "vitest";
import {
  aggregate,
  autoStep,
  chartCategories,
  chartItems,
  chartTable,
  dateStepOf,
  defaultChartOptions,
  formatValue,
  heatmapCells,
  MOVING_WINDOW,
  newSeries,
  normalizeChartOptions,
  partsOf,
  percentOf,
  radarValues,
  scatterPoints,
  seriesLabel,
  singleValue,
  statOf,
  spreadValues,
  statusOf,
  statusRanges,
  thresholdPercent,
  topCategories,
  totalOf,
  transformValues,
  type Category,
  type ChartInput,
  type ChartOptions,
  type ChartSeries,
  type ChartX,
  CHART_WIDTH,
  GAUGE_WIDTH,
  normalizeWidth,
  widthAfterSwitch,
  widthCss,
  widthFromStop,
  widthLabel,
  widthToStop,
  regionValues,
} from "./chart";
import { blankField, fieldValue, type Collection, type Item } from "./model";
import { regionsOf } from "./regions";
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
    blankField("notes", "Notes", "markdown"),
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

// Measurements: each one placed on its own along a date, a date & time or a number.
const logs: Collection = {
  ...collection, id: "logs", name: "Log", pluralName: "Logs",
  fields: [
    blankField("label", "Label", "string"),
    blankField("person", "Person", "string"),
    blankField("day", "Day", "date"),
    blankField("when", "When", "datetime"),
    blankField("weight", "Weight", "number"),
  ],
};
const log = (id: string, person: string, day: string | null, weight: number): Item => ({
  id, collectionId: "logs", spaceId: "s", createdAt: "", updatedAt: "",
  values: { label: `M${id}`, person, day, when: day ? `${day}T08:00:00.000Z` : null, weight },
});
const measurements = [log("1", "Ann", "2026-02-03", 70), log("2", "Bob", "2026-02-01", 80), log("3", "Ann", "2026-02-05", 69), log("4", "Bob", null, 81)];

const ctx: QueryContext = { refLabel: () => "" };
const field = (c: Collection, id: string) => c.fields.find((f) => f.id === id)!;
/** Options with a patch, `x` merged into the default X axis. */
const options = (patch: Omit<Partial<ChartOptions>, "x"> = {}, x: Partial<ChartX> = {}, c = collection): ChartOptions => {
  const d = defaultChartOptions(c);
  return { ...d, ...patch, x: { ...d.x, ...x } };
};
const series = (patch: Partial<ChartSeries> = {}): ChartSeries => newSeries(patch);
const count = series();
const sumPages = series({ value: "sum", field: "pages" });
const input = (items = books, c = collection): ChartInput => ({ collection: c, items, ctx, locale: "en-GB" });
const byGenre = { by: "field", field: "genre" } as const;
const byRead = { by: "field", field: "read" } as const;
const cats = (list: Category[]) => list.map((c) => [c.label, c.items.map((i) => i.id)]);
const values = (t: ReturnType<typeof chartTable>) => t.points.map((p) => [p.category.label, p.series, p.value]);
const local = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

describe("normalizeChartOptions", () => {
  it("makes nothing into the defaults", () => {
    const d = defaultChartOptions(collection);
    for (const raw of [undefined, null, "x", [], {}]) {
      const o = normalizeChartOptions(raw, collection);
      expect({ ...o, series: o.series.map((s) => ({ ...s, id: "" })) }).toEqual({ ...d, series: d.series.map((s) => ({ ...s, id: "" })) });
    }
    expect(defaultChartOptions(collection)).toMatchObject({ chart: "bar", series: [{ value: "count", field: "pages" }], spreadField: "pages", width: "full", height: 24 });
  });

  it("drops fields that are gone (and the X axis's field)", () => {
    const o = normalizeChartOptions(
      {
        x: { by: "field", field: "gone" }, splitBy: "gone", fields: ["pages", "gone", 3, "rating"], total: { from: "field", field: "gone" },
        sizeField: "gone", compareField: "gone", spreadField: "gone", series: [{ value: "sum", field: "gone" }],
      },
      collection,
    );
    expect(o).toMatchObject({ x: { by: "field", field: null }, splitBy: null, fields: ["pages", "rating"], total: { from: "field", field: null }, sizeField: null, compareField: null });
    expect(o.series[0]).toMatchObject({ value: "sum", field: null });
    // A spread field that is gone falls back to the first number field; one cleared stays cleared.
    expect(o.spreadField).toBe("pages");
    expect(normalizeChartOptions({ spreadField: null }, collection).spreadField).toBeNull();
    // Meta fields can be picked too.
    expect(normalizeChartOptions({ x: { by: "field", field: "$created" }, splitBy: "tags" }, collection)).toMatchObject({ x: { field: "$created" }, splitBy: "tags" });
  });

  it("defaults unknown values and clamps numbers", () => {
    const o = normalizeChartOptions(
      {
        chart: "nope", scope: "x", x: { by: "x", order: "x", dateStep: "fortnight", showEmpty: "yes", top: 7.6 }, stack: "x", horizontal: 1, curve: "x", missing: "x",
        parts: "x", total: { from: "x", number: "5" }, compare: "median", decimals: 9, legend: "x", legendPosition: "x", height: 100, width: 3, thresholdMode: "x",
        xTitle: 4, unit: null, left: { title: "kg", min: 0, max: "x", log: true }, right: "x", bins: -2,
      },
      collection,
    );
    expect(o).toMatchObject({
      chart: "bar", scope: "items", x: { by: "none", order: "asc", dateStep: "auto", showEmpty: false, top: 8 }, stack: "none", horizontal: false, curve: "smooth",
      missing: "connect", parts: "groups", total: { from: "none", number: null }, compare: null, decimals: 6, legend: "auto", legendPosition: "bottom", height: 48, width: 8,
      thresholdMode: "percent", xTitle: "", unit: "", left: { title: "kg", min: 0, max: null, log: true }, right: { title: "", min: null, max: null, log: false }, bins: 0,
    });
    expect(normalizeChartOptions({ x: { top: -3 } }, collection).x.top).toBe(0);
    expect(normalizeChartOptions({ x: { top: 500 } }, collection).x.top).toBe(100);
    expect(normalizeChartOptions({ compare: "prev", decimals: 2.4, scope: "page", missing: "gap", height: "l", width: 50.4 }, collection)).toMatchObject({ compare: "prev", decimals: 2, scope: "page", missing: "gap", height: 32, width: 50 });
    // "Drawn as 0" is gone: joined over.
    expect(normalizeChartOptions({ missing: "zero" }, collection).missing).toBe("connect");
    expect([null, undefined, "2", NaN].map((decimals) => normalizeChartOptions({ decimals }, collection).decimals)).toEqual([null, null, null, null]);
    expect([NaN, "s", Infinity].map((width) => normalizeChartOptions({ width }, collection).width)).toEqual(["full", "full", "full"]);
  });

  it("validates each series", () => {
    const o = normalizeChartOptions(
      {
        series: [
          { id: "a", value: "median", field: "pages", label: 3, style: "weird", axis: "x", transform: "x", window: 1 },
          { id: "a", value: "avg", field: "rating", label: "Mine", style: "line", axis: "right", transform: "moving", window: 99 },
          { value: "sum", style: null, window: 4.4 },
          "x",
        ],
      },
      collection,
    );
    expect(o.series.map(({ id: _, ...s }) => s)).toEqual([
      { value: "count", field: "pages", label: "", style: null, axis: "left", transform: "none", window: MOVING_WINDOW.min },
      { value: "avg", field: "rating", label: "Mine", style: "line", axis: "right", transform: "moving", window: MOVING_WINDOW.max },
      { value: "sum", field: null, label: "", style: null, axis: "left", transform: "none", window: 4 },
      { value: "count", field: null, label: "", style: null, axis: "left", transform: "none", window: MOVING_WINDOW.initial },
    ]);
    // Ids stay, a repeated or missing one is made anew.
    expect(o.series[0].id).toBe("a");
    expect(new Set(o.series.map((s) => s.id)).size).toBe(4);
    // No series: the default one.
    expect(normalizeChartOptions({ series: [] }, collection).series).toMatchObject([{ value: "count", field: "pages" }]);
  });

  it("keeps thresholds with a number, a warning unless a danger", () => {
    const o = normalizeChartOptions({ thresholds: [{ value: 50, status: "danger" }, { value: "x" }, { value: 70, status: "weird" }, null, { value: Infinity }], thresholdMode: "absolute" }, collection);
    expect(o.thresholds).toEqual([{ value: 50, status: "danger" }, { value: 70, status: "warning" }]);
    expect(o.thresholdMode).toBe("absolute");
    expect(normalizeChartOptions({ thresholds: "x" }, collection).thresholds).toEqual([]);
  });
});

describe("chart width", () => {
  it("is 8 to 99 rem, then Full width as the slider's last stop", () => {
    expect([CHART_WIDTH.min, CHART_WIDTH.max, CHART_WIDTH.stop]).toEqual([8, 99, 100]);
    expect([8, 50, 99].map((w) => widthToStop(w))).toEqual([8, 50, 99]);
    expect(widthToStop("full")).toBe(100);
    expect([8, 99, 100].map(widthFromStop)).toEqual([8, 99, "full"]);
    expect([widthLabel(99), widthLabel("full")]).toEqual(["99rem", "Full width"]);
    expect([widthCss(24), widthCss("full")]).toEqual(["24rem", undefined]);
  });
  it("reads old and odd stored widths: 100 and more (the old maximum was 120) is Full width", () => {
    expect([120, 100, 1000, "full", Infinity, NaN, "s", null, undefined].map(normalizeWidth)).toEqual(Array(9).fill("full"));
    expect([99, 98.6, 50.4, 8, 3, -4].map(normalizeWidth)).toEqual([99, 99, 50, 8, 8, 8]);
  });
  it("narrows a full-width chart for a gauge and widens it back", () => {
    expect(widthAfterSwitch({ chart: "bar", width: "full" }, "gauge")).toBe(GAUGE_WIDTH);
    expect(widthAfterSwitch({ chart: "gauge", width: GAUGE_WIDTH }, "stat")).toBe("full");
    expect(widthAfterSwitch({ chart: "bar", width: 40 }, "gauge")).toBe(40);
    expect(widthAfterSwitch({ chart: "gauge", width: 40 }, "bar")).toBe(40);
    expect(widthAfterSwitch({ chart: "bar", width: GAUGE_WIDTH }, "line")).toBe(GAUGE_WIDTH);
  });
});

describe("aggregate", () => {
  it("counts, adds up, averages and finds the extremes of a number field", () => {
    const pages = field(collection, "pages");
    expect(aggregate(books, "count", undefined)).toBe(4);
    expect(aggregate(books, "sum", pages)).toBe(700);
    expect(aggregate(books, "avg", pages)).toBe(175);
    expect([aggregate(books, "min", pages), aggregate(books, "max", pages)]).toEqual([80, 300]);
    expect(aggregate([book("x", null, null, null)], "sum", pages)).toBeNull();
    expect(aggregate([], "count", pages)).toBe(0);
    expect(aggregate(books, "sum", undefined)).toBeNull();
  });

  it("takes the first, last and previous value, in the items' order", () => {
    const pages = field(collection, "pages");
    expect([aggregate(books, "first", pages), aggregate(books, "last", pages), aggregate(books, "prev", pages)]).toEqual([300, 120, 80]);
    expect(aggregate(books.slice(0, 1), "prev", pages)).toBeNull();
    // Items without a value are passed over.
    const rating = field(collection, "rating");
    expect(aggregate(books, "last", rating)).toBe(5);
  });
});

describe("chartCategories", () => {
  it("is one category of all the items without an X axis (none without items)", () => {
    expect(cats(chartCategories(input(), options().x))).toEqual([["Books", ["1", "2", "3", "4"]]]);
    expect(chartCategories(input([]), options().x)).toEqual([]);
    // A field that is gone or can't group: the same.
    expect(cats(chartCategories(input(), { ...options().x, by: "field", field: "gone" }))).toEqual([["Books", ["1", "2", "3", "4"]]]);
    expect(cats(chartCategories(input(), { ...options().x, by: "field", field: "notes" }))).toEqual([["Books", ["1", "2", "3", "4"]]]);
  });

  it("is a field's groups, by value either way or the largest first, No value only when asked", () => {
    const x = options({}, byGenre).x;
    expect(cats(chartCategories(input(), x))).toEqual([["Novel", ["1", "2"]], ["Poetry", ["3"]]]);
    expect(cats(chartCategories(input(), { ...x, showEmpty: true }))).toEqual([["Novel", ["1", "2"]], ["Poetry", ["3"]], ["No value", ["4"]]]);
    expect(cats(chartCategories(input(), { ...x, order: "desc", showEmpty: true }))).toEqual([["Poetry", ["3"]], ["Novel", ["1", "2"]], ["No value", ["4"]]]);
    const tags = { ...x, field: "tags", order: "count" as const, showEmpty: true };
    expect(cats(chartCategories(input([books[2], books[3], books[1], books[0]]), tags))).toEqual([["a", ["2", "1"]], ["b", ["3", "1"]], ["No value", ["4"]]]); // a tie by value
    // Items keep the block's order within their group.
    expect(chartCategories(input([books[1], books[0]]), x)[0].items.map((i) => i.id)).toEqual(["2", "1"]);
  });

  it("gives a number field's groups their number, in numeric order", () => {
    const list = chartCategories(input(), { ...options().x, by: "field", field: "pages", showEmpty: true });
    expect(list.map((c) => [c.label, c.number])).toEqual([["80", 80], ["120", 120], ["200", 200], ["300", 300]]);
    const some = chartCategories(input([...books, book("5", null, null, null)]), { ...options().x, by: "field", field: "pages", showEmpty: true });
    expect(some.at(-1)).toMatchObject({ label: "No value", items: [expect.objectContaining({ id: "5" })] });
    expect(some.at(-1)!.number).toBeUndefined();
  });

  it("merges dates into steps of a day, week, month or year (automatic by their spread)", () => {
    const x = options({}, byRead).x;
    const steps = (dateStep: ChartX["dateStep"]) => chartCategories(input(), { ...x, dateStep }).map((c) => [c.label, c.day, c.items.length]);
    expect(steps("day")).toEqual([["2026-01-05", "2026-01-05", 1], ["2026-01-20", "2026-01-20", 1], ["2026-03-02", "2026-03-02", 1]]);
    expect(steps("week")).toEqual([["Week 2 2026", "2026-01-04", 1], ["Week 4 2026", "2026-01-18", 1], ["Week 10 2026", "2026-03-01", 1]]);
    expect(steps("auto")).toEqual(steps("week")); // 56 days
    expect(steps("month")).toEqual([["Jan 2026", "2026-01-01", 2], ["Mar 2026", "2026-03-01", 1]]);
    expect(steps("year")).toEqual([["2026", "2026-01-01", 3]]);
    expect(chartCategories(input(), { ...x, dateStep: "month" })[0].at).toBe(local(2026, 1, 1));
    expect(chartCategories(input(books.slice(0, 2)), { ...x, dateStep: "auto" }).map((c) => c.label)).toEqual(["2026-01-05", "2026-01-20"]);
  });

  it("keeps a date step's items in the block's order, and the steps in the asked order", () => {
    const x = { ...options({}, byRead).x, dateStep: "month" as const, order: "desc" as const };
    expect(cats(chartCategories(input(), x))).toEqual([["Mar 2026", ["3"]], ["Jan 2026", ["1", "2"]]]);
    expect(cats(chartCategories(input([books[1], books[0], books[2]]), x))).toEqual([["Mar 2026", ["3"]], ["Jan 2026", ["2", "1"]]]);
    // The largest first, No value still last.
    const counted = chartCategories(input(), { ...x, order: "count", showEmpty: true });
    expect(cats(counted)).toEqual([["Jan 2026", ["1", "2"]], ["Mar 2026", ["3"]], ["No value", ["4"]]]);
  });

  it("fills every step from the first to the last on a timeline, in time order", () => {
    const x = { ...options({}, byRead).x, dateStep: "month" as const, order: "desc" as const, showEmpty: true };
    const line = chartCategories(input(), x, true);
    expect(line.map((c) => [c.label, c.at, c.items.length])).toEqual([["Jan 2026", local(2026, 1, 1), 2], ["Feb 2026", local(2026, 2, 1), 0], ["Mar 2026", local(2026, 3, 1), 1]]);
    expect(chartCategories(input(), { ...x, dateStep: "week" }, true)).toHaveLength(9); // 4 Jan to 1 Mar
    expect(chartCategories(input([books[3]]), x, true).map((c) => c.label)).toEqual(["No value"]);
  });

  it("puts a date & time on its local day", () => {
    const list = chartCategories(input(measurements, logs), { ...options({}, {}, logs).x, by: "field", field: "when", dateStep: "month" });
    expect(cats(list)).toEqual([["Feb 2026", ["1", "2", "3"]]]);
  });

  it("counts a date & time in hours or minutes (automatically within three days), every step on a timeline", () => {
    const at = (id: string, when: string | null): Item => ({ ...log(id, "Ann", null, 70), values: { label: `M${id}`, when: when && new Date(when).toISOString() } });
    const items = [at("1", "2026-02-03T09:40"), at("2", "2026-02-03T08:10"), at("3", "2026-02-03T09:05"), at("4", null)];
    const x = { ...options({}, {}, logs).x, by: "field" as const, field: "when", dateStep: "hour" as const };
    expect(cats(chartCategories(input(items, logs), x))).toEqual([["08:00", ["2"]], ["09:00", ["1", "3"]]]);
    expect(chartCategories(input(items, logs), { ...x, dateStep: "auto" }).map((c) => c.label)).toEqual(["08:10", "09:05", "09:40"]); // an hour and a half: minutes
    expect(chartCategories(input([items[0], at("5", "2026-02-05T07:00")], logs), { ...x, dateStep: "auto" }).map((c) => c.label)).toEqual(["3 Feb, 09:00", "5 Feb, 07:00"]);
    expect(chartCategories(input(items, logs), x)[0].at).toBe(new Date(2026, 1, 3, 8).getTime());
    expect(cats(chartCategories(input(items, logs), { ...x, order: "count", showEmpty: true }))).toEqual([["09:00", ["1", "3"]], ["08:00", ["2"]], ["No value", ["4"]]]);
    expect(chartCategories(input(items.slice(0, 2), logs), { ...x, dateStep: "minute" }, true)).toHaveLength(91); // 8:10 to 9:40
    expect(cats(chartCategories(input([items[0], at("5", "2026-02-04T07:00")], logs), { ...x, dateStep: "hour" }))).toEqual([["3 Feb, 09:00", ["1"]], ["4 Feb, 07:00", ["5"]]]);
    // More than three days: in days; a date (no time) in days either way.
    expect(chartCategories(input([items[0], at("6", "2026-02-09T07:00")], logs), { ...x, dateStep: "auto" }).map((c) => c.day)).toEqual(["2026-02-03", "2026-02-09"]);
    expect(chartCategories(input(measurements, logs), { ...x, field: "day", dateStep: "hour" }).map((c) => c.day)).toEqual(["2026-02-01", "2026-02-03", "2026-02-05"]);
  });

  it("places each item at its date, date & time or number, those without one left out", () => {
    const x = { ...options({}, {}, logs).x, by: "item" as const };
    const byDay = chartCategories(input(measurements, logs), { ...x, field: "day" });
    expect(byDay.map((c) => [c.key, c.label, c.day, c.at])).toEqual([
      ["2", "M2", "2026-02-01", local(2026, 2, 1)],
      ["1", "M1", "2026-02-03", local(2026, 2, 3)],
      ["3", "M3", "2026-02-05", local(2026, 2, 5)],
    ]);
    const byWhen = chartCategories(input(measurements, logs), { ...x, field: "when" });
    expect(byWhen.map((c) => [c.key, c.at, c.day])).toEqual([
      ["2", Date.parse("2026-02-01T08:00:00.000Z"), undefined],
      ["1", Date.parse("2026-02-03T08:00:00.000Z"), undefined],
      ["3", Date.parse("2026-02-05T08:00:00.000Z"), undefined],
    ]);
    expect(chartCategories(input(measurements, logs), { ...x, field: "weight" }).map((c) => [c.key, c.number])).toEqual([["3", 69], ["1", 70], ["2", 80], ["4", 81]]);
  });

  it("without a field (or one that can't place them) puts the items side by side by their title, in the block's order", () => {
    const x = { ...options({}, {}, logs).x, by: "item" as const };
    const order = [measurements[2], measurements[0], measurements[3]];
    expect(cats(chartCategories(input(order, logs), x))).toEqual([["M3", ["3"]], ["M1", ["1"]], ["M4", ["4"]]]);
    expect(cats(chartCategories(input(order, logs), { ...x, field: "person" }))).toEqual([["M3", ["3"]], ["M1", ["1"]], ["M4", ["4"]]]);
  });
});

describe("chart dates", () => {
  it("step automatically by how far they spread", () => {
    expect(autoStep("2026-01-01", "2026-01-20")).toBe("day");
    expect(autoStep("2026-01-01", "2026-02-01")).toBe("day");
    expect(autoStep("2026-01-01", "2026-05-01")).toBe("week");
    expect(autoStep("2026-01-01", "2028-01-01")).toBe("month");
    expect(autoStep("2000-01-01", "2026-01-01")).toBe("year");
    expect(autoStep("2026-01-01", "2026-01-01")).toBe("day");
  });

  it("name a day's step", () => {
    expect(dateStepOf("2026-10-28", "day")).toEqual({ day: "2026-10-28", label: "2026-10-28" });
    expect(dateStepOf("2026-10-28", "week")).toEqual({ day: "2026-10-25", label: "Week 44 2026" });
    expect(dateStepOf("2026-10-28", "month", "en-GB")).toEqual({ day: "2026-10-01", label: "Oct 2026" });
    expect(dateStepOf("2026-10-28", "year")).toEqual({ day: "2026-01-01", label: "2026" });
  });
});

describe("topCategories", () => {
  const item = (id: string) => book(id, null, null, null);
  const [i1, i2, i3] = [item("1"), item("2"), item("3")];
  const list: Category[] = [
    { key: "x", label: "X", items: [i1] },
    { key: "y", label: "Y", items: [i1, i2, i3] },
    { key: "z", label: "Z", items: [i1, i2] },
  ];

  it("keeps the largest in their order, the rest as Other, an item in several of them once", () => {
    const top = topCategories(list, 1, (c) => c.items.length);
    expect(top.map((c) => [c.label, c.items.map((i) => i.id)])).toEqual([["Y", ["1", "2", "3"]], ["Other", ["1", "2"]]]);
    expect(topCategories(list, 2, (c) => c.items.length).map((c) => c.label)).toEqual(["Y", "Z", "Other"]);
    expect(topCategories(list, 2, (c) => (c.key === "z" ? null : c.items.length)).map((c) => c.label)).toEqual(["X", "Y", "Other"]);
  });

  it("keeps all with a top of 0 or at least as many as there are", () => {
    expect(topCategories(list, 0, (c) => c.items.length)).toBe(list);
    expect(topCategories(list, 3, (c) => c.items.length)).toBe(list);
  });
});

describe("transformValues", () => {
  it("makes a running total, the change from the step before or a moving average, missing values passed over", () => {
    const v = [1, null, 2, 3];
    expect(transformValues(v, "none")).toBe(v);
    expect(transformValues(v, "cumulative")).toEqual([1, null, 3, 6]);
    expect(transformValues([5, null, 7, 4], "change")).toEqual([null, null, 2, -3]);
    expect(transformValues([2, 4, null, 6, 10], "moving", 2)).toEqual([2, 3, null, 5, 8]);
    expect(transformValues([3, 6, 9, 12], "moving")).toEqual([3, 4.5, 6, 9]);
    expect(transformValues([], "cumulative")).toEqual([]);
  });
});

describe("chartTable", () => {
  it("is a value per category of each series", () => {
    const t = chartTable(input(), options({ series: [count, sumPages] }, byGenre));
    expect(t.series.map((s) => [s.name, s.series.id, s.split])).toEqual([["Books", count.id, undefined], ["Sum of Pages", sumPages.id, undefined]]);
    expect(values(t)).toEqual([
      ["Novel", "Books", 2],
      ["Poetry", "Books", 1],
      ["Novel", "Sum of Pages", 500],
      ["Poetry", "Sum of Pages", 80],
    ]);
    expect([t.categoryLabel, t.time, t.numeric]).toEqual(["Genre", false, false]);
    expect(chartTable(input(), options({ xTitle: " Kind " }, byGenre)).categoryLabel).toBe("Kind");
    expect(values(chartTable(input(), options()))).toEqual([["Books", "Books", 4]]);
    expect(chartTable(input(), options()).categoryLabel).toBe("");
    expect(chartTable(input([]), options({}, byGenre))).toMatchObject({ categories: [], points: [], time: false, numeric: false });
  });

  it("splits every series by a field: named by the split alone with one series, “Label · Split” with several", () => {
    const one = chartTable(input(), options({ splitBy: "tags" }, byGenre));
    expect(one.series.map((s) => [s.name, s.split])).toEqual([["a", "a"], ["b", "b"]]);
    expect(values(one)).toEqual([
      ["Novel", "a", 2],
      ["Poetry", "a", 0],
      ["Novel", "b", 1],
      ["Poetry", "b", 1],
    ]);
    const avg = series({ value: "avg", field: "pages" });
    const several = chartTable(input(), options({ splitBy: "tags", series: [sumPages, avg] }, byGenre));
    expect(values(several)).toEqual([
      ["Novel", "Sum of Pages · a", 500],
      ["Poetry", "Sum of Pages · a", 0],
      ["Novel", "Sum of Pages · b", 300],
      ["Poetry", "Sum of Pages · b", 80],
      ["Novel", "Average Pages · a", 250],
      ["Poetry", "Average Pages · a", null],
      ["Novel", "Average Pages · b", 300],
      ["Poetry", "Average Pages · b", 80],
    ]);
  });

  it("splits by the largest values first, No value as a series when asked for", () => {
    const t = chartTable(input(), options({ splitBy: "genre" }, { showEmpty: true }));
    expect(t.series.map((s) => s.name)).toEqual(["Novel", "No value", "Poetry"]);
    expect(values(t)).toEqual([["Books", "Novel", 2], ["Books", "No value", 1], ["Books", "Poetry", 1]]);
    expect(chartTable(input(), options({ splitBy: "genre" })).series.map((s) => s.name)).toEqual(["Novel", "Poetry"]);
  });

  it("isn't split by the X axis's own field", () => {
    const t = chartTable(input(), options({ splitBy: "genre" }, byGenre));
    expect(values(t)).toEqual([["Novel", "Books", 2], ["Poetry", "Books", 1]]);
  });

  it("gives every drawn series a name of its own", () => {
    const t = chartTable(input(), options({ series: [count, series(), series({ label: "Books" })] }));
    expect(t.series.map((s) => s.name)).toEqual(["Books", "Books (2)", "Books (3)"]);
    expect(new Set(t.points.map((p) => p.series)).size).toBe(3);
  });

  it("leaves missing values out unless they are drawn as 0; a count or sum of no items is 0", () => {
    const avg = series({ value: "avg", field: "pages" });
    const max = series({ value: "max", field: "rating" });
    const x = { ...byRead, dateStep: "month" as const };
    expect(values(chartTable(input(), options({ series: [count, sumPages, avg, max] }, x), true))).toEqual([
      ["Jan 2026", "Books", 2],
      ["Feb 2026", "Books", 0],
      ["Mar 2026", "Books", 1],
      ["Jan 2026", "Sum of Pages", 500],
      ["Feb 2026", "Sum of Pages", 0],
      ["Mar 2026", "Sum of Pages", 80],
      ["Jan 2026", "Average Pages", 250],
      ["Feb 2026", "Average Pages", null],
      ["Mar 2026", "Average Pages", 80],
      ["Jan 2026", "Maximum Rating", 4],
      ["Feb 2026", "Maximum Rating", null],
      ["Mar 2026", "Maximum Rating", 5],
    ]);
    // A gap or not, the value stays missing (chartSpec breaks the line or joins over it).
    expect(chartTable(input(), options({ series: [avg], missing: "gap" }, x), true).points.map((p) => p.value)).toEqual([250, null, 80]);
    // Items without the field's value: not 0, missing.
    expect(chartTable(input([books[3]].map((b) => ({ ...b, values: { ...b.values, genre: "Essay", rating: null } }))), options({ series: [max] }, byGenre)).points[0].value).toBeNull();
  });

  it("is on a time axis by date steps or dates, on a number axis by numbers", () => {
    const t = chartTable(input(), options({}, { ...byRead, dateStep: "month" }), true);
    expect([t.time, t.numeric]).toEqual([true, false]);
    expect(t.categories.map((c) => c.at)).toEqual([local(2026, 1, 1), local(2026, 2, 1), local(2026, 3, 1)]);
    expect(chartTable(input(), options({}, { by: "field", field: "pages" }))).toMatchObject({ time: false, numeric: true, categoryLabel: "Pages" });
    // "No value" can't be placed on either axis.
    expect(chartTable(input(), options({}, { by: "field", field: "pages", showEmpty: true })).numeric).toBe(true); // every book has pages
    expect(chartTable(input(), options({}, { ...byRead, showEmpty: true })).time).toBe(false);
    const weight = series({ value: "sum", field: "weight" });
    expect(chartTable(input(measurements, logs), options({ series: [weight] }, { by: "item", field: "when" }, logs))).toMatchObject({ time: true, numeric: false, categoryLabel: "When" });
    expect(chartTable(input(measurements, logs), options({ series: [weight] }, { by: "item", field: "weight" }, logs))).toMatchObject({ time: false, numeric: true });
  });

  it("transforms each series along the X axis: a running total, the change, a moving average", () => {
    const x = { ...byRead, dateStep: "month" as const };
    const transformed = [series({ transform: "cumulative" }), series({ value: "sum", field: "pages", transform: "change" }), series({ value: "avg", field: "pages", transform: "moving", window: 2 })];
    const t = chartTable(input(), options({ series: transformed }, x), true);
    expect(t.points.map((p) => [p.series, p.value])).toEqual([
      ["Books", 2],
      ["Books", 2],
      ["Books", 3],
      ["Sum of Pages", null],
      ["Sum of Pages", -500],
      ["Sum of Pages", 80],
      ["Average Pages", 250],
      ["Average Pages", null],
      ["Average Pages", 165],
    ]);
  });

  it("keeps the largest categories by the first series, the rest as Other (not on a timeline)", () => {
    const t = chartTable(input(), options({ series: [sumPages, count] }, { ...byGenre, showEmpty: true, top: 1 }));
    expect(values(t)).toEqual([
      ["Novel", "Sum of Pages", 500],
      ["Other", "Sum of Pages", 200],
      ["Novel", "Books", 2],
      ["Other", "Books", 2],
    ]);
    // Other holds an item in several of the rest's groups once.
    const tags = chartTable(input(), options({}, { by: "field", field: "tags", showEmpty: true, top: 1 }));
    expect(values(tags)).toEqual([["a", "Books", 2], ["Other", "Books", 3]]);
    expect(chartTable(input(), options({}, { ...byRead, dateStep: "month", top: 1 }), true).categories).toHaveLength(3);
  });

  it("places measurements one by one: a split series has no value at the others' (not 0)", () => {
    const weight = series({ value: "sum", field: "weight" });
    const t = chartTable(input(measurements, logs), options({ series: [weight], splitBy: "person" }, { by: "item", field: "day" }, logs));
    expect(values(t)).toEqual([
      ["M2", "Ann", null],
      ["M1", "Ann", 70],
      ["M3", "Ann", 69],
      ["M2", "Bob", 80],
      ["M1", "Bob", null],
      ["M3", "Bob", null],
    ]);
    // Unsplit, a value is named after its field.
    expect(chartTable(input(measurements, logs), options({ series: [weight] }, { by: "item", field: "day" }, logs)).series.map((s) => s.name)).toEqual(["Weight"]);
  });
});

describe("seriesLabel", () => {
  it("is the series' label, or what it measures", () => {
    expect(seriesLabel(series({ label: "  Mine " }), collection)).toBe("Mine");
    expect(seriesLabel(count, collection)).toBe("Books");
    expect(seriesLabel(sumPages, collection)).toBe("Sum of Pages");
    expect(["avg", "min", "max", "first", "last"].map((value) => seriesLabel(series({ value: value as ChartSeries["value"], field: "pages" }), collection))).toEqual([
      "Average Pages",
      "Minimum Pages",
      "Maximum Pages",
      "First Pages",
      "Last Pages",
    ]);
    expect(seriesLabel(series({ value: "sum", field: "gone" }), collection)).toBe("Sum of ?");
  });

  it("on items placed one by one is the field's name (a count stays a count)", () => {
    const x = options({}, { by: "item", field: "read" }).x;
    expect(seriesLabel(sumPages, collection, x)).toBe("Pages");
    expect(seriesLabel(count, collection, x)).toBe("Books");
    expect(seriesLabel(series({ value: "avg", field: "pages", label: "Mine" }), collection, x)).toBe("Mine");
  });
});

describe("partsOf and totalOf", () => {
  it("makes the groups the parts, by the first series' value", () => {
    const p = partsOf(input(), options({ chart: "pie" }, byGenre));
    expect(p).toEqual({ parts: [{ name: "Novel", value: 2 }, { name: "Poetry", value: 1 }], total: 3, label: "Books" });
    expect(partsOf(input(), options({ chart: "pie", series: [sumPages, count] }, byGenre)).parts).toEqual([{ name: "Novel", value: 500 }, { name: "Poetry", value: 80 }]);
    expect(partsOf(input(), options({ chart: "pie" })).parts).toEqual([{ name: "Books", value: 4 }]);
    // A running total is no part of a whole.
    expect(partsOf(input(), options({ chart: "pie", series: [series({ transform: "cumulative" })] }, byGenre)).parts.map((x) => x.value)).toEqual([2, 1]);
    // Top: the rest as Other.
    expect(partsOf(input(), options({ chart: "pie" }, { ...byGenre, top: 1, showEmpty: true })).parts).toEqual([{ name: "Novel", value: 2 }, { name: "Other", value: 2 }]);
  });

  it("makes number fields the parts, by the first series' aggregate (a count as a sum)", () => {
    const fields = ["pages", "rating", "gone"];
    expect(partsOf(input(), options({ chart: "pie", parts: "fields", fields }))).toEqual({ parts: [{ name: "Pages", value: 700 }, { name: "Rating", value: 11 }], total: 711, label: "Sum" });
    expect(partsOf(input(), options({ chart: "pie", parts: "fields", fields, series: [series({ value: "avg" })] }))).toMatchObject({ parts: [{ name: "Pages", value: 175 }, { name: "Rating", value: 11 / 3 }], label: "Average" });
    // A field no item has a value of is no part.
    expect(partsOf(input([books[3]]), options({ chart: "pie", parts: "fields", fields })).parts).toEqual([{ name: "Pages", value: 120 }]);
  });

  it("makes one value a part, against its total", () => {
    const o = options({ chart: "pie", parts: "one", series: [sumPages], total: { from: "number", number: 1000, field: null } });
    expect(partsOf(input(), o)).toEqual({ parts: [{ name: "Sum of Pages", value: 700 }, { name: "Remaining", value: 300, rest: true }], total: 1000, label: "Sum of Pages" });
    expect(partsOf(input(), o, false)).toEqual({ parts: [{ name: "Sum of Pages", value: 700 }], total: 1000, label: "Sum of Pages" });
    // Nothing to show: no Remaining either.
    expect(partsOf(input([]), o).parts).toEqual([]);
    expect(partsOf(input([]), { ...o, series: [count] }).parts).toEqual([]);
  });

  it("adds what is left of a total from a number or a field as Remaining, none when the parts reach it", () => {
    const pie = (total: ChartOptions["total"]) => partsOf(input(), options({ chart: "pie", total }, byGenre));
    expect(pie({ from: "number", number: 10, field: null })).toEqual({ parts: [{ name: "Novel", value: 2 }, { name: "Poetry", value: 1 }, { name: "Remaining", value: 7, rest: true }], total: 10, label: "Books" });
    expect(pie({ from: "number", number: 2, field: null })).toEqual({ parts: [{ name: "Novel", value: 2 }, { name: "Poetry", value: 1 }], total: 2, label: "Books" });
    expect(pie({ from: "number", number: 3, field: null }).parts).toHaveLength(2);
    // The goals added up (a count measured against the field's sum).
    expect(pie({ from: "field", number: null, field: "goal" }).parts.at(-1)).toEqual({ name: "Remaining", value: 1597, rest: true });
  });

  it("drops parts of 0 or less", () => {
    const items = [book("1", "A", 0, null), book("2", "B", -5, null), book("3", "C", 7, null)];
    expect(partsOf(input(items), options({ chart: "pie", series: [sumPages] }, byGenre)).parts).toEqual([{ name: "C", value: 7 }]);
  });

  it("takes the total from the option's number or the total field, made into one like the value", () => {
    const total = (t: ChartOptions["total"], s: ChartSeries[] = [count]) => totalOf(collection, books, { total: t, series: s });
    expect(total({ from: "none", number: 5, field: "goal" })).toBeNull();
    expect(total({ from: "number", number: 5, field: null })).toBe(5);
    expect(total({ from: "number", number: null, field: null })).toBeNull();
    expect(total({ from: "field", number: null, field: "goal" })).toBe(1600);
    expect(total({ from: "field", number: null, field: "goal" }, [series({ value: "avg", field: "pages" })])).toBe(400);
    expect(total({ from: "field", number: null, field: "gone" })).toBeNull();
    expect(total({ from: "field", number: null, field: "goal" }, [])).toBe(1600);
  });
});

describe("one value", () => {
  it("is measured against a number or a field (a single item's own)", () => {
    const one = singleValue(input([books[0]]), options({ chart: "gauge", series: [sumPages], total: { from: "field", number: null, field: "goal" } }));
    expect(one).toEqual({ value: 300, max: 400, label: "Sum of Pages" });
    expect(singleValue(input(), options({ chart: "gauge", series: [] }))).toEqual({ value: 4, max: null, label: "Books" });
    expect(singleValue(input([]), options({ chart: "gauge", series: [sumPages] })).value).toBeNull();
  });

  it("is a share of its max", () => {
    expect(percentOf(300, 400)).toBe(75);
    expect(percentOf(42, null)).toBe(42);
    expect(percentOf(5, 0)).toBe(0);
    expect(percentOf(null, 10)).toBeNull();
    expect(thresholdPercent({ value: 60, status: "warning" }, "percent", 400)).toBe(60);
    expect(thresholdPercent({ value: 300, status: "warning" }, "absolute", 400)).toBe(75);
    expect(thresholdPercent({ value: 300, status: "warning" }, "absolute", null)).toBe(300);
  });

  it("has the status of the highest threshold it reaches", () => {
    const t = [{ value: 90, status: "danger" as const }, { value: 50, status: "warning" as const }];
    expect([statusOf(75, t), statusOf(95, t), statusOf(90, t), statusOf(50, t), statusOf(10, t)]).toEqual(["warning", "danger", "danger", "warning", "success"]);
    expect(statusOf(null, t)).toBeNull();
    expect(statusOf(10, [])).toBeNull();
    // A danger below a warning: the highest reached wins.
    const low = [{ value: 30, status: "danger" as const }, { value: 60, status: "warning" as const }];
    expect([statusOf(40, low), statusOf(70, low)]).toEqual(["danger", "warning"]);
  });

  it("makes a meter's status ranges from 0 to 100", () => {
    expect(statusRanges([])).toBeNull();
    expect(statusRanges([{ value: 90, status: "danger" }, { value: 50, status: "warning" }])).toEqual([
      { range: [0, 50], status: "success" },
      { range: [50, 90], status: "warning" },
      { range: [90, 100], status: "danger" },
    ]);
    expect(statusRanges([{ value: 120, status: "danger" }, { value: -5, status: "warning" }])).toEqual([{ range: [0, 100], status: "warning" }]);
    expect(statusRanges([{ value: 40, status: "warning" }, { value: 40, status: "danger" }])).toEqual([
      { range: [0, 40], status: "success" },
      { range: [40, 100], status: "danger" },
    ]);
  });
});

describe("formatValue", () => {
  it("rounds a value (to 2 decimals unless set) and adds the unit", () => {
    const f = (n: number, decimals: number | null = null, unit = "") => formatValue(n, { decimals, unit });
    expect(f(72.456, null, "kg")).toBe("72.46 kg");
    expect(f(1.005)).toBe("1.01");
    expect(f(3)).toBe("3");
    expect(f(72.46, 1)).toBe("72.5");
    expect(f(72.46, 0)).toBe("72");
    expect(f(2, 2, "  ")).toBe("2.00");
    expect(f(-0.001)).toBe("0");
  });
});

describe("statOf", () => {
  // Pages: 300, 200, 80, 120 (the last value 120, the one before it 80, the average 175).
  const last = series({ value: "last", field: "pages" });
  it("compares the value with a baseline: an aggregate, the previous value or a number", () => {
    expect(statOf(input(), options({ chart: "stat", series: [last] }))).toEqual({ value: 120, label: "Last Pages", baseline: null, change: null, percent: null, trend: null });
    expect(statOf(input(), options({ chart: "stat", series: [last], compare: "prev" }))).toMatchObject({ baseline: 80, change: 40, percent: 50, trend: "good" });
    expect(statOf(input(), options({ chart: "stat", series: [last], compare: "avg" }))).toMatchObject({ baseline: 175, change: -55, trend: "bad" });
    expect(statOf(input(), options({ chart: "stat", series: [last], compare: "number", baseline: 100, better: "lower" }))).toMatchObject({ change: 20, percent: 20, trend: "bad" });
    expect(statOf(input(), options({ chart: "stat", series: [last], compare: "number", baseline: 120, better: "neither" })).trend).toBeNull();
    expect(statOf(input(), options({ chart: "stat", series: [last], compare: "number", baseline: 0 })).percent).toBeNull();
    // "Previous value" only after a last value.
    expect(statOf(input(), options({ chart: "stat", series: [sumPages], compare: "prev" })).baseline).toBeNull();
  });
});

describe("scatterPoints", () => {
  const scatter = (patch: Omit<Partial<ChartOptions>, "x"> = {}) => options({ chart: "scatter", series: [series({ value: "sum", field: "rating" })], ...patch }, { by: "item", field: "pages" });
  const dots = (o: ChartOptions, items = books) => scatterPoints(input(items), o).map((p) => [p.item.id, p.series, p.x, p.y, p.size]);

  it("puts the items with an X and a Y on it, named by the Y field", () => {
    expect(dots(scatter())).toEqual([
      ["1", "Rating", 300, 4, null],
      ["2", "Rating", 200, 2, null],
      ["3", "Rating", 80, 5, null],
    ]);
    expect(scatterPoints(input(), scatter())[0].title).toBe("Book 1");
    expect(dots(scatter({ sizeField: "goal" }))[0]).toEqual(["1", "Rating", 300, 4, 400]);
    // A date X stays its text; no X or no Y field: nothing.
    expect(dots({ ...scatter(), x: { ...scatter().x, field: "read" } })).toEqual([
      ["1", "Rating", "2026-01-05", 4, null],
      ["2", "Rating", "2026-01-20", 2, null],
      ["3", "Rating", "2026-03-02", 5, null],
    ]);
    expect(dots({ ...scatter(), x: { ...scatter().x, field: null } })).toEqual([]);
    expect(dots(scatter({ series: [count] }))).toEqual([]);
  });

  it("draws a dot per Y series", () => {
    expect(dots(scatter({ series: [series({ field: "rating" }), series({ field: "goal" })] }))).toEqual([
      ["1", "Rating", 300, 4, null],
      ["2", "Rating", 200, 2, null],
      ["3", "Rating", 80, 5, null],
      ["1", "Goal", 300, 400, null],
      ["2", "Goal", 200, 400, null],
      ["3", "Goal", 80, 400, null],
      ["4", "Goal", 120, 400, null],
    ]);
  });

  it("colours the dots by Split by (an item in each of its values; with several series, “Field · Split”)", () => {
    expect(dots(scatter({ splitBy: "genre" }))).toEqual([
      ["1", "Novel", 300, 4, null],
      ["2", "Novel", 200, 2, null],
      ["3", "Poetry", 80, 5, null],
    ]);
    expect(dots(scatter({ splitBy: "tags" }))).toEqual([
      ["1", "a", 300, 4, null],
      ["1", "b", 300, 4, null],
      ["2", "a", 200, 2, null],
      ["3", "b", 80, 5, null],
    ]);
    const two = dots(scatter({ splitBy: "genre", series: [series({ field: "rating" }), series({ field: "goal" })] }));
    expect(two.map((d) => d[1])).toEqual(["Rating · Novel", "Rating · Novel", "Rating · Poetry", "Goal · Novel", "Goal · Novel", "Goal · Poetry", "Goal · No value"]);
  });
});

describe("spreadValues", () => {
  const spread = (by: "x" | "split", patch: Omit<Partial<ChartOptions>, "x"> = {}, x: Partial<ChartX> = {}, items = books) => spreadValues(input(items), options({ chart: "histogram", ...patch }, x), by);

  it("are the spread field's values, per Split by", () => {
    expect(spread("split")).toEqual([300, 200, 80, 120].map((value) => ({ series: "Pages", value })));
    expect(spread("split", { splitBy: "genre" })).toEqual([{ series: "Novel", value: 300 }, { series: "Novel", value: 200 }, { series: "Poetry", value: 80 }]);
    expect(spread("split", { splitBy: "genre" }, { showEmpty: true }).map((v) => v.series)).toEqual(["Novel", "Novel", "No value", "Poetry"]);
    expect(spread("split", { spreadField: null })).toEqual([]);
    expect(spread("split", {}, {}, [])).toEqual([]);
  });

  it("are the spread field's values per category of the X axis", () => {
    expect(spread("x", {}, byGenre)).toEqual([{ series: "Novel", value: 300 }, { series: "Novel", value: 200 }, { series: "Poetry", value: 80 }]);
    expect(spread("x").map((v) => v.series)).toEqual(["Pages", "Pages", "Pages", "Pages"]);
  });

  it("make dates their time in ms (a day its local midnight)", () => {
    expect(spread("split", { spreadField: "read" })).toEqual([local(2026, 1, 5), local(2026, 1, 20), local(2026, 3, 2)].map((value) => ({ series: "Read", value })));
    const times = spreadValues(input(measurements, logs), options({ chart: "histogram", spreadField: "when" }, {}, logs), "split");
    expect(times.map((v) => v.value)).toEqual(["2026-02-03", "2026-02-01", "2026-02-05"].map((d) => Date.parse(`${d}T08:00:00.000Z`)));
  });
});

describe("radarValues", () => {
  it("is a shape per category over its spokes, a count averaged", () => {
    expect(radarValues(input(), options({ chart: "radar", fields: ["pages", "rating", "gone"] }, byGenre))).toEqual([
      { series: "Novel", spoke: "Pages", value: 250 },
      { series: "Novel", spoke: "Rating", value: 3 },
      { series: "Poetry", spoke: "Pages", value: 80 },
      { series: "Poetry", spoke: "Rating", value: 5 },
    ]);
    expect(radarValues(input(), options({ chart: "radar", fields: ["pages"], series: [series({ value: "max" })] }, byGenre)).map((v) => v.value)).toEqual([300, 80]);
    expect(radarValues(input(), options({ chart: "radar", fields: ["pages", "rating"] }))).toEqual([
      { series: "Books", spoke: "Pages", value: 175 },
      { series: "Books", spoke: "Rating", value: 11 / 3 },
    ]);
  });
});

describe("heatmapCells", () => {
  it("is a calendar of a date not split: weeks by weekdays", () => {
    const cells = heatmapCells(input(books.slice(0, 2)), options({ chart: "heatmap" }, byRead));
    expect(cells.length).toBe(16); // 5 to 20 January
    expect(cells[0]).toEqual({ x: "4 Jan", y: "Mon", value: 1 });
    expect(cells[1]).toEqual({ x: "4 Jan", y: "Tue", value: 0 });
    expect(cells[6]).toEqual({ x: "11 Jan", y: "Sun", value: 0 });
    expect(cells.at(-1)).toEqual({ x: "18 Jan", y: "Tue", value: 1 });
    // A day without items adds up to 0; its average is missing (unless drawn as 0).
    const avg = series({ value: "avg", field: "pages" });
    expect(heatmapCells(input(books.slice(0, 2)), options({ chart: "heatmap", series: [sumPages] }, byRead)).map((c) => c.value).slice(0, 2)).toEqual([300, 0]);
    expect(heatmapCells(input(books.slice(0, 2)), options({ chart: "heatmap", series: [avg] }, byRead))[1].value).toBeNull();
  });

  it("has no calendar cells without dates (also with No value shown)", () => {
    expect(heatmapCells(input([books[3]]), options({ chart: "heatmap" }, { ...byRead, showEmpty: true }))).toEqual([]);
    expect(heatmapCells(input([]), options({ chart: "heatmap" }, byRead))).toEqual([]);
  });

  it("is categories × Split by (the first series alone), otherwise", () => {
    expect(heatmapCells(input(), options({ chart: "heatmap", splitBy: "tags", series: [count, sumPages] }, byGenre))).toEqual([
      { x: "Novel", y: "a", value: 2 },
      { x: "Poetry", y: "a", value: 0 },
      { x: "Novel", y: "b", value: 1 },
      { x: "Poetry", y: "b", value: 1 },
    ]);
    expect(heatmapCells(input(), options({ chart: "heatmap" }, byGenre))).toEqual([{ x: "Novel", y: "Books", value: 2 }, { x: "Poetry", y: "Books", value: 1 }]);
    expect(heatmapCells(input(), options({ chart: "heatmap", splitBy: "genre" }, { ...byRead, dateStep: "month" }))).toEqual([
      { x: "Jan 2026", y: "Novel", value: 2 },
      { x: "Mar 2026", y: "Novel", value: 0 },
      { x: "Jan 2026", y: "Poetry", value: 0 },
      { x: "Mar 2026", y: "Poetry", value: 1 },
    ]);
  });
});

describe("chartItems", () => {
  const result = applyQuery(collection, books, { ...defaultQuery(), groupBy: "tags" }, ctx);

  it("is every item of the block once, in its order", () => {
    expect(result.groups.flatMap((g) => g.items).length).toBe(5); // book 1 is in a and b
    expect(chartItems(result, "items", null).map((i) => i.id)).toEqual(["1", "2", "3", "4"]);
    expect(chartItems(result, "items", books[2]).map((i) => i.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("is the page's item alone with scope page (the block's without one)", () => {
    const page = book("9", null, 1, null);
    expect(chartItems(result, "page", page)).toEqual([page]);
    expect(chartItems(result, "page", null).map((i) => i.id)).toEqual(["1", "2", "3", "4"]);
    expect(fieldValue(chartItems(result, "page", page)[0], field(collection, "pages"))).toBe(1);
  });
});

describe("regionValues", () => {
  const countries = regionsOf([
    { properties: { name: "Netherlands", id: "NL" } },
    { properties: { name: "Denmark", id: "DK" } },
    { properties: { name: "Belgium", id: "BE" } },
  ]);
  const visits = [book("1", "Netherlands", 300, null), book("2", "NL", 200, null), book("3", "Denmark", 80, null), book("4", "Atlantis", 10, null), book("5", null, 5, null)];
  const values = (o: ChartOptions) => {
    const r = regionValues(input(visits), o, countries);
    return { values: r.values.map((v) => [v.region.key, v.value]), unmatched: r.unmatched };
  };

  it("are the first series' value of each region's items, a region's code and name one region", () => {
    expect(values(options({ chart: "choropleth", series: [count] }, byGenre))).toEqual({
      values: [["Denmark", 1], ["Netherlands", 2]],
      unmatched: [{ label: "Atlantis", items: 1 }],
    });
    expect(values(options({ chart: "choropleth", series: [sumPages] }, byGenre)).values).toEqual([["Denmark", 80], ["Netherlands", 500]]);
  });
});
