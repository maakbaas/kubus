// Charts: what a chart block shows, worked out from its items. Storage-free and UI-free (the
// block, views/ChartBlock.tsx, draws it with Carbon Charts: views/chartSpec.ts).
//
// A chart is a block like a table: its filter picks the items, and its grouping (the block's
// "Group by", in Sort and group) gives the categories: the bars, the slices, the points of a line.
// The options only say what is measured (a count, or the sum, average, … of a number field), how
// the categories are split into series ("Split by"), how dates are stepped and how it looks. So a
// table grouped by Status shown as a chart is a bar per status, without setting anything.

import type { Component } from "./components";
import { outputOf } from "./components";
import { periodAround, weekNumber } from "./datePeriod";
import { formatDate } from "./fieldKinds";
import { fieldValue, itemLabel, pickableFields, type Collection, type FieldDef, type Item } from "./model";
import { BLOCK_HEIGHT, normalizeBlockHeight } from "./views";
import { groupKeysOf, isGrouped, isGroupable, type GroupOrder, type QueryContext, type QueryResult } from "./query";

export type ChartKind =
  | "bar"
  | "line"
  | "pie"
  | "radar"
  | "treemap"
  | "wordcloud"
  | "histogram"
  | "boxplot"
  | "scatter"
  | "heatmap"
  | "gauge"
  | "meter";

/** The chart types, in the order (and sections) the Chart menu lists them. */
export const CHART_KINDS: { kind: ChartKind; label: string; section: string }[] = [
  { kind: "bar", label: "Bar", section: "Compare" },
  { kind: "radar", label: "Radar", section: "Compare" },
  { kind: "line", label: "Line", section: "Over time" },
  { kind: "pie", label: "Pie", section: "Parts of a whole" },
  { kind: "treemap", label: "Treemap", section: "Parts of a whole" },
  { kind: "wordcloud", label: "Word cloud", section: "Parts of a whole" },
  { kind: "histogram", label: "Histogram", section: "Spread" },
  { kind: "boxplot", label: "Box plot", section: "Spread" },
  { kind: "scatter", label: "Scatter", section: "Spread" },
  { kind: "heatmap", label: "Heatmap", section: "Spread" },
  { kind: "gauge", label: "Gauge", section: "One value" },
  { kind: "meter", label: "Meter", section: "One value" },
];

/** How the items of a category become one number. */
export type Aggregate = "count" | "sum" | "avg" | "min" | "max" | "first" | "last";
export const AGGREGATES: { value: Aggregate; text: string }[] = [
  { value: "count", text: "Count of items" },
  { value: "sum", text: "Sum" },
  { value: "avg", text: "Average" },
  { value: "min", text: "Minimum" },
  { value: "max", text: "Maximum" },
  { value: "first", text: "First value" },
  { value: "last", text: "Last value" },
];

/** What a gauge compares its value with: any aggregate, or (when its value is the last) the value before it. */
export type Compare = Aggregate | "prev";
export const PREVIOUS: { value: Compare; text: string } = { value: "prev", text: "Previous value" };

/** The steps a date category is counted in ("auto": by how far the dates spread). */
export type DateStep = "auto" | "day" | "week" | "month" | "year";
export const DATE_STEPS: { value: DateStep; text: string }[] = [
  { value: "auto", text: "Automatic" },
  { value: "day", text: "Day" },
  { value: "week", text: "Week" },
  { value: "month", text: "Month" },
  { value: "year", text: "Year" },
];

/** How wide a chart may get, in rem (a slider like the cards'; the maximum is about 1920px, wider than any pane). */
export const CHART_WIDTH = { min: 8, max: 120, step: 1 };
/** What a gauge gets when switched to (as wide as a pane it is mostly empty). */
export const GAUGE_WIDTH = 24;
/** Widths saved before the slider: their rem. */
const LEGACY_WIDTHS: Record<string, number> = { full: CHART_WIDTH.max, s: 24, m: 40, l: 64 };

