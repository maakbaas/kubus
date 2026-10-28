// What Carbon Charts draws for a chart block: the chart component, its data and its options, made
// from the block's items (domain/chart.ts). Plain objects, no Carbon import: ChartCanvas (loaded
// only when a chart is shown) picks the component by name.

import {
  CHART_HEIGHTS,
  chartTable,
  heatmapCells,
  percentOf,
  radarValues,
  resultItems,
  scatterPoints,
  singleValue,
  aggregate,
  statusOf,
  valueLabel,
  valuesByCategory,
  weekdays,
  type ChartInput,
  type ChartOptions,
  type ChartTable,
} from "../domain/chart";
import { pickableFields } from "../domain/model";

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
  | "BulletChart";

export interface ChartSpec {
  chart: CarbonChart;
  data: Record<string, unknown>[];
  options: Record<string, unknown>;
}

/** Why there is nothing to draw (shown instead of an empty chart); null when there is. */
export type ChartProblem = string | null;

const HEIGHT_REM = Object.fromEntries(CHART_HEIGHTS.map((h) => [h.value, h.rem]));
/** A sparkline's height. */
const COMPACT_REM = 4;

/** What every chart shares: its theme and height, no toolbar, a legend only with more than one series. */
function base(options: ChartOptions, theme: string, legend: boolean, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    theme,
    height: `${options.chart === "line" && options.compact ? COMPACT_REM : HEIGHT_REM[options.height]}rem`,
    resizable: true,
    animations: false,
    toolbar: { enabled: false },
    legend: { enabled: legend, clickable: legend },
    ...extra,
  };
}

/** A category's place on its axis: a date (time axis), a number, or its label. */
const domainValue = (t: ChartTable, p: ChartTable["points"][number]): Date | number | string =>
  t.time && p.category.day ? dayDate(p.category.day) : t.numeric && p.category.number !== undefined ? p.category.number : p.category.label;
const dayDate = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const scaleOf = (t: ChartTable) => (t.time ? "time" : t.numeric ? "linear" : "labels");

/** A category axis and a value axis, horizontal or not. */
function axes(t: ChartTable, horizontal: boolean, valueAxis: Record<string, unknown> = {}) {
  const domain = { mapsTo: t.time ? "date" : "key", scaleType: scaleOf(t), title: t.categoryLabel || undefined };
  const range = { mapsTo: "value", scaleType: "linear", title: t.valueLabel, ...valueAxis };
  return horizontal ? { left: domain, bottom: range } : { bottom: domain, left: range };
}

/** Points as Carbon's rows: series as `group`, the category as `key` (or `date`). */
const rows = (t: ChartTable) =>
  t.points.filter((p) => p.value !== null).map((p) => ({ group: p.series, [t.time ? "date" : "key"]: domainValue(t, p), value: p.value }));

/** A second value drawn as a line against its own (right) axis: a combo of the main chart and that line. */
function combo(input: ChartInput, options: ChartOptions, theme: string, t: ChartTable, mainType: string): ChartSpec | null {
  if (!options.second || options.splitBy) return null;
  const field = pickableFields(input.collection).find((f) => f.id === options.secondField);
  const second = chartTable(input, { ...options, value: options.second, valueField: options.secondField, top: 0, cumulative: false }, mainType === "line");
  // The main table may keep only its largest categories: the line follows them.
  const kept = new Set(t.categories.map((c) => c.key));
  const label = valueLabel(options.second, field, input.collection);
  const name = label === t.valueLabel ? `${label} (2)` : label;
  const lineRows = rows({ ...second, points: second.points.filter((p) => kept.has(p.category.key)).map((p) => ({ ...p, series: name })) });
  const a = axes(t, false, { main: true, correspondingDatasets: [t.valueLabel] });
  return {
    chart: "ComboChart",
    data: [...rows(t), ...lineRows],
    options: base(options, theme, true, {
      axes: { ...a, right: { mapsTo: "value", scaleType: "linear", title: name, correspondingDatasets: [name] } },
      comboChartTypes: [
        { type: mainType, correspondingDatasets: [t.valueLabel] },
        { type: "line", correspondingDatasets: [name] },
      ],
    }),
  };
}

/**
 * The chart for a block: its type's Carbon chart, data and options; or why there is nothing to draw
 * (no items, a setting still to choose).
 */
