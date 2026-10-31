// What Carbon Charts draws for a chart block: the chart component, its data and its options, made
// from the block's items and the chart's settings (domain/chart.ts). Plain objects, no Carbon import:
// ChartCanvas (loaded only when a chart is shown) picks the component by name.

import {
  baselineOf,
  chartTable,
  formatValue,
  heatmapCells,
  isXY,
  needsField,
  partsOf,
  percentOf,
  radarValues,
  regionValues,
  scatterPoints,
  seriesLabel,
  singleValue,
  spreadValues,
  statusOf,
  statusRanges,
  thresholdStatus,
  styleOf,
  drawsTimeline,
  thresholdPercent,
  weekdays,
  xField,
  xLabel,
  type Category,
  type ChartAxis,
  type ChartInput,
  type ChartOptions,
  type ScaleColor,
  type DrawnSeries,
  type SeriesStyle,
  type ThresholdStatus,
} from "../domain/chart";
import { pickableFields, type FieldDef } from "../domain/model";
import { WORLD_MAP, type Region } from "../domain/regions";
import * as carbonColors from "@carbon/colors";
import { blockHeightCss } from "../domain/views";

/** The Carbon Charts components a chart block uses (named as @carbon/charts-react exports them). */
export type CarbonChart =
  | "SimpleBarChart"
  | "GroupedBarChart"
  | "StackedBarChart"
  | "LollipopChart"
  | "LineChart"
  | "AreaChart"
  | "StackedAreaChart"
  | "ComboChart"
  | "PieChart"
  | "DonutChart"
  | "RadarChart"
  | "TreemapChart"
  | "WordCloudChart"
  | "HistogramChart"
  | "BoxplotChart"
  | "ScatterChart"
  | "BubbleChart"
  | "HeatmapChart"
  | "GaugeChart"
  | "MeterChart"
  | "ChoroplethChart";

export interface ChartSpec {
  chart: CarbonChart;
  /** A choropleth's map: which (its `format` names it too), drawn with its TopoJSON (ChartCanvas's `geoData`). */
  map?: string;
  data: Record<string, unknown>[];
  options: Record<string, unknown>;
  /**
   * What the options' formatters depend on (unit, decimals, …), as plain values: ChartCanvas
   * compares specs as JSON, which leaves functions out, so a change of these must show here.
   */
  format: Record<string, unknown>;
}

type Problem = { problem: string };

/** A sparkline's height. */
const COMPACT_REM = 4;

/**
 * What every chart shares: its theme and height (the most it takes: ChartCanvas fits a pie or gauge
 * to less), no toolbar, the legend as set ("auto": with more than one series or part, `several`).
 */
/** Whether the chart shows its legend: as set ("auto": with more than one series or part), never on a compact chart. */
const legendShown = (options: ChartOptions, several: boolean) =>
  !(isXY(options.chart) && options.compact) && (options.legend === "auto" ? several : options.legend === "show");

function base(options: ChartOptions, theme: string, several: boolean, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const compact = isXY(options.chart) && options.compact;
  const legend = legendShown(options, several);
  return {
    theme,
    height: compact ? `${COMPACT_REM}rem` : blockHeightCss(options.height, options.aspect),
    resizable: true,
    animations: false,
    toolbar: { enabled: false },
    legend: { enabled: legend, clickable: legend, position: options.legendPosition },
    ...extra,
  };
}

/**
 * A meter's height in rem. Carbon draws a label row above the bar (its name and total, and a spacer): with
 * `meter.showLabels` off the bar would keep its place against the legend only if the row's height, measured
 * in the GUI suite (27.33px for one value's label, 37.33px for a proportional meter's with its breakdown),
 * were taken off, so it is. Likewise the legend's row above or below the bar (`legendRow`): one line of
 * legend items (1rem: Carbon's 16px line, its items' 5px margins cancelled by the list's -5px) and the 24px
 * spacer Carbon puts between legend and graph; a legend left or right of the bar takes no height.
 */
export const METER_LABEL_ROW_REM = { one: 27.33 / 16, proportional: 37.33 / 16 };
export const METER_LEGEND_ROW_REM = (16 + 24) / 16;
export function meterHeight(rem: number, row: keyof typeof METER_LABEL_ROW_REM, showLabel: boolean, legendRow = true): string {
  const height = rem - (showLabel ? 0 : METER_LABEL_ROW_REM[row]) - (legendRow ? 0 : METER_LEGEND_ROW_REM);
  return `${Math.round(height * 1000) / 1000}rem`;
}
/** Whether a meter's legend takes a row (shown, above or below the bar). */
const meterLegendRow = (options: ChartOptions, several: boolean) =>
  legendShown(options, several) && (options.legendPosition === "top" || options.legendPosition === "bottom");