export interface ChartOptions {
  chart: ChartKind;
  /** What a category measures: its items counted, or a number field added up (…) over them. */
  value: Aggregate;
  /** The number field `value` adds up (not for a count); also what a histogram, box plot or gauge measures, and a scatter's Y. */
  valueField: string | null;
  /** A second field splitting each category into series (colours); null = one series. */
  splitBy: string | null;
  /** The steps of a date category (grouped by a date). */
  dateStep: DateStep;
  /** Items without a value in the grouped-by (or split-by) field get their own "No value" category. */
  showEmpty: boolean;
  /** At most this many categories (the largest), the rest as "Other"; 0 = all. */
  top: number;
  /** The most it takes, in rem (BLOCK_HEIGHT, like a map's and a component's); a pie or gauge in a narrow block takes less. */
  height: number;
  /** At most this wide, in rem (CHART_WIDTH). */
  width: number;
  // Bar
  horizontal: boolean;
  /** Series side by side, or stacked. */
  stacked: boolean;
  /** Lines with a dot at the end instead of bars. */
  lollipop: boolean;
  // Bar and line: a second value, drawn as a line against its own axis (a combo chart).
  second: Aggregate | null;
  secondField: string | null;
  // Line
  area: boolean;
  /** Stacked areas as shares of 100% (with Split by). */
  percent: boolean;
  /** A running total: each step adds to the ones before. */
  cumulative: boolean;
  /** A sparkline: no axes, legend or grid. */
  compact: boolean;
  /** Smooth curves between the points instead of straight lines. */
  curved: boolean;
  // Pie
  donut: boolean;
  // Radar: the number fields that are its spokes.
  fields: string[];
  // Histogram: the number of bins (0: automatic).
  bins: number;
  // Scatter: X (a number or date field), and the size of the dots (bubbles).
  xField: string | null;
  sizeField: string | null;
  // Gauge and meter: what the value is measured against (a number, or a field: "Pages").
  max: number | null;
  maxField: string | null;
  /** Gauge and meter: shown as a warning from this share of the max (%), as a danger from `dangerAt`. */
  warnAt: number | null;
  dangerAt: number | null;
  /** Gauge: a full circle instead of a half. */
  fullCircle: boolean;
  /** Gauge: the value itself in the middle instead of its share of the max (%). */
  asValue: boolean;
  /** Gauge: a second value, shown as the increase or decrease from it; null = none. */
  compare: Compare | null;
  /** The number field `compare` is taken of; null = the gauge's own. */
  compareField: string | null;
  /** Meter: the categories as parts of one bar (of the max). */
  proportional: boolean;
}

/** Fields whose values are numbers: number fields, and AI and component fields giving one. */
export function numberFields(collection: Collection, components: Component[]): FieldDef[] {
  return collection.fields.filter(
    (f) => f.kind === "number" || (f.kind === "ai" && f.output === "number") || (f.kind === "component" && outputOf(f, components) === "number"),
  );
}

/** Fields that can be a scatter's X: numbers and dates. */
export function axisFields(collection: Collection, components: Component[]): FieldDef[] {
  const numbers = new Set(numberFields(collection, components).map((f) => f.id));
  return pickableFields(collection).filter((f) => numbers.has(f.id) || f.kind === "date" || f.kind === "datetime");
}

/** Fields a chart can split its categories by (what grouping can use). */
export const splitFields = (collection: Collection): FieldDef[] => pickableFields(collection).filter((f) => isGroupable(f.kind));

export function defaultChartOptions(collection: Collection, components: Component[] = []): ChartOptions {
  const number = numberFields(collection, components)[0]?.id ?? null;
  return {
    chart: "bar",
    value: "count",
    valueField: number,
    splitBy: null,
    dateStep: "auto",
    showEmpty: false,
    top: 0,
    height: BLOCK_HEIGHT.initial,
    width: CHART_WIDTH.max,
    horizontal: false,
    stacked: false,
    lollipop: false,
    second: null,
    secondField: null,
    area: false,
    percent: false,
    cumulative: false,
    compact: false,
    curved: true,
    donut: true,
    fields: [],
    bins: 0,
    xField: null,
    sizeField: null,
    max: null,
    maxField: null,
    warnAt: null,
    dangerAt: null,
    fullCircle: false,
    asValue: false,
    compare: null,
    compareField: null,
    proportional: false,
  };
}

