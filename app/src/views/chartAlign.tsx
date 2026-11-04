import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { alignChanged, alignCharts, NO_ALIGN, type AlignInput, type AlignOutput, type Edges } from "../domain/chartAlign";
import type { CarbonChart } from "./chartSpec";

// Lining up the charts of a page (the rule: domain/chartAlign.ts). `ChartAlignment` (around a page's blocks, BlockRows)
// keeps the charts shown in it; each chart (ChartCanvas, `useChartAlign`) is measured once it has been drawn and every
// time it is drawn again, and the page works out every chart's padding and shift again, a frame later. A chart that
// arrives later (a remote collection's rows, block by block) joins: only the charts whose padding changes are drawn
// again. `ChartLine` names the line of a row a block is on, side by side with the others of it (none: a row of its own).

/** A chart as the page knows it: what it is and how it is measured and moved. */
interface Entry {
  family: string;
  mode: "pad" | "shift";
  line: string | null;
  measure(): Omit<AlignInput, "id" | "family" | "mode" | "line"> | null;
  apply(out: AlignOutput): void;
}

interface Coordinator {
  register(id: string, entry: Entry): () => void;
  /** A chart was drawn (again): the page is aligned anew, a frame later. */
  changed(): void;
}

const AlignContext = createContext<Coordinator | null>(null);
/** The line of a row (BlockRows) a block is on, side by side with others; null: a row of its own, or stacked. */
export const ChartLine = createContext<string | null>(null);

/** A chart changed this often within CHANGES_MS is swinging: left as it is for a while. */
const MAX_CHANGES = 6;
const CHANGES_MS = 2000;

/** The charts within (a page's blocks) line up with each other. */
export function ChartAlignment({ children }: { children: ReactNode }) {
  const coordinator = useMemo<Coordinator>(() => {
    const entries = new Map<string, Entry>();
    const applied = new Map<string, AlignOutput>();
    // When each chart was last changed: one changed more than MAX_CHANGES times within CHANGES_MS (a tick label that
    // comes and goes as it is drawn smaller and back, swinging between two layouts) keeps what it has until it calms.
    const history = new Map<string, number[]>();
    let frame = 0;
    let checks: ReturnType<typeof setTimeout>[] = [];
    const run = () => {
      frame = 0;
      const inputs: AlignInput[] = [];
      for (const [id, e] of entries) {
        const m = e.measure();
        if (m) inputs.push({ id, family: e.family, mode: e.mode, line: e.line, ...m });
      }
      const out = alignCharts(inputs);
      for (const [id, next] of out) {
        const now = applied.get(id) ?? NO_ALIGN;
        if (!alignChanged(now, next)) continue;
        const at = performance.now();
        const recent = (history.get(id) ?? []).filter((t) => at - t < CHANGES_MS);
        if (recent.length >= MAX_CHANGES) continue;
        history.set(id, [...recent, at]);
        applied.set(id, next);
        entries.get(id)?.apply(next);
      }
    };
    const now = () => {
      if (!frame) frame = requestAnimationFrame(run);
    };
    // A chart isn't always done when Carbon says it has drawn (an axis's labels settle a moment later, without telling):
    // measured again a little later too, twice (cheap: only what changed is applied).
    const changed = () => {
      now();
      for (const c of checks) clearTimeout(c);
      checks = [setTimeout(now, 250), setTimeout(now, 1000)];
    };
    return {
      register(id, entry) {
        entries.set(id, entry);
        changed();
        return () => {
          entries.delete(id);
          applied.delete(id);
          history.delete(id);
          // The others line up without it.
          changed();
        };
      },
      changed,
    };
  }, []);
  useEffect(() => {
    window.addEventListener("resize", coordinator.changed);
    return () => window.removeEventListener("resize", coordinator.changed);
  }, [coordinator]);
  return <AlignContext.Provider value={coordinator}>{children}</AlignContext.Provider>;
}

/** Axis charts: their plot area (Carbon's grid backdrop). */
const PLOT = "rect.chart-grid-backdrop";