const DATE_FORMAT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };

/**
 * The tooltip's values with the unit and decimals; those of `plain` labels (the X axis's, a
 * bubble's size) and anything not a number as Carbon would show them.
 */
const tooltip = (options: ChartOptions, input: ChartInput, plain: (string | undefined)[] = []) => ({
  valueFormatter: (v: unknown, label: string) =>
    typeof v === "number" && !plain.includes(label)
      ? formatValue(v, options)
      : v instanceof Date
        ? v.toLocaleDateString(input.locale, DATE_FORMAT)
        : typeof v === "number"
          ? v.toLocaleString(input.locale)
          : String(v),
});

/** A value axis's ticks with the unit and decimals (Carbon's own, shortened "1.2K", when neither is set). */
const ticks = (options: ChartOptions) =>
  options.unit.trim() || options.decimals !== null ? { ticks: { formatter: (n: number | Date) => formatValue(Number(n), options) } } : {};

const formatOf = (options: ChartOptions, extra: Record<string, unknown> = {}) => ({ unit: options.unit, decimals: options.decimals, ...extra });

/**
 * A value axis fitted to its values (not from 0): lines and dots show change (a weight from 80 to 70
 * reads as a fall, not a flat line). Bars and stacked areas keep 0, their length is their value.
 */
const FIT = { includeZero: false };

/** An axis's min and max as Carbon's domain (one not set: the values' extreme); null when neither is set. */
const domainOf = (a: ChartAxis, values: number[]): [number, number] | null =>
  a.min === null && a.max === null ? null : [a.min ?? Math.min(...values), a.max ?? Math.max(...values)];

/** Threshold lines on a value axis. Carbon sets their colour as a style, so a theme token works. */
const thresholdLines = (options: ChartOptions) =>
  options.thresholds.map((t) => ({
    value: t.value,
    label: thresholdStatus(t.status).text,
    fillColor: thresholdStatus(t.status).color,
    valueFormatter: (v: number) => formatValue(v, options),
  }));

/** The key the right axis' series carry their value under, with two axes (the left's is "value"). */
const RIGHT_KEY = "valueRight";

const CURVES: Record<ChartOptions["curve"], string> = { smooth: "curveMonotoneX", straight: "curveLinear", step: "curveStepAfter" };

const isDate = (f: FieldDef | undefined) => f?.kind === "date" || f?.kind === "datetime";
/** A status as Carbon's gauge and meter take it ("success" below every threshold); null for one it has none for. */
const carbonStatus = (status: string) => (status === "success" ? status : thresholdStatus(status as ThresholdStatus).carbon);
/** A date value as a Date: a day at its local midnight, a time as it is. */
const toDate = (v: string | number) => {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(v);
};
const clampPercent = (n: number) => Math.round(Math.min(100, Math.max(0, n)) * 10) / 10;

/** The categories' labels made unique (two items of the same title are two bars, not one). */
function uniqueLabels(categories: Category[]): Map<Category, string> {
  const taken = new Set<string>();
  return new Map(
    categories.map((c) => {
      let label = c.label;
      for (let i = 2; taken.has(label); i++) label = `${c.label} (${i})`;
      taken.add(label);
      return [c, label];
    }),
  );
}

/** Bar and lollipop are drawn along a bar's length (from 0, stackable, across when horizontal). */
const isBarStyle = (s: SeriesStyle) => s === "bar" || s === "lollipop";

/**
 * Bar, line and area: every series drawn its own way on its own axis. One style on one axis is
 * Carbon's chart of it; mixed styles or a right axis a combo (a lollipop in a combo is a bar: Carbon's
 * combo has no lollipop).
 */