const oneOf = <T,>(list: readonly { value: T }[], v: unknown, fallback: T): T => (list.some((x) => x.value === v) ? (v as T) : fallback);
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Stored (possibly outdated) options made valid: fields that are gone dropped, unknown values defaulted. */
export function normalizeChartOptions(raw: unknown, collection: Collection): ChartOptions {
  const o = (raw ?? {}) as Partial<Record<keyof ChartOptions, unknown>>;
  const d = defaultChartOptions(collection);
  const ids = new Set(pickableFields(collection).map((f) => f.id));
  const field = (v: unknown, fallback: string | null = null) => (typeof v === "string" && ids.has(v) ? v : fallback);
  const flag = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const count = (v: unknown, max: number) => Math.max(0, Math.min(max, Math.round(finite(v) ?? 0)));
  return {
    chart: CHART_KINDS.some((k) => k.kind === o.chart) ? (o.chart as ChartKind) : d.chart,
    value: oneOf(AGGREGATES, o.value, d.value),
    valueField: field(o.valueField, o.valueField === null ? null : d.valueField),
    splitBy: field(o.splitBy),
    dateStep: oneOf(DATE_STEPS, o.dateStep, d.dateStep),
    showEmpty: flag(o.showEmpty, d.showEmpty),
    top: count(o.top, 100),
    height: normalizeBlockHeight(o.height),
    width:
      typeof o.width === "number" && Number.isFinite(o.width)
        ? Math.min(CHART_WIDTH.max, Math.max(CHART_WIDTH.min, Math.round(o.width)))
        : typeof o.width === "string" && o.width in LEGACY_WIDTHS
          ? LEGACY_WIDTHS[o.width]
          : d.width,
    horizontal: flag(o.horizontal, d.horizontal),
    stacked: flag(o.stacked, d.stacked),
    lollipop: flag(o.lollipop, d.lollipop),
    second: o.second === null || o.second === undefined ? null : oneOf(AGGREGATES, o.second, "count"),
    secondField: field(o.secondField),
    area: flag(o.area, d.area),
    percent: flag(o.percent, d.percent),
    cumulative: flag(o.cumulative, d.cumulative),
    compact: flag(o.compact, d.compact),
    curved: flag(o.curved, d.curved),
    donut: flag(o.donut, d.donut),
    fields: Array.isArray(o.fields) ? o.fields.filter((f): f is string => typeof f === "string" && ids.has(f)) : [],
    bins: count(o.bins, 100),
    xField: field(o.xField),
    sizeField: field(o.sizeField),
    max: finite(o.max),
    maxField: field(o.maxField),
    warnAt: finite(o.warnAt),
    dangerAt: finite(o.dangerAt),
    fullCircle: flag(o.fullCircle, d.fullCircle),
    asValue: flag(o.asValue, d.asValue),
    compare: o.compare === null || o.compare === undefined ? null : oneOf([...AGGREGATES, PREVIOUS], o.compare, null as Compare | null),
    compareField: field(o.compareField),
    proportional: flag(o.proportional, d.proportional),
  };
}

/** Whether a chart type draws categories (the block's grouping), rather than one point per item or one value. */
export const usesCategories = (kind: ChartKind) => !["scatter", "histogram", "gauge"].includes(kind);

/** Whether a chart type shows one value: of all its items together (gauge, meter). */
export const isSingleValue = (kind: ChartKind) => kind === "gauge" || kind === "meter";

// --- Values ---------------------------------------------------------------------------------------

/** A number field's values on items (those without one left out). */
const numbersOf = (items: Item[], field: FieldDef | undefined): number[] =>
  field ? items.flatMap((i) => (typeof fieldValue(i, field) === "number" ? [fieldValue(i, field) as number] : [])) : [];

/** The items made into one number: counted, or their values of `field` added up (…); null when there is nothing to add up. */
export function aggregate(items: Item[], how: Compare, field: FieldDef | undefined): number | null {
  if (how === "count") return items.length;
  const values = numbersOf(items, field);
  if (values.length === 0) return null;
  switch (how) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "avg":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    case "first":
      return values[0];
    case "last":
      return values[values.length - 1];
    case "prev":
      return values.length > 1 ? values[values.length - 2] : null;
  }
}

