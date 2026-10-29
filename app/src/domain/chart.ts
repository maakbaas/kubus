// Charts: what a chart block shows, worked out from its items. Storage-free and UI-free (the
// block, views/ChartBlock.tsx, draws it with Carbon Charts: views/chartSpec.ts).
//
// A chart's block filter and sort pick its items (or, on an item page, the page's item alone:
// `scope`); everything else is the chart's own settings, in one place:
// - its X axis (`x`): nothing (one category of all items), the groups of a field (a bar per
//   status, a step per month), or each item along a date or number field (a point per measurement);
// - its series: any number of values, each a count or the sum, average, … of a number field, drawn
//   as bars, a line, an area or dots, on the left or right axis, optionally a running total, the
//   change from the step before or a moving average; "Split by" splits every series by a field;
// - parts of a whole (pie, meter, treemap, word cloud): the groups, several number fields (fat,
//   muscle, bone) or one value, against a total (a number or a field: the rest is "Remaining");
// - thresholds (warning / danger: absolute or a % of the total), the axes (title, min, max, log),
//   the values' unit and decimals, the legend and the size;
// - a choropleth: the X axis's categories are regions of a map (domain/regions.ts), coloured by the value.

import type { Component } from "./components";
import { outputOf } from "./components";
import { periodAround, weekNumber } from "./datePeriod";
import { formatDate, formatTime } from "./fieldKinds";
import { fieldValue, itemLabel, newId, pickableFields, type Collection, type FieldDef, type Item } from "./model";
import { BLOCK_HEIGHT, DEFAULT_ASPECT, normalizeAspect, normalizeBlockHeight, type AspectRatio } from "./views";
import { applyQuery, defaultQuery, groupKeysOf, isGroupable, naturalCompare, type GroupOrder, type QueryContext, type QueryResult } from "./query";
import { defaultRegions, normalizeRegions, regionFinder, type ChartRegions, type Region } from "./regions";

export type ChartKind =
  | "bar"
  | "line"
  | "area"
  | "radar"
  | "pie"
  | "meter"
  | "treemap"
  | "wordcloud"
  | "gauge"
  | "stat"
  | "histogram"
  | "boxplot"
  | "scatter"
  | "heatmap"
  | "choropleth";

/** The chart types, in the order (and sections) the Chart menu lists them. */
export const CHART_KINDS: { kind: ChartKind; label: string; section: string }[] = [
  { kind: "bar", label: "Bar", section: "Compare and over time" },
  { kind: "line", label: "Line", section: "Compare and over time" },
  { kind: "area", label: "Area", section: "Compare and over time" },
  { kind: "radar", label: "Radar", section: "Compare and over time" },
  { kind: "pie", label: "Pie", section: "Parts of a whole" },
  { kind: "meter", label: "Meter", section: "Parts of a whole" },
  { kind: "treemap", label: "Treemap", section: "Parts of a whole" },
  { kind: "wordcloud", label: "Word cloud", section: "Parts of a whole" },
  { kind: "gauge", label: "Gauge", section: "One value" },
  { kind: "stat", label: "Stat", section: "One value" },
  { kind: "histogram", label: "Histogram", section: "Spread" },
  { kind: "boxplot", label: "Box plot", section: "Spread" },
  { kind: "scatter", label: "Scatter", section: "Spread" },
  { kind: "heatmap", label: "Heatmap", section: "Spread" },
  { kind: "choropleth", label: "Choropleth", section: "Regions" },
];

/** Bar, line and area: one chart of series over an X axis, each series drawn its own way (a combo when they differ). */
export const isXY = (kind: ChartKind): kind is "bar" | "line" | "area" => kind === "bar" || kind === "line" || kind === "area";
/** Parts of a whole: pie (or donut), meter, treemap, word cloud. */
export const isParts = (kind: ChartKind): kind is "pie" | "meter" | "treemap" | "wordcloud" =>
  kind === "pie" || kind === "meter" || kind === "treemap" || kind === "wordcloud";

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

/** What a gauge or stat compares its value with: any aggregate, (when its value is the last) the value before it, or a number. */
export type Compare = Aggregate | "prev" | "number";
export const PREVIOUS: { value: Compare; text: string } = { value: "prev", text: "Previous value" };
export const A_NUMBER: { value: Compare; text: string } = { value: "number", text: "A number" };

/** The steps a date category is counted in ("auto": by how far the dates spread); minutes and hours only of a date & time. */
export type DateStep = "auto" | "minute" | "hour" | "day" | "week" | "month" | "year";
/** The steps whole days are counted in. */
export type DayStep = Exclude<DateStep, "auto" | "minute" | "hour">;
export const DATE_STEPS: { value: DateStep; text: string }[] = [
  { value: "auto", text: "Automatic" },
  { value: "minute", text: "Minute" },
  { value: "hour", text: "Hour" },
  { value: "day", text: "Day" },
  { value: "week", text: "Week" },
  { value: "month", text: "Month" },
  { value: "year", text: "Year" },
];

/** How a series of a bar, line or area chart is drawn; null (in `ChartSeries.style`): the chart's own (a bar of a Bar chart). */
export type SeriesStyle = "bar" | "lollipop" | "line" | "area" | "points";
export const SERIES_STYLES: { value: SeriesStyle; text: string }[] = [
  { value: "bar", text: "Bars" },
  { value: "lollipop", text: "Lollipops" },
  { value: "line", text: "Line" },
  { value: "area", text: "Area" },
  { value: "points", text: "Dots" },
];

/** What a series does with its values along the X axis, in order. */
export type Transform = "none" | "cumulative" | "change" | "moving";
export const TRANSFORMS: { value: Transform; text: string }[] = [
  { value: "none", text: "The values" },
  { value: "cumulative", text: "Running total" },
  { value: "change", text: "Change from the step before" },
  { value: "moving", text: "Moving average" },
];
/** The steps a moving average takes (`ChartSeries.window`). */
export const MOVING_WINDOW = { min: 2, max: 50, initial: 3 };

/** One value a chart draws: a count, or a number field made into one per category. */
export interface ChartSeries {
  /** Stable while the series is edited (the settings' rows). */
  id: string;
  value: Aggregate;
  /** The number field (not for a count). */
  field: string | null;
  /** Its name in the legend and tooltip; "" = made from the value ("Sum of Pages"). */
  label: string;
  /** Bar, line and area: how it is drawn; null = the chart's (`chart`). */
  style: SeriesStyle | null;
  /** Bar, line and area: the value axis it is measured on. */
  axis: "left" | "right";
  transform: Transform;
  /** A moving average's steps. */
  window: number;
}

/** What the X axis (the categories) is: nothing, the groups of a field, or each item. */
export type XBy = "none" | "field" | "item";