function xyChart(input: ChartInput, options: ChartOptions, theme: string): ChartSpec | Problem {
  const styleOfSeries = (s: ChartOptions["series"][number]) => styleOf(s, options.chart);
  const timeline = drawsTimeline(options);
  const t = chartTable(input, options, timeline);
  if (t.points.every((p) => p.value === null)) return { problem: "No items to chart." };

  // Every series on the right is the same as every series on the left, with the right axis's settings.
  const anyLeft = t.series.some((d) => d.series.axis === "left");
  const sideOf = (d: DrawnSeries) => (anyLeft ? d.series.axis : "left");
  const axisOf = (side: "left" | "right"): ChartAxis => (side === "left" && !anyLeft ? options.right : options[side]);
  const dual = t.series.some((d) => sideOf(d) === "right");
  const styleOfDrawn = (d: DrawnSeries) => styleOfSeries(d.series);
  const on = (side: "left" | "right") => t.series.filter((d) => sideOf(d) === side);
  // Bars and areas stack with another of their style on the same axis (lollipops don't stack).
  const stacked = (d: DrawnSeries) =>
    options.stack !== "none" &&
    ["bar", "area"].includes(styleOfDrawn(d)) &&
    t.series.some((o) => o !== d && sideOf(o) === sideOf(d) && styleOfDrawn(o) === styleOfDrawn(d));
  const comboKind = (d: DrawnSeries) => (isBarStyle(styleOfDrawn(d)) ? "bar" : styleOfDrawn(d));
  const horizontal = options.horizontal && !dual && t.series.every((d) => isBarStyle(styleOfDrawn(d)));
  const bySeries = new Map(t.series.map((d) => [d.name, d]));

  const labels = uniqueLabels(t.categories);
  const place = (c: Category) => (t.time ? new Date(c.at!) : t.numeric ? c.number! : labels.get(c)!);
  const dataKey = t.time ? "date" : "key";
  // A missing value is left out (the line joins its neighbours) or, as a gap, kept empty: Carbon breaks a
  // line or an unstacked area there. Bars, dots and stacks leave it out either way.
  const gapped = (d: DrawnSeries) => options.missing === "gap" && ["line", "area"].includes(styleOfDrawn(d)) && !stacked(d);
  // With two axes each axis maps its own key (Carbon fits and filters every value axis by all the rows' values of its
  // `mapsTo`, whatever its `correspondingDatasets`): the right axis' series carry their value as `valueRight`.
  const valueKey = (side: "left" | "right") => (dual && side === "right" ? RIGHT_KEY : "value");
  const rows = t.points
    .filter((p) => (p.value === null ? gapped(bySeries.get(p.series)!) : !(axisOf(sideOf(bySeries.get(p.series)!)).log && p.value <= 0)))
    .map((p) => ({ group: p.series, [dataKey]: place(p.category), [valueKey(sideOf(bySeries.get(p.series)!))]: p.value }) as Record<string, unknown>);

  const domainAxis = {
    mapsTo: dataKey,
    scaleType: t.time ? "time" : t.numeric ? "linear" : "labels",
    title: t.categoryLabel || undefined,
    ...(t.numeric && FIT),
    ...(!t.time && !t.numeric && { domain: [...labels.values()] }),
  };
  const valueAxis = (side: "left" | "right") => {
    const a = axisOf(side);
    const series = on(side);
    const names = new Set(series.map((d) => d.name));
    const isStacked = series.some(stacked);
    const percent = isStacked && options.stack === "percent";
    const fitted = a.min === null && !isStacked && series.every((d) => !isBarStyle(styleOfDrawn(d)));
    // The values' extremes (stacked: the stacks'), from 0 unless fitted, for a min or max set alone.
    const key = valueKey(side);
    const mine = rows.filter((r) => names.has(r.group as string));
    const values = mine.map((r) => r[key] as number | null).filter((v): v is number => v !== null);
    if (isStacked) {
      const stacks = new Map<unknown, [number, number]>();
      for (const r of mine) {
        const v = r[key] as number | null;
        if (v === null) continue;
        const [lo, hi] = stacks.get(r[dataKey]) ?? [0, 0];
        stacks.set(r[dataKey], v < 0 ? [lo + v, hi] : [lo, hi + v]);
      }
      values.push(...[...stacks.values()].flat());
    }
    if (!fitted && !a.log) values.push(0);
    // Carbon fits every value axis to ALL the data under its `mapsTo`, whatever its `correspondingDatasets`
    // (the right axis would show the left series' scale): with two axes each is given its own series' extremes.
    const domain = percent ? null : (domainOf(a, values) ?? (dual ? ([Math.min(...values), Math.max(...values)] as [number, number]) : null));
    return {
      mapsTo: key,
      scaleType: a.log && !percent ? "log" : "linear",
      title: a.title.trim() || (series.length === 1 ? series[0].name : options.unit.trim()) || undefined,
      ...(isStacked && { stacked: true }),
      ...(percent ? { percentage: true, ticks: { formatter: (n: number | Date) => `${Number(n)}%` } } : ticks(options)),
      ...(domain && { domain }),
      ...(fitted && !domain && FIT),
      ...(side === "left" && !percent && options.thresholds.length > 0 && { thresholds: thresholdLines(options) }),
      ...(dual && { correspondingDatasets: series.map((d) => d.name) }),
      ...(dual && side === "left" && { main: true }),
    };
  };
  const leftAxis = valueAxis("left");
  const rightAxis = dual ? valueAxis("right") : null;
  // Carbon drops the rows outside an axis' domain, and any without that axis' key: every row also carries the other
  // axis' key, at that axis' lower end (inside its domain, so kept; its own series never read it).
  const lowerEnd = (axis: { domain?: number[] } | null) => axis?.domain?.[0] ?? 0;
  const data = dual ? rows.map((r) => ({ ...r, [RIGHT_KEY in r ? "value" : RIGHT_KEY]: lowerEnd(RIGHT_KEY in r ? leftAxis : rightAxis) })) : rows;
  const hidden = options.compact ? { visible: false, title: undefined } : {};
  const axes: Record<string, unknown> = horizontal
    ? { left: { ...domainAxis, ...hidden }, bottom: { ...leftAxis, ...hidden } }
    : { bottom: { ...domainAxis, ...hidden }, left: { ...leftAxis, ...hidden }, ...(rightAxis && { right: { ...rightAxis, ...hidden } }) };

  const styles = new Set(t.series.map(styleOfDrawn));
  const several = t.series.length > 1;
  const anyStacked = t.series.some(stacked);
  let chart: CarbonChart = "ComboChart";
  let combo: Record<string, unknown>[] | null = null;
  if (styles.size === 1 && !dual) {
    const [style] = styles;
    chart =
      style === "bar"
        ? !several ? "SimpleBarChart" : anyStacked ? "StackedBarChart" : "GroupedBarChart"
        : style === "lollipop" ? "LollipopChart"
          : style === "line" ? "LineChart"
            : style === "area" ? (anyStacked ? "StackedAreaChart" : "AreaChart")
              : "ScatterChart";
  } else {
    // A combo: a chart type per style (stacked ones per axis; unstacked bars and lollipops side by side across both).
    const groups = new Map<string, DrawnSeries[]>();
    for (const d of t.series) {
      const key = `${comboKind(d)}:${stacked(d) ? sideOf(d) : ""}`;
      groups.set(key, [...(groups.get(key) ?? []), d]);
    }
    combo = [...groups.values()].map((list) => {
      const kind = comboKind(list[0]);
      const names = list.map((d) => d.name);
      const isStacked = list.some(stacked);
      if (kind === "bar") return { type: names.length === 1 ? "simple-bar" : isStacked ? "stacked-bar" : "grouped-bar", correspondingDatasets: names };
      if (kind === "area") return { type: isStacked ? "stacked-area" : "area", correspondingDatasets: names };
      // Dots are drawn even when a line's are hidden.
      if (kind === "points") return { type: "scatter", options: { points: { enabled: true } }, correspondingDatasets: names };
      return { type: "line", correspondingDatasets: names };
    });
  }
  const lines = styles.has("line") || styles.has("area");
  return {
    chart,
    data,
    options: base(options, theme, several, {
      axes,
      tooltip: tooltip(options, input, [t.categoryLabel || (horizontal ? "y-value" : "x-value")]),
      ...(combo && { comboChartTypes: combo }),
      ...(lines && { curve: CURVES[options.curve] }),
      ...(lines && (!options.points || options.compact) && { points: { enabled: false } }),
      ...(options.compact && { grid: { x: { enabled: false }, y: { enabled: false } } }),
    }),
    format: formatOf(options),
  };
}