/** What a value is called (an axis title, a legend): "Count", "Sum of Pages". */
export function valueLabel(how: Aggregate, field: FieldDef | undefined, collection: Collection): string {
  if (how === "count") return collection.pluralName;
  const name = field?.name ?? "?";
  return how === "sum" ? `Sum of ${name}` : how === "avg" ? `Average ${name}` : how === "min" ? `Minimum ${name}` : how === "first" ? `First ${name}` : how === "last" ? `Last ${name}` : `Maximum ${name}`;
}

// --- Categories -----------------------------------------------------------------------------------

/** A category: a group of the block's items (a bar, a slice, a step of a line). */
export interface Category {
  key: string;
  label: string;
  items: Item[];
  /** Grouped by a date: the first day of its step (yyyy-mm-dd). */
  day?: string;
  /** Grouped by a number: that number. */
  number?: number;
}

const NO_VALUE = "No value";
const OTHER = "Other";
const isDateField = (f: FieldDef | undefined) => f?.kind === "date" || f?.kind === "datetime";
const unique = (items: Item[]) => [...new Set(items)];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The step for dates spread from `first` to `last` (yyyy-mm-dd): a month in days, half a year in weeks, five in months, more in years. */
export function autoStep(first: string, last: string): Exclude<DateStep, "auto"> {
  const days = (Date.parse(last) - Date.parse(first)) / 86_400_000;
  return days <= 31 ? "day" : days <= 183 ? "week" : days <= 5 * 366 ? "month" : "year";
}

/** The step a day falls in: its first day, and its name ("2026-10-28", "Week 44 2026", "Oct 2026", "2026"). */
export function dateStepOf(day: string, step: Exclude<DateStep, "auto">, locale?: string): { day: string; label: string } {
  if (step === "day") return { day, label: day };
  const start = periodAround(step, day).start;
  if (step === "week") {
    const { week, year } = weekNumber(day);
    return { day: start, label: `Week ${week} ${year}` };
  }
  if (step === "year") return { day: start, label: start.slice(0, 4) };
  const [y, m] = start.split("-").map(Number);
  return { day: start, label: new Date(y, m - 1, 1).toLocaleDateString(locale, { month: "short", year: "numeric" }) };
}

/** The step after one (its first day): the next day, week, month or year. */
function nextStep(day: string, step: Exclude<DateStep, "auto">): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = step === "day" ? new Date(y, m - 1, d + 1) : step === "week" ? new Date(y, m - 1, d + 7) : step === "month" ? new Date(y, m, 1) : new Date(y + 1, 0, 1);
  return formatDate(date);
}

export interface ChartInput {
  collection: Collection;
  result: QueryResult;
  /** The field the block groups by (its categories); undefined when not grouped. */
  groupField: FieldDef | undefined;
  groupOrder?: GroupOrder;
  ctx: QueryContext;
  /** For month names (tests pin it). */
  locale?: string;
}

/** Every item of a result once (an item can be in several groups). */
export const resultItems = (result: QueryResult): Item[] => unique(result.groups.flatMap((g) => g.items));

/**
 * The categories of a chart: the block's groups (none: one category of all its items, named after the
 * collection). Grouped by a date, the days are merged into steps (`dateStep`); a line gets the steps
 * without items too (`timeline`), in time order. "No value" is left out unless `showEmpty`.
 */