export interface ChartX {
  by: XBy;
  /**
   * "field": the field whose values are the categories (any field the block could be grouped by;
   * a date's values merged into `dateStep`s). "item": a date or number field each item is placed
   * at (null: the items side by side, by their title, in the block's order).
   */
  field: string | null;
  /** "field": the categories by value (either way) or the largest first; dates and numbers on a time or number axis keep their order. */
  order: GroupOrder;
  dateStep: DateStep;
  /** "field": items without a value get a "No value" category (also when split). */
  showEmpty: boolean;
  /** "field": at most this many categories (the largest), the rest as "Other"; 0 = all. */
  top: number;
}

/** Parts of a whole are the X axis's groups, several number fields, or one value against its total. */
export type PartsFrom = "groups" | "fields" | "one";

export interface ChartTotal {
  /** "none": the sum of the parts (a gauge's value is a %). */
  from: "none" | "number" | "field";
  number: number | null;
  /** A number field, made into one the same way as the value (a count against its sum). */
  field: string | null;
}

export type ThresholdStatus = "info" | "target" | "warning" | "danger";
/**
 * The statuses, in the order offered: each with its line's colour (a Carbon token: bar, line, area) and
 * Carbon's status for a gauge or meter (null: Carbon has none for it, so a gauge or meter doesn't offer it).
 */
export const THRESHOLD_STATUSES: { value: ThresholdStatus; text: string; color: string; carbon: "success" | "warning" | "danger" | null }[] = [
  { value: "info", text: "Info", color: "var(--cds-support-info)", carbon: null },
  { value: "target", text: "Target", color: "var(--cds-support-success)", carbon: "success" },
  { value: "warning", text: "Warning", color: "var(--cds-support-warning)", carbon: "warning" },
  { value: "danger", text: "Danger", color: "var(--cds-support-error)", carbon: "danger" },
];
export const thresholdStatus = (status: ThresholdStatus) => THRESHOLD_STATUSES.find((s) => s.value === status)!;
export interface Threshold {
  value: number;
  status: ThresholdStatus;
}

export interface ChartAxis {
  /** "" = made from its series. */
  title: string;
  /** null = automatic: bars and stacked areas from 0, lines and dots fitted to their values. */
  min: number | null;
  max: number | null;
  log: boolean;
}

export type LegendShow = "auto" | "show" | "hide";
export type LegendPosition = "bottom" | "top" | "left" | "right";

export interface ChartOptions {
  chart: ChartKind;
  /** On an item page: the block's items, or the page's item alone ("Of this item"). */
  scope: "items" | "page";
  x: ChartX;
  /** Bar, line, area: every series; radar, gauge, heatmap, parts: the first is the value (its aggregate for parts from fields and radar spokes); scatter: each a Y field (its field only). */
  series: ChartSeries[];
  /** A field splitting every series (bar, line, area, heatmap rows), colouring a scatter's dots and a histogram's bars; null = not split. */
  splitBy: string | null;
  /** Bars and areas on the same axis: side by side / overlapping, stacked, or stacked as shares of 100%. */
  stack: "none" | "stacked" | "percent";
  /** Bar charts: bars across. */
  horizontal: boolean;
  /** Lines and areas. */
  curve: "smooth" | "straight" | "step";
  /** A dot on each value of a line. */
  points: boolean;
  /** Where a value is missing (an average of no items): the line joins its neighbours, or breaks there (lines and areas). */
  missing: "connect" | "gap";
  /** A sparkline: no axes, legend or grid. */
  compact: boolean;
  // Parts of a whole
  parts: PartsFrom;
  /** "fields": the number fields that are the parts; radar: its spokes. */
  fields: string[];
  /** Pie, meter, gauge: what it is measured against (the rest of a pie or meter is shown as "Remaining"). */
  total: ChartTotal;
  /** Pie: a hole in the middle, the total in it. */
  donut: boolean;
  // Gauge
  fullCircle: boolean;
  /** A second value (a stat's baseline), shown as the increase or decrease from it; null = none. */
  compare: Compare | null;
  /** The number field `compare` is taken of; null = the value's own. */
  compareField: string | null;
  /** `compare` "number": the number compared with. */
  baseline: number | null;
  // Stat
  /** Stat: its value's name above the number. Meter: the label row above the bar (Carbon's `meter.showLabels`). */
  showLabel: boolean;
  /** Below its number: the value along the X axis, a compact area or line chart (Carbon's), or none. */
  sparkline: "area" | "line" | "none";
  /** Which way of the change is good (green) and which bad (red); "neither": both grey. */
  better: "higher" | "lower" | "neither";
  /** The change shown as a % of the baseline or as the difference itself. */
  changeAs: "percent" | "value";
  // Histogram and box plot: the number or date field whose values are spread; histogram: its bins (0: automatic).
  spreadField: string | null;
  bins: number;
  /** Scatter: the size of the dots (bubbles). */
  sizeField: string | null;
  /** Choropleth: the map whose regions the X axis's categories are. */
  regions: ChartRegions;
  /** Warning and danger levels: lines on a bar, line or area chart's left axis, a gauge's or meter's colour. */
  thresholds: Threshold[];
  /** Gauge and meter: thresholds as a % of the total, or values. */
  thresholdMode: "percent" | "absolute";
  /** The X axis's title; "" = the field's name. */
  xTitle: string;
  left: ChartAxis;
  right: ChartAxis;
  /** Shown after the values (axes, tooltips, a gauge): "kg". */
  unit: string;
  /** Decimals the values are rounded to; null = as they are (at most 2). */
  decimals: number | null;
  /** "auto": with more than one series (or part). */
  legend: LegendShow;
  legendPosition: LegendPosition;
  /** The most it takes, in rem (BLOCK_HEIGHT, like a map's and a component's); a pie or gauge in a narrow block takes less. */
  height: number;
  /** With the height: the less of the two (domain/views.ts blockHeightCss). */
  aspect: AspectRatio;
  /** At most this wide, in rem (CHART_WIDTH), or "full": as wide as its pane, whatever that is (FULL_WIDTH). */
  width: ChartWidth;
}

/** A chart's Width: at most this many rem, or "full" (the pane's whole width, no maximum). */
export type ChartWidth = number | "full";
export const FULL_WIDTH = "full";
/** How wide a chart may get, in rem: the slider runs min..max rem, and one stop past it (`stop`) is Full width. */
export const CHART_WIDTH = { min: 8, max: 99, step: 1, stop: 100 };