/** Carbon pads a linear axis' domain by this share of it on each side (its `paddingRatio`). */
const CARBON_PADDING = 0.1;

/**
 * A sparkline whose line runs the whole width, as its area's box does: Carbon leaves room at the X axis' ends (a time
 * scale a step on each side, `timeScale.addSpaceOnEdges`; a linear one 10% of its domain; labels half a band each).
 * Time: no added space. Numbers: a domain that Carbon's padding widens to exactly the values' extremes. Labels: their
 * place in order on such a linear axis instead, the tooltip naming each by its label.
 */
function edgeToEdge(spec: ChartSpec): ChartSpec {
  const axes = spec.options.axes as { bottom?: { mapsTo: string; scaleType: string; domain?: unknown[] } } | undefined;
  const bottom = axes?.bottom;
  if (!bottom) return spec;
  if (bottom.scaleType === "time") return { ...spec, options: { ...spec.options, timeScale: { addSpaceOnEdges: 0 } } };
  const labels = bottom.scaleType === "labels" ? ((bottom.domain ?? []) as string[]) : null;
  const key = labels ? "index" : bottom.mapsTo;
  const data = labels ? (spec.data as Record<string, unknown>[]).map((d) => ({ ...d, index: labels.indexOf(d[bottom.mapsTo] as string) })) : spec.data;
  const xs = (data as Record<string, unknown>[]).map((d) => d[key]).filter((x): x is number => typeof x === "number");
  if (xs.length < 2) return spec;
  const [lo, hi] = [Math.min(...xs), Math.max(...xs)];
  // Carbon makes [a, b] into [a − r(b − a), b + r(b − a)]: given this, that is [lo, hi].
  const inner = (hi - lo) / (1 + 2 * CARBON_PADDING);
  const domain = [lo + inner * CARBON_PADDING, hi - inner * CARBON_PADDING];
  const tooltip = spec.options.tooltip as { valueFormatter: (v: unknown, label: string) => string };
  return {
    ...spec,
    data,
    options: {
      ...spec.options,
      axes: { ...axes, bottom: { ...bottom, mapsTo: key, scaleType: "linear", domain, includeZero: false } },
      // A compact chart's X axis has no title: Carbon calls it "x-value".
      tooltip: {
        ...tooltip,
        valueFormatter: (v: unknown, label: string) =>
          label === "x-value" && typeof v === "number" ? (labels ? (labels[v] ?? "") : v.toLocaleString()) : tooltip.valueFormatter(v, label),
      },
    },
  };
}