export function chartCategories(input: ChartInput, options: Pick<ChartOptions, "dateStep" | "showEmpty">, timeline = false): Category[] {
  const { collection, result, groupField } = input;
  if (!groupField || !isGrouped(result)) {
    const items = resultItems(result);
    return items.length || result.groups.length ? [{ key: "", label: collection.pluralName, items }] : [];
  }
  const groups = result.groups
    .filter((g) => options.showEmpty || g.key !== "")
    .map((g): Category => ({ key: g.key, label: g.key === "" ? NO_VALUE : g.label, items: g.items }));
  if (groupField.kind === "number") return groups.map((g) => (g.key === "" ? g : { ...g, number: Number(g.key) }));
  if (!isDateField(groupField)) return groups;

  // Days into steps, in the groups' order (by date either way, or the largest first).
  const days = groups.filter((g) => DAY.test(g.key)).map((g) => g.key).sort();
  if (days.length === 0) return groups;
  const step = options.dateStep === "auto" ? autoStep(days[0], days[days.length - 1]) : options.dateStep;
  const steps = new Map<string, Category>();
  for (const g of groups) {
    if (!DAY.test(g.key)) {
      steps.set(g.key, g);
      continue;
    }
    const { day, label } = dateStepOf(g.key, step, input.locale);
    const at = steps.get(day);
    steps.set(day, at ? { ...at, items: unique([...at.items, ...g.items]) } : { key: day, label, items: g.items, day });
  }
  let merged = [...steps.values()];
  if (input.groupOrder === "count") merged.sort((a, b) => b.items.length - a.items.length);
  if (!timeline) return merged;
  // A line: every step from the first to the last, in time order ("No value" can't be placed on it).
  const byDay = new Map(merged.filter((c) => c.day).map((c) => [c.day!, c]));
  const first = dateStepOf(days[0], step, input.locale).day;
  const last = dateStepOf(days[days.length - 1], step, input.locale).day;
  merged = [];
  for (let day = first, n = 0; day <= last && n < MAX_STEPS; day = nextStep(day, step), n++) {
    merged.push(byDay.get(day) ?? { key: day, label: dateStepOf(day, step, input.locale).label, items: [], day });
  }
  return merged;
}

/** The most steps a line draws (a century of days would freeze the page). */
const MAX_STEPS = 2000;

/** The largest `top` categories (by `measure`) in their order, the rest merged into "Other"; all when `top` is 0 or more. */
export function topCategories(categories: Category[], top: number, measure: (c: Category) => number | null): Category[] {
  if (top <= 0 || categories.length <= top) return categories;
  const ranked = [...categories].sort((a, b) => (measure(b) ?? -Infinity) - (measure(a) ?? -Infinity));
  const kept = new Set(ranked.slice(0, top));
  const rest = categories.filter((c) => !kept.has(c));
  return [...categories.filter((c) => kept.has(c)), { key: "\u0000other", label: OTHER, items: unique(rest.flatMap((c) => c.items)) }];
}

// --- Series ---------------------------------------------------------------------------------------

/** Series beyond this many (the largest) are merged into "Other": more colours can't be told apart. */
export const MAX_SERIES = 12;

/** A category's items split into series by a field (an item in several of its values counts in each). */
export interface Split {
  /** The series, largest first (at most MAX_SERIES, then "Other"). */
  names: string[];
  /** The items of a category in a series. */
  items(category: Category, series: string): Item[];
}

export function splitSeries(categories: Category[], field: FieldDef | undefined, showEmpty: boolean, ctx: QueryContext): Split | null {
  if (!field) return null;
  const labelsOf = new Map<Item, string[]>();
  const sizes = new Map<string, number>();
  for (const c of categories) {
    for (const item of c.items) {
      if (labelsOf.has(item)) continue;
      const labels = groupKeysOf(field, item, ctx)
        .filter((k) => showEmpty || k.key !== "")
        .map((k) => (k.key === "" ? NO_VALUE : k.label || k.key));
      labelsOf.set(item, labels);
      for (const l of labels) sizes.set(l, (sizes.get(l) ?? 0) + 1);
    }
  }
  const ranked = [...sizes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { numeric: true })).map(([n]) => n);
  const kept = new Set(ranked.slice(0, MAX_SERIES));
  const named = (label: string) => (kept.has(label) ? label : OTHER);
  const names = ranked.length > MAX_SERIES ? [...ranked.slice(0, MAX_SERIES), OTHER] : ranked;
  return {
    names,
    items: (category, series) => category.items.filter((i) => (labelsOf.get(i) ?? []).some((l) => named(l) === series)),
  };
}

// --- The data a chart draws -----------------------------------------------------------------------