/** The Width slider's position for a width (Full width is its last stop). */
export const widthToStop = (w: ChartWidth): number => (w === FULL_WIDTH ? CHART_WIDTH.stop : w);
/** The width a slider position stands for (its last stop is Full width). */
export const widthFromStop = (stop: number): ChartWidth => normalizeWidth(stop);
/** A width as the slider labels it. */
export const widthLabel = (w: ChartWidth): string => (w === FULL_WIDTH ? "Full width" : `${w}rem`);
/** The block's maximum width in CSS: none for Full width. */
export const widthCss = (w: ChartWidth): string | undefined => (w === FULL_WIDTH ? undefined : `${w}rem`);
/** The width after switching chart kind: a full-width chart narrows to GAUGE_WIDTH on a gauge, which widens back to Full when it leaves with that width. */
export function widthAfterSwitch(o: Pick<ChartOptions, "chart" | "width">, chart: ChartKind): ChartWidth {
  if (chart === "gauge" && o.width === FULL_WIDTH) return GAUGE_WIDTH;
  if (o.chart === "gauge" && chart !== "gauge" && o.width === GAUGE_WIDTH) return FULL_WIDTH;
  return o.width;
}
/** A stored width, read: "full" or a number of 100 and more (the old maximum was 120) is Full width; anything unreadable too (the default). */
export function normalizeWidth(v: unknown): ChartWidth {
  if (typeof v !== "number" || !Number.isFinite(v) || v >= CHART_WIDTH.stop) return FULL_WIDTH;
  return Math.max(CHART_WIDTH.min, Math.round(v));
}
/** What a gauge gets when switched to (as wide as a pane it is mostly empty). */
export const GAUGE_WIDTH = 24;
/** The most decimals a value is given. */
export const MAX_DECIMALS = 6;

/** Fields whose values are numbers: number fields, and AI and component fields giving one. */
export function numberFields(collection: Collection, components: Component[]): FieldDef[] {
  return collection.fields.filter(
    (f) => f.kind === "number" || (f.kind === "ai" && f.output === "number") || (f.kind === "component" && outputOf(f, components) === "number"),
  );
}

/** Fields that can place items on an axis (a scatter's X, "each item along", a histogram's): numbers and dates. */
export function axisFields(collection: Collection, components: Component[]): FieldDef[] {
  const numbers = new Set(numberFields(collection, components).map((f) => f.id));
  return pickableFields(collection).filter((f) => numbers.has(f.id) || f.kind === "date" || f.kind === "datetime");
}

/** Fields whose values can be categories or split series (what grouping can use). */
export const splitFields = (collection: Collection): FieldDef[] => pickableFields(collection).filter((f) => isGroupable(f.kind));

/** A new series: a count, or (with `field`) the sum of a number field. */
export const newSeries = (patch: Partial<ChartSeries> = {}): ChartSeries => ({
  id: newId(),
  value: "count",
  field: null,
  label: "",
  style: null,
  axis: "left",
  transform: "none",
  window: MOVING_WINDOW.initial,
  ...patch,
});

const AXIS: ChartAxis = { title: "", min: null, max: null, log: false };

export function defaultChartOptions(collection: Collection, components: Component[] = []): ChartOptions {
  const number = numberFields(collection, components)[0]?.id ?? null;
  return {
    chart: "bar",
    scope: "items",
    x: { by: "none", field: null, order: "asc", dateStep: "auto", showEmpty: false, top: 0 },
    series: [newSeries({ field: number })],
    splitBy: null,
    stack: "none",
    horizontal: false,
    curve: "smooth",
    points: true,
    missing: "connect",
    compact: false,
    parts: "groups",
    fields: [],
    total: { from: "none", number: null, field: null },
    donut: true,
    fullCircle: false,
    compare: null,
    compareField: null,
    baseline: null,
    showLabel: true,
    sparkline: "area",
    better: "higher",
    changeAs: "percent",
    spreadField: number,
    bins: 0,
    sizeField: null,
    regions: defaultRegions(),
    thresholds: [],
    thresholdMode: "percent",
    xTitle: "",
    left: { ...AXIS },
    right: { ...AXIS },
    unit: "",
    decimals: null,
    legend: "auto",
    legendPosition: "bottom",
    height: BLOCK_HEIGHT.initial,
    aspect: DEFAULT_ASPECT,
    width: FULL_WIDTH,
  };
}

const oneOf = <T,>(values: readonly T[], v: unknown, fallback: T): T => (values.includes(v as T) ? (v as T) : fallback);
const values = <T,>(list: readonly { value: T }[]) => list.map((x) => x.value);
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Stored options made valid: fields that are gone dropped, unknown values defaulted. */
export function normalizeChartOptions(raw: unknown, collection: Collection): ChartOptions {
  const o = record(raw);
  const d = defaultChartOptions(collection);
  const ids = new Set(pickableFields(collection).map((f) => f.id));
  const field = (v: unknown, fallback: string | null = null) => (typeof v === "string" && ids.has(v) ? v : fallback);
  const flag = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const count = (v: unknown, max: number, fallback = 0) => Math.max(0, Math.min(max, Math.round(finite(v) ?? fallback)));
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const x = record(o.x);
  const total = record(o.total);
  const axis = (v: unknown): ChartAxis => {
    const a = record(v);
    return { title: text(a.title), min: finite(a.min), max: finite(a.max), log: flag(a.log, false) };
  };
  const seriesIds = new Set<string>();
  const series = Array.isArray(o.series)
    ? o.series.map((s): ChartSeries => {
        const r = record(s);
        // Ids key the settings' rows: a missing or repeated one is made anew.
        const id = typeof r.id === "string" && r.id && !seriesIds.has(r.id) ? r.id : newId();
        seriesIds.add(id);
        return {
          id,
          value: oneOf(values(AGGREGATES), r.value, "count"),
          field: field(r.field),
          label: text(r.label),
          style: r.style === null || r.style === undefined ? null : oneOf<SeriesStyle | null>(values(SERIES_STYLES), r.style, null),
          axis: r.axis === "right" ? "right" : "left",
          transform: oneOf(values(TRANSFORMS), r.transform, "none"),
          window: Math.max(MOVING_WINDOW.min, Math.min(MOVING_WINDOW.max, Math.round(finite(r.window) ?? MOVING_WINDOW.initial))),
        };
      })
    : d.series;
  return {
    chart: oneOf(CHART_KINDS.map((k) => k.kind), o.chart, d.chart),
    scope: o.scope === "page" ? "page" : "items",
    x: {
      by: oneOf<XBy>(["none", "field", "item"], x.by, d.x.by),
      field: field(x.field),
      order: oneOf<GroupOrder>(["asc", "desc", "count"], x.order, d.x.order),
      dateStep: oneOf(values(DATE_STEPS), x.dateStep, d.x.dateStep),
      showEmpty: flag(x.showEmpty, d.x.showEmpty),
      top: count(x.top, 100),
    },
    series: series.length ? series : d.series,
    splitBy: field(o.splitBy),
    stack: oneOf(["none", "stacked", "percent"] as const, o.stack, d.stack),
    horizontal: flag(o.horizontal, d.horizontal),
    curve: oneOf(["smooth", "straight", "step"] as const, o.curve, d.curve),
    points: flag(o.points, d.points),
    missing: o.missing === "gap" ? "gap" : "connect",
    compact: flag(o.compact, d.compact),
    parts: oneOf<PartsFrom>(["groups", "fields", "one"], o.parts, d.parts),
    fields: Array.isArray(o.fields) ? o.fields.filter((f): f is string => typeof f === "string" && ids.has(f)) : [],
    total: {
      from: oneOf(["none", "number", "field"] as const, total.from, "none"),
      number: finite(total.number),
      field: field(total.field),
    },
    donut: flag(o.donut, d.donut),
    fullCircle: flag(o.fullCircle, d.fullCircle),
    compare: o.compare === null || o.compare === undefined ? null : oneOf<Compare | null>([...values(AGGREGATES), "prev", "number"], o.compare, null),
    compareField: field(o.compareField),
    baseline: typeof o.baseline === "number" && Number.isFinite(o.baseline) ? o.baseline : null,
    showLabel: flag(o.showLabel, d.showLabel),
    sparkline: oneOf<ChartOptions["sparkline"]>(["area", "line", "none"], o.sparkline, d.sparkline),
    better: oneOf<ChartOptions["better"]>(["higher", "lower", "neither"], o.better, d.better),
    changeAs: oneOf<ChartOptions["changeAs"]>(["percent", "value"], o.changeAs, d.changeAs),
    spreadField: field(o.spreadField, o.spreadField === null ? null : d.spreadField),
    bins: count(o.bins, 100),
    sizeField: field(o.sizeField),
    regions: normalizeRegions(o.regions),
    thresholds: Array.isArray(o.thresholds)
      ? o.thresholds.flatMap((t) => {
          const r = record(t);
          const value = finite(r.value);
          return value === null ? [] : [{ value, status: oneOf<ThresholdStatus>(values(THRESHOLD_STATUSES), r.status, "warning") }];
        })
      : [],
    thresholdMode: o.thresholdMode === "absolute" ? "absolute" : "percent",
    xTitle: text(o.xTitle),
    left: axis(o.left),
    right: axis(o.right),
    unit: text(o.unit),
    decimals: finite(o.decimals) === null ? null : count(o.decimals, MAX_DECIMALS),
    legend: oneOf<LegendShow>(["auto", "show", "hide"], o.legend, d.legend),
    legendPosition: oneOf<LegendPosition>(["bottom", "top", "left", "right"], o.legendPosition, d.legendPosition),
    height: normalizeBlockHeight(o.height),
    aspect: normalizeAspect(o.aspect),
    width: normalizeWidth(o.width),
  };
}