/** What a parts chart (pie, meter, treemap, word cloud) is still missing; null when nothing. */
function partsProblem(input: ChartInput, options: ChartOptions): string | null {
  if (options.parts === "fields") return options.fields.length === 0 ? "Choose the number fields that are the parts." : null;
  if (needsField(options.series[0], input.collection)) return "Choose the field to add up.";
  // The groups of no X axis are one part: only worth drawing against a total.
  if (options.parts === "groups" && options.x.by === "none" && options.total.from === "none") return "Choose the X axis field whose groups are the parts.";
  return null;
}

/**
 * The chart for a block: its type's Carbon chart, data and options; or why there is nothing to draw
 * (a setting still to choose, no items). A stat's sparkline is coloured by its own direction. A choropleth needs its map's
 * `regions` (views/regionMaps.ts loads them).
 */
export function chartSpec(input: ChartInput, options: ChartOptions, theme: string, regions?: Region[]): ChartSpec | Problem {
  const { collection, items } = input;
  const fields = new Map(pickableFields(collection).map((f) => [f.id, f]));
  const first = options.series[0];
  const noItems = { problem: "No items to chart." };
  const missing = options.series.findIndex((s) => needsField(s, collection));
  const valueMissing = { problem: "Choose the field to add up." };
  const format = formatOf(options);
  const several = (n: number) => n > 1;

  switch (options.chart) {
    case "bar":
    case "line":
    case "area": {
      if (missing >= 0) return { problem: options.series.length > 1 ? `Choose the field of series ${missing + 1}.` : valueMissing.problem };
      if (items.length === 0) return noItems;
      return xyChart(input, options, theme);
    }
    case "pie": {
      const problem = partsProblem(input, options);
      if (problem) return { problem };
      const parts = partsOf(input, options);
      if (parts.parts.length === 0) return noItems;
      const data = parts.parts.map((p) => ({ group: p.name, value: p.value }));
      const extra = { tooltip: tooltip(options, input) };
      return options.donut
        ? {
            chart: "DonutChart",
            data,
            options: base(options, theme, several(data.length), {
              ...extra,
              donut: { center: { label: parts.label, number: parts.total, numberFormatter: (n: number) => formatValue(n, options) } },
            }),
            format,
          }
        : { chart: "PieChart", data, options: base(options, theme, several(data.length), extra), format };
    }
    case "meter": {
      if (options.parts === "one") {
        if (needsField(first, collection)) return valueMissing;
        if (items.length === 0) return noItems;
        const one = singleValue(input, options);
        const percent = percentOf(one.value, one.max);
        if (percent === null || one.value === null) return { problem: "No value to show." };
        const ranges = statusRanges(options.thresholds.map((t) => ({ value: thresholdPercent(t, options.thresholdMode, one.max), status: t.status })))?.flatMap((r) => {
          const status = carbonStatus(r.status);
          return status ? [{ ...r, status }] : [];
        });
        const label = `${one.label}: ${formatValue(one.value, options)}${one.max === null ? "" : ` of ${formatValue(one.max, options)}`}`;
        return {
          chart: "MeterChart",
          // The bar is in %; the label gives the value itself against its total.
          data: [{ group: label, value: clampPercent(percent) }],
          options: base(options, theme, false, { height: meterHeight(5, "one", options.showLabel, meterLegendRow(options, false)), meter: { showLabels: options.showLabel, ...(ranges && { status: { ranges } }) } }),
          format,
        };
      }
      const problem = partsProblem(input, options);
      if (problem) return { problem };
      // Carbon draws what the parts leave of the total itself.
      const parts = partsOf(input, options, false);
      if (parts.parts.length === 0) return noItems;
      const fmt = (n: number) => formatValue(n, options);
      return {
        chart: "MeterChart",
        data: parts.parts.map((p) => ({ group: p.name, value: p.value })),
        options: base(options, theme, true, {
          height: meterHeight(6, "proportional", options.showLabel, meterLegendRow(options, true)),
          tooltip: tooltip(options, input),
          meter: {
            showLabels: options.showLabel,
            proportional: {
              total: parts.total,
              totalFormatter: (total: number) => `${fmt(total)} total`,
              breakdownFormatter: ({ datasetsTotal, total }: { datasetsTotal: number; total: number }) =>
                datasetsTotal === total ? "" : `${fmt(datasetsTotal)} used (${fmt(total - datasetsTotal)} available)`,
            },
          },
        }),
        format,
      };
    }
    case "treemap": {
      const problem = partsProblem(input, options);
      if (problem) return { problem };
      let data: { name: string; children: { name: string; value: number }[] }[];
      if (options.parts !== "fields" && options.splitBy) {
        // Split: a rectangle per category, its splits inside.
        const t = chartTable(input, { ...options, series: [first] });
        data = t.categories.map((c) => ({
          name: c.label,
          children: t.points.filter((p) => p.category === c && p.value !== null && p.value > 0).map((p) => ({ name: p.series, value: p.value! })),
        }));
      } else {
        const parts = partsOf(input, options.parts === "one" ? { ...options, parts: "groups" } : options, false);
        data = parts.parts.map((p) => ({ name: p.name, children: [{ name: p.name, value: p.value }] }));
      }
      data = data.filter((c) => c.children.length > 0);
      if (data.length === 0) return noItems;
      return { chart: "TreemapChart", data, options: base(options, theme, false, { tooltip: tooltip(options, input) }), format };
    }
    case "wordcloud": {
      const problem = partsProblem(input, options);
      if (problem) return { problem };
      const parts = partsOf(input, options, false);
      const data = parts.parts.map((p) => ({ word: p.name, value: p.value, group: parts.label }));
      if (data.length === 0) return noItems;
      return {
        chart: "WordCloudChart",
        data,
        options: base(options, theme, false, { tooltip: tooltip(options, input), wordCloud: { wordMapsTo: "word", fontSizeMapsTo: "value" } }),
        format,
      };
    }
    case "stat": {
      // Its sparkline: the value along the X axis as a compact line or area (Carbon's), the value's series alone.
      if (needsField(first, collection)) return { problem: "Choose the field to show." };
      if (items.length === 0) return noItems;
      const line: ChartOptions = {
        ...options,
        chart: options.sparkline === "line" ? "line" : "area",
        compact: true,
        series: [{ ...first, style: null, axis: "left" }],
        splitBy: null,
        thresholds: [],
        left: { ...options.left, min: null, max: null, log: false },
      };
      const drawn = xyChart(input, line, theme);
      // As tall as its place in the stat (StatView, styles.css: a compact chart's 4rem).
      const sparkline = "problem" in drawn ? drawn : edgeToEdge({ ...drawn, options: { ...drawn.options, height: "100%" } });
      // Coloured by where the line goes (its last point against its first, read by `better`): green up good, red
      // down bad; flat or "neither" in Carbon's first chart colour. Not the tag's change: its baseline may differ.
      if ("problem" in sparkline) return sparkline;
      const points = (sparkline.data as { group?: string; value?: unknown }[]).filter((d) => typeof d.value === "number");
      const group = points[0]?.group;
      const rise = points.length > 1 ? (points[points.length - 1].value as number) - (points[0].value as number) : 0;
      if (!group || !rise || options.better === "neither") return sparkline;
      const color = (rise > 0) === (options.better === "higher") ? "var(--cds-support-success)" : "var(--cds-support-error)";
      return { ...sparkline, options: { ...sparkline.options, color: { scale: { [group]: color } } } };
    }
    case "gauge": {
      if (needsField(first, collection)) return { problem: "Choose the field to measure." };
      if (items.length === 0) return noItems;
      const one = singleValue(input, options);
      const percent = percentOf(one.value, one.max);
      if (percent === null) return { problem: "No value to show." };
      const reached = statusOf(percent, options.thresholds.map((t) => ({ value: thresholdPercent(t, options.thresholdMode, one.max), status: t.status })));
      const status = reached && carbonStatus(reached);
      // The change from the comparison value, in the same % of the total ("Previous" only after a last value).
      const before = baselineOf(input, options);
      const beforePercent = percentOf(before, one.max);
      const delta = beforePercent === null ? 0 : Math.round((percent - beforePercent) * 100) / 100;
      // Carbon's gauge shows a %, here with the decimals; it hands the number over as text ("30").
      const shown = (v: number | string) => formatValue(Number(v), { unit: "", decimals: options.decimals });
      return {
        chart: "GaugeChart",
        data: [{ group: "value", value: clampPercent(percent) }, ...(delta !== 0 ? [{ group: "delta", value: delta }] : [])],
        options: base(options, theme, false, {
          gauge: {
            type: options.fullCircle ? "full" : "semi",
            ...(status && { status }),
            numberFormatter: shown,
            deltaArrow: { enabled: delta !== 0 },
          },
        }),
        format: formatOf(options, { max: one.max }),
      };
    }
    case "radar": {
      if (options.fields.filter((id) => fields.has(id)).length < 3) return { problem: "Choose at least three number fields for the spokes." };
      if (items.length === 0) return noItems;
      const data = radarValues(input, options).filter((d) => d.value !== null).map((d) => ({ group: d.series, key: d.spoke, value: d.value }));
      if (data.length === 0) return noItems;
      const groups = new Set(data.map((d) => d.group));
      return {
        chart: "RadarChart",
        data,
        options: base(options, theme, several(groups.size), { tooltip: tooltip(options, input), radar: { axes: { angle: "key", value: "value" } } }),
        format,
      };
    }
    case "histogram": {
      const field = fields.get(options.spreadField ?? "");
      if (!field) return { problem: "Choose the number or date field whose values to spread." };
      const time = isDate(field);
      const data = spreadValues(input, options, "split").map((v) => ({ group: v.series, value: time ? new Date(v.value) : v.value }));
      if (data.length === 0) return noItems;
      const groups = new Set(data.map((d) => d.group));
      return {
        chart: "HistogramChart",
        data,
        options: base(options, theme, several(groups.size), {
          axes: {
            bottom: { mapsTo: "value", ...(time && { scaleType: "time" }), title: options.xTitle.trim() || field.name, bins: options.bins || undefined, limitDomainToBins: true },
            left: { scaleType: "linear", binned: true, title: options.left.title.trim() || collection.pluralName },
          },
        }),
        format,
      };
    }
    case "boxplot": {
      const field = fields.get(options.spreadField ?? "");
      if (!field) return { problem: "Choose the number or date field whose values to spread." };
      const time = isDate(field);
      const data = spreadValues(input, options, "x").map((v) => ({ group: v.series, key: v.series, value: time ? new Date(v.value) : v.value }));
      if (data.length === 0) return noItems;
      return {
        chart: "BoxplotChart",
        data,
        options: base(options, theme, false, {
          axes: {
            left: { mapsTo: "value", scaleType: time ? "time" : "linear", title: options.left.title.trim() || field.name, ...(!time && ticks(options)) },
            bottom: { mapsTo: "group", scaleType: "labels", title: (options.x.by === "field" && xLabel(collection, options)) || undefined },
          },
          ...(!time && { tooltip: tooltip(options, input) }),
        }),
        format,
      };
    }
    case "scatter": {
      const x = fields.get(options.x.field ?? "");
      const ys = options.series.filter((s) => s.field && fields.has(s.field));
      if (!x || ys.length === 0) return { problem: "Choose the fields for X and Y." };
      if (items.length === 0) return noItems;
      const time = isDate(x);
      const log = options.left.log;
      const points = scatterPoints(input, options).filter((p) => !(log && p.y <= 0));
      if (points.length === 0) return noItems;
      const bubbles = points.some((p) => p.size !== null);
      const data = points.map((p) => ({
        group: p.series,
        x: time ? toDate(p.x) : p.x,
        y: p.y,
        ...(bubbles && { size: p.size ?? 0 }),
        // Shown in the tooltip; the id opens the item when its dot is clicked.
        title: p.title,
        itemId: p.item.id,
      }));
      const size = fields.get(options.sizeField ?? "");
      const groups = new Set(data.map((d) => d.group));
      const xTitle = options.xTitle.trim() || x.name;
      const yTitle = options.left.title.trim() || (ys.length === 1 ? seriesLabel(ys[0], collection, { ...options.x, by: "item" }) : options.unit.trim()) || undefined;
      const domain = domainOf(options.left, points.map((p) => p.y));
      return {
        chart: bubbles ? "BubbleChart" : "ScatterChart",
        data,
        options: base(options, theme, several(groups.size), {
          axes: {
            bottom: { mapsTo: "x", scaleType: time ? "time" : "linear", title: xTitle, ...FIT },
            left: {
              mapsTo: "y",
              scaleType: log ? "log" : "linear",
              title: yTitle,
              ...(domain ? { domain } : FIT),
              ...ticks(options),
              ...(options.thresholds.length > 0 && { thresholds: thresholdLines(options) }),
            },
          },
          tooltip: tooltip(options, input, [xTitle, size?.name]),
          ...(bubbles && { bubble: { radiusMapsTo: "size", radiusLabel: size?.name } }),
        }),
        format,
      };
    }
    case "heatmap": {
      if (needsField(first, collection)) return valueMissing;
      if (items.length === 0) return noItems;
      const cells = heatmapCells(input, options);
      const calendar = options.x.by === "field" && isDate(xField(collection, options.x)) && !options.splitBy;
      // Cells without anything are left undrawn (Carbon would paint them its lightest colour, white
      // also in dark themes); the axes keep every column and row, in order.
      const shown = cells.filter((c) => c.value !== null && c.value !== 0);
      if (shown.length === 0) return noItems;
      const xs = [...new Set(cells.map((c) => c.x))];
      // A calendar's weeks run down from Sunday (Carbon draws the first label at the bottom).
      const ys = calendar ? weekdays(input.locale).reverse() : [...new Set(cells.map((c) => c.y))].reverse();
      const values = shown.map((c) => c.value!);
      return {
        chart: "HeatmapChart",
        data: shown.map((c) => ({ x: c.x, y: c.y, value: c.value })),
        options: base(options, theme, true, {
          axes: {
            bottom: { mapsTo: "x", scaleType: "labels", domain: xs, title: calendar ? undefined : xLabel(collection, options) || undefined },
            left: { mapsTo: "y", scaleType: "labels", domain: ys, title: calendar ? undefined : fields.get(options.splitBy ?? "")?.name },
          },
          tooltip: tooltip(options, input),
          heatmap: { colorLegend: { title: seriesLabel(first, collection) }, colorDomain: { min: Math.min(0, ...values), max: Math.max(...values) } },
        }),
        format,
      };
    }
    case "choropleth": {
      if (!xField(collection, { ...options.x, by: "field" })) return { problem: "Choose the field whose values are the regions." };
      if (needsField(first, collection)) return valueMissing;
      if (!regions) return { problem: "Loading the map…" };
      if (items.length === 0) return noItems;
      const { values } = regionValues(input, options, regions);
      if (values.length === 0) return { problem: "No value of the field is a region of this map." };
      const map = options.regions.file ?? options.regions.map;
      // A Max (when a value is above it): those values drawn as it, in the darkest shade (Carbon fits its scale and
      // legend to the values), the tooltip their own.
      const max = options.scaleMax !== null && options.scaleMax > 0 && values.some((v) => v.value > options.scaleMax!) ? options.scaleMax : null;
      const real = new Map(values.map((v) => [v.region.key, v.value]));
      const tip = tooltip(options, input);
      return {
        chart: "ChoroplethChart",
        map,
        data: values.map((v) => ({ name: v.region.key, value: max === null ? v.value : Math.min(v.value, max) })),
        options: base(options, theme, true, {
          // The world as an equal-area map; a country or Europe as the familiar Mercator.
          thematic: { projection: options.regions.map === WORLD_MAP ? "geoNaturalEarth1" : "geoMercator" },
          // No legend title: Carbon's colour legend reads one from a heatmap's options only (so no Label is offered).
          choropleth: { colorLegend: { type: "linear" } },
          color: { gradient: { colors: scaleShades(options.scaleColor, theme) } },
          // The legend's numbers (Carbon formats them with its locale's `number`): with the decimals and unit.
          locale: { number: (n: number) => legendNumber(n, options, input.locale) },
          tooltip: { valueFormatter: (v: unknown, label: string) => tip.valueFormatter(real.get(label) ?? v, label) },
        }),
        // With a Max the values its tooltip shows (data has them capped).
        format: formatOf(options, { map, ...(max !== null && { max, values: [...real] }) }),
      };
    }
  }
}

/**
 * A choropleth's shades of its hue, lowest value first: Carbon's own scale (white, 10 … 100) without white, so a region
 * with a little is its palest shade (10) rather than white; on a dark theme the other way round, from 100 to 20 (not the
 * near-white 10).
 */
export function scaleShades(color: ScaleColor, theme: string): string[] {
  const grades = theme === "g100" ? [100, 90, 80, 70, 60, 50, 40, 30, 20] : [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const hue = carbonColors[color] as Record<number, string>;
  return grades.map((g) => hue[g]);
}

/** A choropleth legend's number: as Carbon shows it (with the locale's separators) unless decimals are set, then the unit. */
function legendNumber(n: number, options: ChartOptions, locale: string | undefined): string {
  const text = options.decimals === null ? n.toLocaleString(locale) : n.toFixed(options.decimals);
  const unit = options.unit.trim();
  return unit ? `${text} ${unit}` : text;
}
