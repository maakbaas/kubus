import { useEffect, useMemo, useRef, useState } from "react";
import {
  AreaChart,
  BoxplotChart,
  BubbleChart,
  ComboChart,
  DonutChart,
  GaugeChart,
  GroupedBarChart,
  HeatmapChart,
  HistogramChart,
  LineChart,
  LollipopChart,
  MeterChart,
  PieChart,
  RadarChart,
  ScatterChart,
  SimpleBarChart,
  StackedAreaChart,
  StackedBarChart,
  TreemapChart,
  WordCloudChart,
} from "@carbon/charts-react";
import "@carbon/charts-react/styles.css";
import type { CarbonChart, ChartSpec } from "./chartSpec";

// The Carbon Charts part of a chart block, in its own chunk: loaded (with d3) the first time a
// chart is shown, not with the app.

const CHARTS: Record<CarbonChart, unknown> = {
  SimpleBarChart,
  GroupedBarChart,
  StackedBarChart,
  LollipopChart,
  LineChart,
  AreaChart,
  StackedAreaChart,
  ComboChart,
  PieChart,
  DonutChart,
  RadarChart,
  TreemapChart,
  WordCloudChart,
  HistogramChart,
  BoxplotChart,
  ScatterChart,
  BubbleChart,
  HeatmapChart,
  GaugeChart,
  MeterChart,
};

/** The chart instance a Carbon Charts component holds, as far as it is used here: its events. */
interface Instance {
  chart?: { services?: { events?: { addEventListener(type: string, listener: (e: Event) => void): void; removeEventListener(type: string, listener: (e: Event) => void): void } } };
}

/**
 * Charts drawn round (a pie, a gauge, a radar): in a block wider than tall they are as tall as the
 * height, in a narrower one less tall, and the room around them is left out. What is drawn of them
 * (its own svg, found by this part).
 */
const ROUND: Partial<Record<CarbonChart, string>> = {
  PieChart: "g.slices",
  DonutChart: "g.slices",
  GaugeChart: "path.arc-background",
  RadarChart: "g.blobs",
};
/** Room kept around a round chart's drawing (a slice grows a little on hover). */
const FIT_PADDING = 8;

/** How much less tall than its box a chart's drawing is (px), or 0. */
function unusedHeight(holder: HTMLElement, part: string): number {
  const svg = holder.querySelector(part)?.closest("svg");
  if (!svg) return 0;
  let top = Infinity;
  let bottom = -Infinity;
  for (const child of svg.children) {
    const r = child.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    top = Math.min(top, r.top);
    bottom = Math.max(bottom, r.bottom);
  }
  if (bottom < top) return 0;
  return Math.max(0, svg.getBoundingClientRect().height - (bottom - top) - FIT_PADDING);
}

/**
 * The same spec as before while nothing in it changed (functions aside: what they depend on is
 * the spec's `format`): Carbon redraws a chart whenever its data or options are new objects, which
 * hides its tooltip under the pointer, so a re-render of the block with equal options must not hand
 * it new ones. `drawing` names its chart type and options: a new one is a new Carbon chart.
 */
function useStableSpec(spec: ChartSpec): { spec: ChartSpec; drawing: string } {
  const last = useRef<{ key: string; spec: ChartSpec; drawing: string } | null>(null);
  const key = JSON.stringify(spec);
  if (last.current?.key !== key) last.current = { key, spec, drawing: `${spec.chart}:${JSON.stringify([spec.options, spec.format])}` };
  return last.current;
}

/**
 * A Carbon chart; clicking a dot of a scatter opens its item (`onItem`, by the item's id). Its
 * height (the spec's) is the most it takes: a round chart narrower than that is fitted to its drawing.
 */
export default function ChartCanvas({ spec: latest, onItem }: { spec: ChartSpec; onItem?(itemId: string, event: MouseEvent | undefined): void }) {
  const { spec, drawing } = useStableSpec(latest);
  const Chart = CHARTS[spec.chart] as React.ComponentType<{ data: unknown; options: unknown; ref: React.Ref<Instance> }>;
  const ref = useRef<Instance>(null);
  const box = useRef<HTMLDivElement>(null);
  const onItemRef = useRef(onItem);
  onItemRef.current = onItem;
  // The fitted height (px) of a round chart; null = the spec's. Measured anew at the full height
  // whenever the chart or its width changes (fitted, its drawing can't show it has more room).
  const [fitted, setFitted] = useState<number | null>(null);
  const part = ROUND[spec.chart];
  useEffect(() => setFitted(null), [spec]);
  useEffect(() => {
    const el = box.current;
    if (!el || !part) return;
    let width = el.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const now = el.getBoundingClientRect().width;
      if (Math.abs(now - width) < 1) return;
      width = now;
      setFitted(null);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [part]);
  useEffect(() => {
    const events = ref.current?.chart?.services?.events;
    if (!events) return;
    const click = (e: Event) => {
      const detail = (e as CustomEvent<{ datum?: { itemId?: string }; event?: MouseEvent }>).detail;
      if (detail?.datum?.itemId) onItemRef.current?.(detail.datum.itemId, detail.event);
    };
    let frame = 0;
    const rendered = () => {
      const el = box.current;
      if (!part || !el) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const unused = unusedHeight(el, part);
        if (unused < 2) return;
        setFitted(Math.round(el.getBoundingClientRect().height - unused));
      });
    };
    events.addEventListener("scatter-click", click);
    events.addEventListener("render-finished", rendered);
    // The first drawing may be done before this listens.
    rendered();
    return () => {
      cancelAnimationFrame(frame);
      events.removeEventListener("scatter-click", click);
      events.removeEventListener("render-finished", rendered);
    };
  }, [drawing, part]);
  const options = useMemo(() => (fitted === null ? spec.options : { ...spec.options, height: `${fitted}px` }), [spec, fitted]);
  // New options (or a new chart type) are a new chart: Carbon merges new options into its old ones,
  // so whatever was taken out (a threshold, an axis's min, a title) would stay drawn. New data alone
  // is drawn in place.
  return (
    <div ref={box}>
      <Chart key={drawing} ref={ref} data={spec.data} options={options} />
    </div>
  );
}