/** How a series of a bar, line or area chart is drawn: its own style, or the chart's. */
export const styleOf = (series: ChartSeries, chart: ChartKind): SeriesStyle =>
  series.style ?? (chart === "line" ? "line" : chart === "area" ? "area" : "bar");

/** Whether a chart draws a line or an area: its date steps are then every one from the first to the last, in time order. */
export const drawsTimeline = (options: Pick<ChartOptions, "series" | "chart">) => options.series.some((s) => ["line", "area"].includes(styleOf(s, options.chart)));

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
    case "number":
      return null;
  }
}

/** What a value is called (an axis title, a legend): "Books" (a count), "Sum of Pages". */
export function valueLabel(how: Aggregate, field: FieldDef | undefined, collection: Collection): string {
  if (how === "count") return collection.pluralName;
  const name = field?.name ?? "?";
  return how === "sum" ? `Sum of ${name}` : how === "avg" ? `Average ${name}` : how === "min" ? `Minimum ${name}` : how === "first" ? `First ${name}` : how === "last" ? `Last ${name}` : `Maximum ${name}`;
}

/** A series' name: its label, or what it measures; on items placed one by one, a value is the field's name ("Weight"). */
export function seriesLabel(series: ChartSeries, collection: Collection, x?: ChartX): string {
  if (series.label.trim()) return series.label.trim();
  const field = pickableFields(collection).find((f) => f.id === series.field);
  if (x?.by === "item" && series.value !== "count" && field) return field.name;
  return valueLabel(series.value, field, collection);
}

/** A series whose field is still to choose (anything but a count needs one). */
export const needsField = (series: ChartSeries, collection: Collection): boolean =>
  series.value !== "count" && !pickableFields(collection).some((f) => f.id === series.field);

/** The items a chart shows: the block's (each once, in its order), or on an item page with scope "page" the page's item. */
export function chartItems(result: QueryResult, scope: ChartOptions["scope"], pageItem: Item | null): Item[] {
  if (scope === "page" && pageItem) return [pageItem];
  return resultItems(result);
}

/** Every item of a result once (an item can be in several groups). */
export const resultItems = (result: QueryResult): Item[] => unique(result.groups.flatMap((g) => g.items));

// --- Categories -----------------------------------------------------------------------------------

/** A category: a step of the X axis (a bar, a slice, a point of a line) and its items. */
export interface Category {
  key: string;
  label: string;
  items: Item[];
  /** On a date axis: the first day of its step (yyyy-mm-dd). */
  day?: string;
  /** On a time axis: its time (ms; a day's local midnight). */
  at?: number;
  /** On a number axis: that number. */
  number?: number;
}

export const NO_VALUE = "No value";
export const OTHER = "Other";
export const REMAINING = "Remaining";
const isDateField = (f: FieldDef | undefined) => f?.kind === "date" || f?.kind === "datetime";
const unique = (items: Item[]) => [...new Set(items)];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayTime = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
};

/** The step for dates spread from `first` to `last` (yyyy-mm-dd): a month in days, half a year in weeks, five in months, more in years. */
export function autoStep(first: string, last: string): DayStep {
  const days = (Date.parse(last) - Date.parse(first)) / 86_400_000;
  return days <= 31 ? "day" : days <= 183 ? "week" : days <= 5 * 366 ? "month" : "year";
}

/** The step a day falls in: its first day, and its name ("2026-10-28", "Week 44 2026", "Oct 2026", "2026"). */
export function dateStepOf(day: string, step: DayStep, locale?: string): { day: string; label: string } {
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
function nextStep(day: string, step: DayStep): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = step === "day" ? new Date(y, m - 1, d + 1) : step === "week" ? new Date(y, m - 1, d + 7) : step === "month" ? new Date(y, m, 1) : new Date(y + 1, 0, 1);
  return formatDate(date);
}

export interface ChartInput {
  collection: Collection;
  /** The items charted (`chartItems`), in the block's order. */
  items: Item[];
  ctx: QueryContext;
  /** For month names (tests pin it). */
  locale?: string;
}

const fieldsOf = (collection: Collection) => new Map(pickableFields(collection).map((f) => [f.id, f]));