/** One value of a chart: a category's (in a series). */
export interface ChartPoint {
  category: Category;
  series: string;
  value: number | null;
}

export interface ChartTable {
  categories: Category[];
  /** The series names (one, the value's name, when not split). */
  series: string[];
  points: ChartPoint[];
  /** The value's name ("Books", "Sum of Pages"). */
  valueLabel: string;
  /** The categories' name (the grouped-by field's), "" when not grouped. */
  categoryLabel: string;
  /** The categories are steps in time (a date field) / numbers. */
  time: boolean;
  numeric: boolean;
}

/**
 * The values of a chart drawing categories: each category's (and series') items made into its value.
 * `timeline`: a line (every step in time order, a running total when `cumulative`).
 */
export function chartTable(input: ChartInput, options: ChartOptions, timeline = false): ChartTable {
  const { collection, groupField, ctx } = input;
  const byId = new Map(pickableFields(collection).map((f) => [f.id, f]));
  const field = options.valueField ? byId.get(options.valueField) : undefined;
  const label = valueLabel(options.value, field, collection);
  const measure = (items: Item[]) => aggregate(items, options.value, field);
  let categories = chartCategories(input, options, timeline);
  if (!timeline) categories = topCategories(categories, options.top, (c) => measure(c.items));
  const splitField = options.splitBy && options.splitBy !== groupField?.id ? byId.get(options.splitBy) : undefined;
  const split = splitSeries(categories, splitField, options.showEmpty, ctx);
  const series = split ? split.names : [label];
  // Empty steps of a line count nothing (a count or sum is 0 there; an average has no value).
  const zeroWhenEmpty = options.value === "count" || options.value === "sum";
  const points: ChartPoint[] = [];
  for (const s of series) {
    let running = 0;
    for (const c of categories) {
      const items = split ? split.items(c, s) : c.items;
      let value = items.length === 0 ? (zeroWhenEmpty ? 0 : null) : measure(items);
      if (timeline && options.cumulative && value !== null) value = running += value;
      points.push({ category: c, series: s, value });
    }
  }
  return {
    categories,
    series,
    points,
    valueLabel: label,
    categoryLabel: groupField && isGrouped(input.result) ? groupField.name : "",
    time: categories.some((c) => c.day !== undefined) && isDateField(groupField),
    numeric: groupField?.kind === "number",
  };
}

/** One value made of all the block's items (a gauge, a meter), and what it is measured against. */
export interface SingleValue {
  value: number | null;
  /** The max (or target): the option's number, or the max field's values made into one the same way; null = none. */
  max: number | null;
  label: string;
}

export function singleValue(collection: Collection, items: Item[], options: ChartOptions): SingleValue {
  const byId = new Map(pickableFields(collection).map((f) => [f.id, f]));
  const field = options.valueField ? byId.get(options.valueField) : undefined;
  const maxField = options.maxField ? byId.get(options.maxField) : undefined;
  // A count is measured against the sum of the max field (a field's own value on one item).
  const max = maxField ? aggregate(items, options.value === "count" ? "sum" : options.value, maxField) : options.max;
  return { value: aggregate(items, options.value, field), max, label: valueLabel(options.value, field, collection) };
}

/** A value as a share of its max, in % (of 100 without a max); null without a value. */
export const percentOf = (value: number | null, max: number | null): number | null =>
  value === null ? null : max === null ? value : max === 0 ? 0 : (value / max) * 100;

/** The status of a share by the warning and danger thresholds (%): "success" below both. */
export function statusOf(percent: number | null, warnAt: number | null, dangerAt: number | null): "success" | "warning" | "danger" | null {
  if (percent === null || (warnAt === null && dangerAt === null)) return null;
  if (dangerAt !== null && percent >= dangerAt) return "danger";
  if (warnAt !== null && percent >= warnAt) return "warning";
  return "success";
}

/** One dot of a scatter: an item, by its X and Y (and size). */
export interface ScatterPoint {
  item: Item;
  title: string;
  series: string;
  x: number | string;
  y: number;
  size: number | null;
}

