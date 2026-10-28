import { useEffect, useRef } from "react";
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

/** A Carbon chart; clicking a dot of a scatter opens its item (`onItem`, by the item's id). */
export default function ChartCanvas({ spec, onItem }: { spec: ChartSpec; onItem?(itemId: string, event: MouseEvent | undefined): void }) {
  const Chart = CHARTS[spec.chart] as React.ComponentType<{ data: unknown; options: unknown; ref: React.Ref<Instance> }>;
  const ref = useRef<Instance>(null);
  const onItemRef = useRef(onItem);
  onItemRef.current = onItem;
  useEffect(() => {
    const events = ref.current?.chart?.services?.events;
    if (!events) return;
    const click = (e: Event) => {
      const detail = (e as CustomEvent<{ datum?: { itemId?: string }; event?: MouseEvent }>).detail;
      if (detail?.datum?.itemId) onItemRef.current?.(detail.datum.itemId, detail.event);
    };
    events.addEventListener("scatter-click", click);
    return () => events.removeEventListener("scatter-click", click);
  }, [spec.chart]);
  // A new chart type is a new chart (Carbon's can't change type in place).
  return <Chart key={spec.chart} ref={ref} data={spec.data} options={spec.options} />;
}