/** The field the X axis uses, when it uses one that is still there (and fits: groupable, or a number or date to place items at). */
export function xField(collection: Collection, x: ChartX): FieldDef | undefined {
  const field = x.field ? fieldsOf(collection).get(x.field) : undefined;
  if (!field) return undefined;
  if (x.by === "field") return isGroupable(field.kind) ? field : undefined;
  // A number is checked on each item (an AI or component field may give one).
  if (x.by === "item") return isDateField(field) || ["number", "ai", "component"].includes(field.kind) ? field : undefined;
  return undefined;
}

/** The X axis's name: its title, or its field's name ("" without one). */
export function xLabel(collection: Collection, options: Pick<ChartOptions, "x" | "xTitle">): string {
  return options.xTitle.trim() || (options.x.by === "none" ? "" : (xField(collection, options.x)?.name ?? ""));
}

/**
 * The categories of a chart: by its X axis. Nothing: one category of all its items (named after the
 * collection). A field's groups: dates merged into steps (`dateStep`), every step from the first to
 * the last on a `timeline` (a line), "No value" left out unless `showEmpty`. Each item: those with
 * a value of its field, in that field's order (without a field: in the block's order).
 */
export function chartCategories(input: ChartInput, x: ChartX, timeline = false): Category[] {
  const { collection, items, ctx } = input;
  if (x.by === "item") return itemCategories(input, x);
  const field = xField(collection, x);
  if (x.by === "none" || !field) return items.length ? [{ key: "", label: collection.pluralName, items }] : [];
  const result = applyQuery(collection, items, { ...defaultQuery(), sort: [], groupBy: field.id, groupOrder: x.order }, ctx);
  const groups = result.groups
    .filter((g) => x.showEmpty || g.key !== "")
    .map((g): Category => ({ key: g.key, label: g.key === "" ? NO_VALUE : g.label, items: g.items }));
  if (field.kind === "number") return groups.map((g) => (g.key === "" ? g : { ...g, number: Number(g.key) }));
  if (!isDateField(field)) return groups;
  const timed = field.kind === "datetime" ? timeCategories(input, field, x, groups, timeline) : null;
  if (timed) return timed;

  // Days into steps, in the groups' order (by date either way, or the largest first).
  const days = groups.filter((g) => DAY.test(g.key)).map((g) => g.key).sort();
  if (days.length === 0) return groups;
  // Minutes and hours are of a date & time: a date's are its days.
  const step = x.dateStep === "auto" || x.dateStep === "minute" || x.dateStep === "hour" ? (x.dateStep === "auto" ? autoStep(days[0], days[days.length - 1]) : "day") : x.dateStep;
  const steps = new Map<string, Category>();
  // A step's items in the block's order (its days' groups come in date order), for "first" and "last".
  const position = new Map(items.map((item, i) => [item, i]));
  const inOrder = (list: Item[]) => unique(list).sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
  // Each step's groups gathered first, their items put in order once (not again for each day added).
  const gathered = new Map<string, Item[][]>();
  for (const g of groups) {
    if (!DAY.test(g.key)) {
      steps.set(g.key, g);
      continue;
    }
    const { day, label } = dateStepOf(g.key, step, input.locale);
    const lists = gathered.get(day);
    if (lists) lists.push(g.items);
    else {
      gathered.set(day, [g.items]);
      steps.set(day, { key: day, label, items: g.items, day, at: dayTime(day) });
    }
  }
  for (const [day, lists] of gathered) if (lists.length > 1) steps.set(day, { ...steps.get(day)!, items: inOrder(lists.flat()) });
  let merged = [...steps.values()];
  if (x.order === "count") merged.sort((a, b) => Number(a.key === "") - Number(b.key === "") || b.items.length - a.items.length);
  if (!timeline) return merged;
  // A line: every step from the first to the last, in time order ("No value" can't be placed on it).
  const byDay = new Map(merged.filter((c) => c.day).map((c) => [c.day!, c]));
  const first = dateStepOf(days[0], step, input.locale).day;
  const last = dateStepOf(days[days.length - 1], step, input.locale).day;
  merged = [];
  for (let day = first, n = 0; day <= last && n < MAX_STEPS; day = nextStep(day, step), n++) {
    merged.push(byDay.get(day) ?? { key: day, label: dateStepOf(day, step, input.locale).label, items: [], day, at: dayTime(day) });
  }
  return merged;
}

/** The step for times spread over `span` ms: three hours in minutes, three days in hours, more in days or longer (null). */
export function autoTimeStep(span: number): "minute" | "hour" | null {
  return span <= 3 * 3_600_000 ? "minute" : span <= 3 * 86_400_000 ? "hour" : null;
}

/** The start (ms, local) of the minute or hour a moment falls in. */
function timeStepOf(at: number, step: "minute" | "hour"): number {
  const d = new Date(at);
  d.setSeconds(0, 0);
  if (step === "hour") d.setMinutes(0);
  return d.getTime();
}

/** The step after one: a minute later, or the next hour (by the clock, over a change of summer time too). */
function nextTimeStep(at: number, step: "minute" | "hour"): number {
  const d = new Date(at);
  if (step === "minute") d.setMinutes(d.getMinutes() + 1);
  else d.setHours(d.getHours() + 1);
  return d.getTime();
}

/**
 * A date & time's values in minutes or hours (picked, or "auto" over at most three days), as
 * chartCategories gives them: by time either way or the largest first, "No value" last, every step
 * from the first to the last on a timeline. Null when the steps are days or longer.
 */
function timeCategories(input: ChartInput, field: FieldDef, x: ChartX, groups: Category[], timeline: boolean): Category[] | null {
  if (x.dateStep !== "auto" && x.dateStep !== "minute" && x.dateStep !== "hour") return null;
  const moments = new Map<Item, number>();
  let first = Infinity;
  let last = -Infinity;
  for (const item of input.items) {
    const v = fieldValue(item, field);
    const at = typeof v === "string" && v ? Date.parse(v) : NaN;
    if (Number.isNaN(at)) continue;
    moments.set(item, at);
    first = Math.min(first, at);
    last = Math.max(last, at);
  }
  if (moments.size === 0) return null;
  const step = x.dateStep === "auto" ? autoTimeStep(last - first) : x.dateStep;
  if (!step) return null;
  // Times alone within a day ("14:00"), with their day over more ("28 Oct, 14:00").
  const oneDay = formatDate(new Date(first)) === formatDate(new Date(last));
  const format: Intl.DateTimeFormatOptions = oneDay ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
  const category = (at: number): Category => {
    const d = new Date(at);
    return { key: `${formatDate(d)}T${formatTime(d)}`, label: d.toLocaleString(input.locale, format), items: [], at };
  };
  // Items in the block's order within their step.
  const steps = new Map<number, Category>();
  for (const [item, at] of moments) {
    const start = timeStepOf(at, step);
    let c = steps.get(start);
    if (!c) steps.set(start, (c = category(start)));
    c.items.push(item);
  }
  const none = groups.find((g) => g.key === "");
  if (timeline) {
    const all: Category[] = [];
    for (let at = timeStepOf(first, step), n = 0; at <= last && n < MAX_STEPS; at = nextTimeStep(at, step), n++) all.push(steps.get(at) ?? category(at));
    return all;
  }
  const sorted = [...steps.values()].sort((a, b) => a.at! - b.at!);
  if (x.order === "desc") sorted.reverse();
  if (x.order === "count") sorted.sort((a, b) => b.items.length - a.items.length);
  return none ? [...sorted, none] : sorted;
}