export function chartSpec(input: ChartInput, options: ChartOptions, theme: string): ChartSpec | { problem: string } {
  const fields = new Map(pickableFields(input.collection).map((f) => [f.id, f]));
  const needsValueField = options.value !== "count" && !fields.has(options.valueField ?? "");
  const noItems = { problem: "No items to chart." };
  switch (options.chart) {
    case "bar": {
      if (needsValueField) return { problem: "Choose the field to add up." };
      const t = chartTable(input, options);
      if (t.points.length === 0) return noItems;
      const made = combo(input, options, theme, t, options.lollipop ? "lollipop" : "simple-bar");
      if (made) return made;
      const split = t.series.length > 1 || !!options.splitBy;
      const chart = options.lollipop ? "LollipopChart" : !split ? "SimpleBarChart" : options.stacked ? "StackedBarChart" : "GroupedBarChart";
      return {
        chart,
        data: rows(t),
        options: base(options, theme, split, { axes: axes(t, options.horizontal, split && options.stacked && !options.lollipop ? { stacked: true } : {}) }),
      };
    }
    case "line": {
      if (needsValueField) return { problem: "Choose the field to add up." };
      const t = chartTable(input, options, true);
      if (t.points.length === 0) return noItems;
      const made = !options.compact && combo(input, options, theme, t, "line");
      if (made) return made;
      const split = t.series.length > 1 || !!options.splitBy;
      const chart = options.area ? (split ? "StackedAreaChart" : "AreaChart") : "LineChart";
      const a = axes(t, false, options.area && split ? { stacked: true, percentage: options.percent } : {});
      const hidden = { visible: false, title: undefined };
      return {
        chart,
        data: rows(t),
        options: base(options, theme, split && !options.compact, {
          axes: options.compact ? { bottom: { ...a.bottom, ...hidden }, left: { ...a.left, ...hidden } } : a,
          ...(options.compact && { grid: { x: { enabled: false }, y: { enabled: false } }, points: { enabled: false }, tooltip: { enabled: true } }),
          curve: "curveMonotoneX",
        }),
      };
    }
    case "pie": {
      if (needsValueField) return { problem: "Choose the field to add up." };
      const t = chartTable(input, { ...options, splitBy: null });
      const data = t.points.filter((p) => p.value !== null && p.value > 0).map((p) => ({ group: p.category.label, value: p.value }));
      if (data.length === 0) return noItems;
      const total = data.reduce((n, d) => n + (d.value ?? 0), 0);
      return options.donut
        ? { chart: "DonutChart", data, options: base(options, theme, true, { resizable: true, donut: { center: { label: t.valueLabel, number: total } } }) }
        : { chart: "PieChart", data, options: base(options, theme, true) };
    }
    case "radar": {
      if (options.fields.length < 3) return { problem: "Choose at least three number fields for the spokes." };
      const data = radarValues(input, options).filter((d) => d.value !== null).map((d) => ({ group: d.series, key: d.spoke, value: d.value }));
      if (data.length === 0) return noItems;
      const groups = new Set(data.map((d) => d.group));
      return { chart: "RadarChart", data, options: base(options, theme, groups.size > 1, { radar: { axes: { angle: "key", value: "value" } } }) };
    }
    case "treemap": {
      if (needsValueField) return { problem: "Choose the field to add up." };
      const t = chartTable(input, options);
      const split = !!options.splitBy;
      const data = t.categories
        .map((c) => ({
          name: c.label,
          children: t.points
            .filter((p) => p.category === c && p.value !== null && p.value > 0)
            .map((p) => ({ name: split ? p.series : c.label, value: p.value })),
        }))
        .filter((c) => c.children.length > 0);
      if (data.length === 0) return noItems;
      return { chart: "TreemapChart", data, options: base(options, theme, false) };
    }
    case "wordcloud": {
      if (needsValueField) return { problem: "Choose the field to add up." };
      const t = chartTable(input, { ...options, splitBy: null });
      const data = t.points.filter((p) => p.value !== null && p.value > 0).map((p) => ({ word: p.category.label, value: p.value, group: t.valueLabel }));
      if (data.length === 0) return noItems;
      return { chart: "WordCloudChart", data, options: base(options, theme, false, { wordCloud: { wordMapsTo: "word", fontSizeMapsTo: "value" } }) };
    }
    case "histogram": {
      const field = fields.get(options.valueField ?? "");
      if (!field) return { problem: "Choose the number field whose values to spread." };
      const data = valuesByCategory(input, options).map((v) => ({ group: v.series, value: v.value }));
      if (data.length === 0) return noItems;
      const groups = new Set(data.map((d) => d.group));
      return {
        chart: "HistogramChart",
        data,
        options: base(options, theme, groups.size > 1, {
          axes: {
            bottom: { mapsTo: "value", title: field.name, bins: options.bins || undefined, limitDomainToBins: true },
            left: { scaleType: "linear", binned: true, title: input.collection.pluralName },
          },
        }),
      };
    }
    case "boxplot": {
      const field = fields.get(options.valueField ?? "");
      if (!field) return { problem: "Choose the number field whose values to spread." };
      const data = valuesByCategory(input, options).map((v) => ({ group: v.series, key: v.series, value: v.value }));
      if (data.length === 0) return noItems;
      return {
        chart: "BoxplotChart",
        data,
        options: base(options, theme, false, {
          axes: { left: { mapsTo: "value", scaleType: "linear", title: field.name }, bottom: { mapsTo: "group", scaleType: "labels", title: input.groupField?.name } },
        }),
      };
    }
    case "scatter": {
      const x = fields.get(options.xField ?? "");
      const y = fields.get(options.valueField ?? "");
      if (!x || !y) return { problem: "Choose the fields for X and Y." };
      const time = x.kind === "date" || x.kind === "datetime";
      const points = scatterPoints(input, options);
      if (points.length === 0) return noItems;
      const bubbles = points.some((p) => p.size !== null);
      const data = points.map((p) => ({
        group: p.series,
        x: time ? new Date(p.x) : p.x,
        y: p.y,
        ...(bubbles && { size: p.size ?? 0 }),
        // Shown in the tooltip; the id opens the item when its dot is clicked.
        title: p.title,
        itemId: p.item.id,
      }));
      const size = fields.get(options.sizeField ?? "");
      const groups = new Set(data.map((d) => d.group));
      return {
        chart: bubbles ? "BubbleChart" : "ScatterChart",
        data,
        options: base(options, theme, groups.size > 1, {
          axes: {
            bottom: { mapsTo: "x", scaleType: time ? "time" : "linear", title: x.name },
            left: { mapsTo: "y", scaleType: "linear", title: y.name },
          },
          ...(bubbles && { bubble: { radiusMapsTo: "size", radiusLabel: size?.name } }),
        }),
      };
    }
    case "heatmap": {
      if (needsValueField) return { problem: "Choose the field to add up." };
      const cells = heatmapCells(input, options);
      if (cells.length === 0) return noItems;
      const t = chartTable(input, { ...options, top: 0 });
      const calendar = !options.splitBy && t.time;
      const splitName = fields.get(options.splitBy ?? "")?.name;
      // Cells without anything are left undrawn (Carbon would paint them its lightest colour, white
      // also in dark themes); the axes keep every column and row, in order.
      const shown = cells.filter((c) => c.value !== null && c.value !== 0);
      if (shown.length === 0) return noItems;
      const xs = [...new Set(cells.map((c) => c.x))];
      // A calendar's weeks run down from Sunday (Carbon draws the first label at the bottom).
      const ys = calendar ? weekdays(input.locale).reverse() : [...new Set(cells.map((c) => c.y))].reverse();
      return {
        chart: "HeatmapChart",
        data: shown.map((c) => ({ x: c.x, y: c.y, value: c.value })),
        options: base(options, theme, true, {
          axes: {
            bottom: { mapsTo: "x", scaleType: "labels", domain: xs, title: calendar ? undefined : t.categoryLabel || undefined },
            left: { mapsTo: "y", scaleType: "labels", domain: ys, title: calendar ? undefined : splitName },
          },
          heatmap: { colorLegend: { title: t.valueLabel }, colorDomain: { min: Math.min(0, ...shown.map((c) => c.value!)), max: Math.max(...shown.map((c) => c.value!)) } },
        }),
      };
    }
    case "gauge": {
      if (needsValueField) return { problem: "Choose the field to measure." };
      const one = singleValue(input.collection, resultItems(input.result), options);
      const percent = percentOf(one.value, one.max);
      if (percent === null) return { problem: "No value to show." };
      const status = statusOf(percent, options.warnAt, options.dangerAt);
      return {
        chart: "GaugeChart",
        data: [{ group: "value", value: Math.round(Math.min(100, Math.max(0, percent)) * 10) / 10 }],
        options: base(options, theme, false, {
          gauge: { type: options.fullCircle ? "full" : "semi", ...(status && { status }), showPercentageSymbol: !options.asValue, numberFormatter: (n: number) => (options.asValue ? String(Math.round(((one.max === null ? n : (n * one.max) / 100) + Number.EPSILON) * 100) / 100) : String(n)), deltaArrow: { enabled: false } },
        }),
      };
    }
    case "meter": {
      const items = resultItems(input.result);
      // Parts of a whole by number fields (fat, bone, muscle of a total weight): each field's value is a part.
      if (options.proportional && options.fields.length > 0) {
        const how = options.value === "count" ? "sum" : options.value;
        const data = options.fields.flatMap((id) => {
          const field = fields.get(id);
          const value = field ? aggregate(items, how, field) : null;
          return field && value !== null && value > 0 ? [{ group: field.name, value }] : [];
        });
        if (data.length === 0) return noItems;
        const total = singleValue(input.collection, items, options).max ?? data.reduce((n, d) => n + d.value, 0);
        return { chart: "MeterChart", data, options: base(options, theme, true, { height: "6rem", meter: { proportional: { total } } }) };
      }
      if (needsValueField) return { problem: "Choose the field to measure." };
      if (options.proportional) {
        const t = chartTable(input, { ...options, splitBy: null });
        const data = t.points.filter((p) => p.value !== null && p.value > 0).map((p) => ({ group: p.category.label, value: p.value }));
        if (data.length === 0) return noItems;
        const total = singleValue(input.collection, items, options).max ?? data.reduce((n, d) => n + (d.value ?? 0), 0);
        return { chart: "MeterChart", data, options: base(options, theme, true, { height: "6rem", meter: { proportional: { total } } }) };
      }
      const one = singleValue(input.collection, items, options);
      const percent = percentOf(one.value, one.max);
      if (percent === null) return { problem: "No value to show." };
      const ranges = thresholdRanges(options);
      return {
        chart: "MeterChart",
        // The bar is in %; the label gives the value itself against its max.
        data: [{ group: one.max === null || one.value === null ? one.label : `${one.label}: ${num(one.value)} of ${num(one.max)}`, value: Math.round(Math.min(100, Math.max(0, percent)) * 10) / 10 }],
        options: base(options, theme, false, { height: "5rem", meter: { ...(ranges && { status: { ranges } }) } }),
      };
    }
    case "bullet": {
      if (needsValueField) return { problem: "Choose the field to measure." };
      const t = chartTable(input, { ...options, splitBy: null });
      const target = (c: ChartTable["categories"][number]) => singleValue(input.collection, c.items, options).max;
      const data = t.categories.flatMap((c) => {
        const value = t.points.find((p) => p.category === c)?.value ?? null;
        return value === null ? [] : [{ title: c.label, group: t.valueLabel, value, marker: target(c) }];
      });
      if (data.length === 0) return noItems;
      return {
        chart: "BulletChart",
        data,
        options: base(options, theme, false, {
          height: `${Math.max(6, data.length * 3 + 3)}rem`,
          axes: { left: { mapsTo: "title", scaleType: "labels" }, bottom: { mapsTo: "value", scaleType: "linear", title: t.valueLabel } },
        }),
      };
    }
  }
}

const num = (n: number) => String(Math.round(n * 100) / 100);

/** A meter's status ranges (in %) from its warning and danger thresholds; null without either. */
function thresholdRanges(options: ChartOptions): { range: [number, number]; status: string }[] | null {
  const { warnAt, dangerAt } = options;
  if (warnAt === null && dangerAt === null) return null;
  const cuts = [warnAt, dangerAt].filter((n): n is number => n !== null).map((n) => Math.max(0, Math.min(100, n)));
  const ranges: { range: [number, number]; status: string }[] = [];
  const first = Math.min(...cuts);
  ranges.push({ range: [0, first], status: "success" });
  if (warnAt !== null && dangerAt !== null && warnAt < dangerAt) ranges.push({ range: [warnAt, dangerAt], status: "warning" });
  ranges.push({ range: [dangerAt ?? warnAt!, 100], status: dangerAt !== null ? "danger" : "warning" });
  return ranges;
}