/** A scatter's dots: the items with an X and a Y, coloured by the block's groups. */
export function scatterPoints(input: ChartInput, options: ChartOptions): ScatterPoint[] {
  const { collection } = input;
  const byId = new Map(pickableFields(collection).map((f) => [f.id, f]));
  const x = options.xField ? byId.get(options.xField) : undefined;
  const y = options.valueField ? byId.get(options.valueField) : undefined;
  const size = options.sizeField ? byId.get(options.sizeField) : undefined;
  if (!x || !y) return [];
  const categories = chartCategories(input, { dateStep: "day", showEmpty: true });
  const seen = new Set<Item>();
  const points: ScatterPoint[] = [];
  for (const c of categories) {
    for (const item of c.items) {
      if (seen.has(item)) continue;
      seen.add(item);
      const xv = fieldValue(item, x);
      const yv = fieldValue(item, y);
      if (typeof yv !== "number" || (typeof xv !== "number" && !(typeof xv === "string" && xv))) continue;
      const sv = size ? fieldValue(item, size) : null;
      points.push({ item, title: itemLabel(collection, item), series: c.label, x: xv, y: yv, size: typeof sv === "number" ? sv : null });
    }
  }
  return points;
}

/** The values of a number field per category (a histogram's bars, a box plot's boxes). */
export function valuesByCategory(input: ChartInput, options: ChartOptions): { series: string; value: number }[] {
  const field = options.valueField ? pickableFields(input.collection).find((f) => f.id === options.valueField) : undefined;
  // A date is its time (ms): the chart draws it on a time axis.
  const values = (items: Item[]) =>
    isDateField(field) ? items.flatMap((i) => { const t = Date.parse(String(fieldValue(i, field!) ?? "")); return Number.isNaN(t) ? [] : [t]; }) : numbersOf(items, field);
  return chartCategories(input, options).flatMap((c) => values(c.items).map((value) => ({ series: c.label, value })));
}

/** The values of each radar spoke (a number field) per category: one shape per group. */
export function radarValues(input: ChartInput, options: ChartOptions): { series: string; spoke: string; value: number | null }[] {
  const byId = new Map(pickableFields(input.collection).map((f) => [f.id, f]));
  const spokes = options.fields.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  // A count has nothing to do with a spoke's field: its average instead.
  const how = options.value === "count" ? "avg" : options.value;
  return topCategories(chartCategories(input, options), options.top || MAX_SERIES, (c) => c.items.length).flatMap((c) =>
    spokes.map((f) => ({ series: c.label, spoke: f.name, value: aggregate(c.items, how, f) })),
  );
}

/** A heatmap's cells: categories × series, or, grouped by a date and not split, weeks × weekdays (a calendar). */
export function heatmapCells(input: ChartInput, options: ChartOptions): { x: string; y: string; value: number | null }[] {
  const calendar = isDateField(input.groupField) && !options.splitBy && isGrouped(input.result);
  if (!calendar) {
    const table = chartTable(input, options);
    return table.points.map((p) => ({ x: p.category.label, y: p.series, value: p.value }));
  }
  const byId = new Map(pickableFields(input.collection).map((f) => [f.id, f]));
  const field = options.valueField ? byId.get(options.valueField) : undefined;
  const days = chartCategories(input, { ...options, dateStep: "day" }, true);
  const names = weekdays(input.locale);
  return days.map((d) => {
    const [y, m, day] = periodAround("week", d.day!).start.split("-").map(Number);
    return {
      // A week by its Sunday ("4 Jan"), a day by its name.
      x: new Date(y, m - 1, day).toLocaleDateString(input.locale, { day: "numeric", month: "short" }),
      y: names[dayDate(d.day!).getDay()],
      value: d.items.length === 0 ? (options.value === "count" ? 0 : null) : aggregate(d.items, options.value, field),
    };
  });
}

const dayDate = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
};

/** The weekdays' short names, Sunday first (a calendar heatmap's rows). */
export const weekdays = (locale?: string): string[] =>
  Array.from({ length: 7 }, (_, i) => new Date(2026, 0, 4 + i).toLocaleDateString(locale, { weekday: "short" })); // 4 January 2026 was a Sunday