/** Each item a category: at its value of the X field (in that order), or without a field by its title in the block's order. */
function itemCategories(input: ChartInput, x: ChartX): Category[] {
  const { collection, items } = input;
  const field = xField(collection, x);
  if (!field) return items.map((item) => ({ key: item.id, label: itemLabel(collection, item), items: [item] }));
  const placed: Category[] = [];
  for (const item of items) {
    const v = fieldValue(item, field);
    const label = itemLabel(collection, item);
    if (isDateField(field)) {
      if (typeof v !== "string" || !v) continue;
      const at = DAY.test(v) ? dayTime(v) : Date.parse(v);
      if (!Number.isNaN(at)) placed.push({ key: item.id, label, items: [item], at, ...(DAY.test(v) && { day: v }) });
    } else if (typeof v === "number") placed.push({ key: item.id, label, items: [item], number: v });
  }
  return placed.sort((a, b) => (a.at ?? a.number ?? 0) - (b.at ?? b.number ?? 0));
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
  const ranked = [...sizes.entries()].sort((a, b) => b[1] - a[1] || naturalCompare(a[0], b[0])).map(([n]) => n);
  const kept = new Set(ranked.slice(0, MAX_SERIES));
  const named = (label: string) => (kept.has(label) ? label : OTHER);
  const names = ranked.length > MAX_SERIES ? [...ranked.slice(0, MAX_SERIES), OTHER] : ranked;
  return {
    names,
    items: (category, series) => category.items.filter((i) => (labelsOf.get(i) ?? []).some((l) => named(l) === series)),
  };
}

/** A series' values along the X axis, in order, made into a running total, the change from the step before or a moving average. */
export function transformValues(values: (number | null)[], transform: Transform, window = MOVING_WINDOW.initial): (number | null)[] {
  if (transform === "none") return values;
  let running = 0;
  let previous: number | null = null;
  const recent: number[] = [];
  return values.map((v) => {
    if (v === null) return null;
    switch (transform) {
      case "cumulative":
        return (running += v);
      case "change": {
        const change = previous === null ? null : v - previous;
        previous = v;
        return change;
      }
      case "moving":
        recent.push(v);
        if (recent.length > window) recent.shift();
        return recent.reduce((a, b) => a + b, 0) / recent.length;
    }
  });
}

// --- The data a chart draws -----------------------------------------------------------------------

/** One series as drawn: its name (unique in the chart), the series it comes of and, split, its part. */
export interface DrawnSeries {
  name: string;
  series: ChartSeries;
  /** Split by a field: the value of it (`Split.names`). */
  split?: string;
}

/** One value of a chart: a category's in a drawn series. */
export interface ChartPoint {
  category: Category;
  series: string;
  value: number | null;
}

export interface ChartTable {
  categories: Category[];
  series: DrawnSeries[];
  points: ChartPoint[];
  /** The X axis's name ("" without one). */
  categoryLabel: string;
  /** The categories are on a time axis (`at`) / a number axis (`number`); else labels. */
  time: boolean;
  numeric: boolean;
}

/**
 * The values of a chart of categories: each category's (and split's) items made into each series'
 * value. `timeline`: a line or area (every date step in time order). The largest `top` categories
 * are measured by the first series. Split by a field, each series is split (named "Pages · Novel"
 * when there are several series). Missing values stay null (`missing`: joined over or a gap, chartSpec); a count or
 * sum of no items is 0.
 */
export function chartTable(input: ChartInput, options: ChartOptions, timeline = false): ChartTable {
  const { collection, ctx } = input;
  const byId = fieldsOf(collection);
  const measures = options.series.map((s) => ({ s, field: s.field ? byId.get(s.field) : undefined }));
  const measure = (items: Item[], m: (typeof measures)[number]) => aggregate(items, m.s.value, m.field);
  let categories = chartCategories(input, options.x, timeline);
  if (options.x.by === "field" && !timeline && measures.length) categories = topCategories(categories, options.x.top, (c) => measure(c.items, measures[0]));
  const field = xField(collection, options.x);
  const splitField = options.splitBy && !(options.x.by === "field" && options.splitBy === field?.id) ? byId.get(options.splitBy) : undefined;
  const split = splitSeries(categories, splitField, options.x.showEmpty, ctx);

  const drawn: DrawnSeries[] = [];
  const points: ChartPoint[] = [];
  const taken = new Set<string>();
  const uniqueName = (name: string) => {
    let n = name;
    for (let i = 2; taken.has(n); i++) n = `${name} (${i})`;
    taken.add(n);
    return n;
  };
  for (const m of measures) {
    const label = seriesLabel(m.s, collection, options.x);
    for (const part of split ? split.names : [undefined]) {
      const name = uniqueName(part === undefined ? label : measures.length > 1 ? `${label} · ${part}` : part);
      drawn.push({ name, series: m.s, ...(part !== undefined && { split: part }) });
      const raw = categories.map((c) => {
        const items = split && part !== undefined ? split.items(c, part) : c.items;
        // An empty step counts or adds up to 0; an item placed on its own isn't in the other parts at all.
        const v = items.length === 0 ? (options.x.by !== "item" && (m.s.value === "count" || m.s.value === "sum") ? 0 : null) : measure(items, m);
        return v;
      });
      transformValues(raw, m.s.transform, m.s.window).forEach((value, i) => points.push({ category: categories[i], series: name, value }));
    }
  }
  return {
    categories,
    series: drawn,
    points,
    categoryLabel: xLabel(collection, options),
    time: categories.length > 0 && categories.every((c) => c.at !== undefined),
    numeric: categories.length > 0 && categories.every((c) => c.number !== undefined),
  };
}

/** The total a pie, meter or gauge is measured against: the option's number, or the total field's values made into one like the value (a count against their sum); null = none. */
export function totalOf(collection: Collection, items: Item[], options: Pick<ChartOptions, "total" | "series">): number | null {
  const { total } = options;
  if (total.from === "number") return total.number;
  if (total.from !== "field") return null;
  const field = total.field ? fieldsOf(collection).get(total.field) : undefined;
  if (!field) return null;
  const how = options.series[0]?.value ?? "sum";
  return aggregate(items, how === "count" ? "sum" : how, field);
}