/**
 * A Carbon chart's family, how it is moved (domain/chartAlign.ts `mode`) and the marks whose box is its box; null for
 * one that isn't aligned. Every chart with axes is of one family (a bar chart lines up with a line chart).
 */
export function alignFamily(chart: CarbonChart, compact: boolean): { family: string; mode: "pad" | "shift"; marks: string } | null {
  if (compact) return { family: "sparkline", mode: "shift", marks: PLOT };
  switch (chart) {
    case "HeatmapChart":
      return { family: "axis", mode: "pad", marks: "rect.heat" };
    case "PieChart":
    case "DonutChart":
      return { family: "round", mode: "shift", marks: "path.slice" };
    case "GaugeChart":
      return { family: "gauge", mode: "shift", marks: "path.arc-background, path.arc-foreground" };
    case "RadarChart":
      // Its web: the rings and spokes, not the shapes on it.
      return { family: "radar", mode: "shift", marks: ".cds--cc--radar path:not(.blob), .cds--cc--radar line" };
    case "MeterChart":
      return { family: "meter", mode: "shift", marks: "rect.container" };
    case "TreemapChart":
      return { family: "treemap", mode: "pad", marks: "rect.leaf" };
    case "WordCloudChart":
      return { family: "wordcloud", mode: "shift", marks: "text.word" };
    case "ChoroplethChart":
      return { family: "map", mode: "shift", marks: "g.geo path" };
    default:
      return { family: "axis", mode: "pad", marks: PLOT };
  }
}

/** The box of the marks in `el` (page px), or null when there are none (yet). */
function marksBox(el: HTMLElement, marks: string): Edges | null {
  let box: Edges | null = null;
  for (const mark of el.querySelectorAll(marks)) {
    const r = mark.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    box = box
      ? { left: Math.min(box.left, r.left), top: Math.min(box.top, r.top), right: Math.max(box.right, r.right), bottom: Math.max(box.bottom, r.bottom) }
      : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }
  return box;
}

/**
 * A chart's place in its page's alignment: registered while shown (with its family, the line it is on), measured from
 * `box` (its frame: the element Carbon draws in, padded by what this returns). Returns the padding and shift to apply,
 * and `drawn`, to call whenever Carbon has drawn it (again). Outside a ChartAlignment (or a chart of no family): nothing.
 */
export function useChartAlign(box: RefObject<HTMLElement | null>, chart: CarbonChart, compact: boolean): { align: AlignOutput; drawn(): void } {
  const coordinator = useContext(AlignContext);
  const line = useContext(ChartLine);
  const id = useId();
  const [align, setAlign] = useState<AlignOutput>(NO_ALIGN);
  const current = useRef(align);
  current.current = align;
  const kind = alignFamily(chart, compact);
  const family = kind?.family;
  const mode = kind?.mode;
  const marks = kind?.marks;
  useEffect(() => {
    if (!coordinator || !family || !mode || !marks) return;
    const unregister = coordinator.register(id, {
      family,
      mode,
      line,
      measure() {
        const el = box.current;
        const found = el && marksBox(el, marks);
        if (!el || !found) return null;
        const r = el.getBoundingClientRect();
        const { pad, shift } = current.current;
        const frame = { left: r.left, right: r.right, top: r.top - shift, bottom: r.bottom - shift };
        // Its box's distances from the frame without the padding: what it draws by itself.
        const inset = {
          left: found.left - (frame.left + pad.left),
          right: frame.right - pad.right - found.right,
          top: found.top - shift - (frame.top + pad.top),
          bottom: frame.bottom - pad.bottom - (found.bottom - shift),
        };
        const body = el.closest(".block__body")?.getBoundingClientRect();
        return { frame, inset, room: body ? Math.max(0, body.bottom - frame.bottom) : 0 };
      },
      apply: setAlign,
    });
    return () => {
      unregister();
      setAlign(NO_ALIGN);
    };
  }, [coordinator, id, family, mode, marks, line, box]);
  const drawn = useCallback(() => coordinator?.changed(), [coordinator]);
  return { align, drawn };
}