/** One part of a whole: its name and value; `rest`: what is left of the total ("Remaining"). */
export interface Part {
  name: string;
  value: number;
  rest?: boolean;
}

export interface Parts {
  parts: Part[];
  /** The parts' total: the chart's total, or their sum. */
  total: number;
  /** The value's name ("Sum of Pages"), or the fields' aggregate ("Sum"). */
  label: string;
}

/**
 * The parts of a whole: the X axis's groups (by the first series' value), several number fields
 * (each made into one by the first series' aggregate, a count read as a sum), or one value. Only
 * parts above 0; with a total larger than their sum, the rest as "Remaining" (when `rest`).
 */
export function partsOf(input: ChartInput, options: ChartOptions, rest = true): Parts {
  const { collection, items } = input;
  const byId = fieldsOf(collection);
  const first = options.series[0] ?? newSeries();
  const field = first.field ? byId.get(first.field) : undefined;
  let parts: Part[];
  let label = seriesLabel(first, collection);
  if (options.parts === "fields") {
    const how = first.value === "count" ? "sum" : first.value;
    label = AGGREGATES.find((a) => a.value === how)!.text;
    parts = options.fields.flatMap((id) => {
      const f = byId.get(id);
      const value = f ? aggregate(items, how, f) : null;
      return f && value !== null ? [{ name: f.name, value }] : [];
    });
  } else if (options.parts === "one") {
    const value = aggregate(items, first.value, field);
    parts = value === null ? [] : [{ name: label, value }];
  } else {
    // Parts are each a group's own value: no running total or moving average.
    const t = chartTable(input, { ...options, series: [{ ...first, transform: "none" }], splitBy: null });
    parts = t.points.flatMap((p) => (p.value === null ? [] : [{ name: p.category.label, value: p.value }]));
  }
  parts = parts.filter((p) => p.value > 0);
  const sum = parts.reduce((n, p) => n + p.value, 0);
  const total = totalOf(collection, items, options);
  if (rest && total !== null && total > sum && parts.length > 0) parts.push({ name: REMAINING, value: total - sum, rest: true });
  return { parts, total: total ?? sum, label };
}

/** One value made of all the chart's items (a gauge), and what it is measured against. */
export interface SingleValue {
  value: number | null;
  /** The total: the option's number, or the total field's values made into one the same way; null = none (the value is a %). */
  max: number | null;
  label: string;
}

export function singleValue(input: ChartInput, options: ChartOptions): SingleValue {
  const { collection, items } = input;
  const first = options.series[0] ?? newSeries();
  const field = first.field ? fieldsOf(collection).get(first.field) : undefined;
  return { value: aggregate(items, first.value, field), max: totalOf(collection, items, options), label: seriesLabel(first, collection) };
}

/**
 * What a gauge's or stat's value is compared with: `compare` of its items (of `compareField`, else the
 * value's own field; "Previous value" only after a last value), or the number typed; null for none.
 */
export function baselineOf(input: ChartInput, options: ChartOptions): number | null {
  const first = options.series[0] ?? newSeries();
  const how = options.compare === "prev" && first.value !== "last" ? null : options.compare;
  if (!how) return null;
  if (how === "number") return options.baseline;
  return aggregate(input.items, how, fieldsOf(input.collection).get(options.compareField ?? first.field ?? ""));
}

/** A stat: its value, what it is compared with, and the change (the difference, and its % of the baseline). */
export interface Stat {
  value: number | null;
  label: string;
  baseline: number | null;
  change: number | null;
  /** null: no baseline, or one of 0. */
  percent: number | null;
  /** How the change reads (`better`): up or down good or bad, neither, or none (no change, no baseline). */
  trend: "good" | "bad" | "neutral" | null;
}

export function statOf(input: ChartInput, options: ChartOptions): Stat {
  const { value, label } = singleValue(input, options);
  const baseline = baselineOf(input, options);
  const change = value === null || baseline === null ? null : value - baseline;
  const percent = change === null || !baseline ? null : (change / Math.abs(baseline)) * 100;
  const trend = !change ? null : options.better === "neither" ? "neutral" : (change > 0) === (options.better === "higher") ? "good" : "bad";
  return { value, label, baseline, change, percent, trend };
}

/** A value as a share of its max, in % (of 100 without a max); null without a value. */
export const percentOf = (value: number | null, max: number | null): number | null =>
  value === null ? null : max === null ? value : max === 0 ? 0 : (value / max) * 100;

/** A threshold as a % of the total (gauge and meter), whichever way it was set. */
export const thresholdPercent = (t: Threshold, mode: ChartOptions["thresholdMode"], max: number | null): number =>
  mode === "percent" ? t.value : (percentOf(t.value, max) ?? t.value);

/** The status of a share (%) by the thresholds (%): the highest reached, "success" below all; null without thresholds. */
export function statusOf(percent: number | null, thresholds: { value: number; status: ThresholdStatus }[]): "success" | ThresholdStatus | null {
  if (percent === null || thresholds.length === 0) return null;
  const reached = thresholds.filter((t) => percent >= t.value).sort((a, b) => b.value - a.value)[0];
  return reached?.status ?? "success";
}

/** A meter's status ranges in % (0 to 100) from thresholds in %: success up to the first, then each one's status up to the next; null without thresholds. */
export function statusRanges(thresholds: { value: number; status: ThresholdStatus }[]): { range: [number, number]; status: string }[] | null {
  if (thresholds.length === 0) return null;
  const cuts = [...thresholds].map((t) => ({ ...t, value: Math.max(0, Math.min(100, t.value)) })).sort((a, b) => a.value - b.value);
  const ranges: { range: [number, number]; status: string }[] = [];
  if (cuts[0].value > 0) ranges.push({ range: [0, cuts[0].value], status: "success" });
  cuts.forEach((c, i) => {
    const end = cuts[i + 1]?.value ?? 100;
    if (end > c.value) ranges.push({ range: [c.value, end], status: c.status });
  });
  return ranges;
}

/** A value rounded and with the unit: "72.5 kg" (`decimals` null: at most 2). */
export function formatValue(n: number, options: Pick<ChartOptions, "unit" | "decimals">): string {
  const text = options.decimals === null ? String(Math.round((n + Number.EPSILON) * 100) / 100) : n.toFixed(options.decimals);
  return options.unit.trim() ? `${text} ${options.unit.trim()}` : text;
}

/** One dot of a scatter: an item, by its X and Y (and size). */
export interface ScatterPoint {
  item: Item;
  title: string;
  /** Its colour: the series' name, or split, the split field's value. */
  series: string;
  x: number | string;
  y: number;
  size: number | null;
}

/** A scatter's dots: each item with an X (`x.field`) and a value of a series' field (a dot per series), coloured by series or Split by. */
export function scatterPoints(input: ChartInput, options: ChartOptions): ScatterPoint[] {
  const { collection, items, ctx } = input;
  const byId = fieldsOf(collection);
  const x = options.x.field ? byId.get(options.x.field) : undefined;
  const size = options.sizeField ? byId.get(options.sizeField) : undefined;
  const ys = options.series.flatMap((s) => (s.field && byId.has(s.field) ? [{ s, field: byId.get(s.field)! }] : []));
  if (!x || ys.length === 0) return [];
  const split = splitSeries([{ key: "", label: "", items }], options.splitBy ? byId.get(options.splitBy) : undefined, true, ctx);
  const points: ScatterPoint[] = [];
  for (const { s, field } of ys) {
    // A Y series is its field alone (whatever its aggregate): named after it.
    const name = s.label.trim() || field.name;
    for (const item of items) {
      const xv = fieldValue(item, x);
      const yv = fieldValue(item, field);
      if (typeof yv !== "number" || (typeof xv !== "number" && !(typeof xv === "string" && xv))) continue;
      const sv = size ? fieldValue(item, size) : null;
      const parts = split ? split.names.filter((n) => split.items({ key: "", label: "", items: [item] }, n).length > 0) : [name];
      for (const part of parts.length ? parts : [name]) {
        const series = split && ys.length > 1 ? `${name} · ${part}` : part;
        points.push({ item, title: itemLabel(collection, item), series, x: xv, y: yv, size: typeof sv === "number" ? sv : null });
      }
    }
  }
  return points;
}

/** A spread field's values (a date as its time, ms), per series: the X axis's categories (box plot) or Split by (histogram). */
export function spreadValues(input: ChartInput, options: ChartOptions, by: "x" | "split"): { series: string; value: number }[] {
  const { collection, items, ctx } = input;
  const byId = fieldsOf(collection);
  const field = options.spreadField ? byId.get(options.spreadField) : undefined;
  if (!field) return [];
  const values = (list: Item[]) =>
    isDateField(field)
      ? list.flatMap((i) => {
          const v = String(fieldValue(i, field) ?? "");
          const t = DAY.test(v) ? dayTime(v) : Date.parse(v);
          return Number.isNaN(t) ? [] : [t];
        })
      : numbersOf(list, field);
  if (by === "x") {
    const categories = options.x.by === "field" ? chartCategories(input, options.x) : [{ key: "", label: field.name, items }];
    return categories.flatMap((c) => values(c.items).map((value) => ({ series: c.label, value })));
  }
  const all: Category = { key: "", label: field.name, items };
  const split = splitSeries([all], options.splitBy ? byId.get(options.splitBy) : undefined, options.x.showEmpty, ctx);
  if (!split) return values(items).map((value) => ({ series: field.name, value }));
  return split.names.flatMap((n) => values(split.items(all, n)).map((value) => ({ series: n, value })));
}

/** The values of each radar spoke (a number field) per category of the X axis: one shape per group (the first series' aggregate; a count is an average). */
export function radarValues(input: ChartInput, options: ChartOptions): { series: string; spoke: string; value: number | null }[] {
  const byId = fieldsOf(input.collection);
  const spokes = options.fields.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  const first = options.series[0]?.value ?? "avg";
  const how = first === "count" ? "avg" : first;
  return topCategories(chartCategories(input, options.x), options.x.top || MAX_SERIES, (c) => c.items.length).flatMap((c) =>
    spokes.map((f) => ({ series: c.label, spoke: f.name, value: aggregate(c.items, how, f) })),
  );
}

/** A heatmap's cells: categories × Split by (the first series), or, with a date X axis and not split, weeks × weekdays (a calendar). */
export function heatmapCells(input: ChartInput, options: ChartOptions): { x: string; y: string; value: number | null }[] {
  const field = xField(input.collection, options.x);
  const one = { ...options, series: options.series.slice(0, 1) };
  const calendar = options.x.by === "field" && isDateField(field) && !options.splitBy;
  if (!calendar) {
    const table = chartTable(input, one);
    return table.points.map((p) => ({ x: p.category.label, y: table.series.length > 1 || options.splitBy ? p.series : table.series[0]?.name ?? "", value: p.value }));
  }
  const first = one.series[0] ?? newSeries();
  const valueField = first.field ? fieldsOf(input.collection).get(first.field) : undefined;
  // Only dated days ("No value", shown when no item has a date, has no place in a calendar).
  const days = chartCategories(input, { ...options.x, dateStep: "day" }, true).filter((d) => d.day);
  const names = weekdays(input.locale);
  return days.map((d) => {
    const [y, m, day] = periodAround("week", d.day!).start.split("-").map(Number);
    // Like chartTable: a day without items counts or adds up to 0.
    const value = d.items.length === 0 ? (first.value === "count" || first.value === "sum" ? 0 : null) : aggregate(d.items, first.value, valueField);
    return {
      // A week by its Sunday ("4 Jan"), a day by its name.
      x: new Date(y, m - 1, day).toLocaleDateString(input.locale, { day: "numeric", month: "short" }),
      y: names[new Date(dayTime(d.day!)).getDay()],
      value,
    };
  });
}

/** The weekdays' short names, Sunday first (a calendar heatmap's rows). */
export const weekdays = (locale?: string): string[] =>
  Array.from({ length: 7 }, (_, i) => new Date(2026, 0, 4 + i).toLocaleDateString(locale, { weekday: "short" })); // 4 January 2026 was a Sunday

/** A choropleth's values: a region's, and the categories that are no region of the map (with their items' number). */
export interface RegionValues {
  values: { region: Region; value: number }[];
  unmatched: { label: string; items: number }[];
}

/**
 * The value of each region of a map: the X axis's categories (a field's values) that are the region
 * (by its code or a name: domain/regions.ts), their items made into the first series' value. Two
 * categories of one region ("NL", "Netherlands") are one; a region without items has no value.
 */
export function regionValues(input: ChartInput, options: ChartOptions, regions: Region[]): RegionValues {
  const find = regionFinder(regions);
  const first = options.series[0] ?? newSeries();
  const field = first.field ? fieldsOf(input.collection).get(first.field) : undefined;
  const byRegion = new Map<Region, Item[]>();
  const unmatched: RegionValues["unmatched"] = [];
  for (const c of chartCategories(input, { ...options.x, by: "field", showEmpty: false, top: 0 })) {
    const region = find(c.label);
    if (!region) unmatched.push({ label: c.label, items: c.items.length });
    else byRegion.set(region, [...(byRegion.get(region) ?? []), ...c.items]);
  }
  const values = [...byRegion].flatMap(([region, items]) => {
    const value = aggregate(unique(items), first.value, field);
    return value === null ? [] : [{ region, value }];
  });
  return { values, unmatched };
}
