import { lazy, Suspense, useId, useMemo } from "react";
import { Checkbox, MultiSelect, NumberInput, Select, SelectItem, SelectItemGroup, Slider } from "@carbon/react";
import { ChartColumn } from "@carbon/icons-react";
import { useStore } from "../app/store";
import {
  AGGREGATES,
  axisFields,
  CHART_HEIGHTS,
  GAUGE_WIDTH,
  CHART_KINDS,
  CHART_WIDTH,
  DATE_STEPS,
  defaultChartOptions,
  isSingleValue,
  normalizeChartOptions,
  numberFields,
  splitFields,
  usesCategories,
  type Aggregate,
  type ChartKind,
  type ChartOptions,
} from "../domain/chart";
import type { FieldDef } from "../domain/model";
import { pickableFields } from "../domain/model";
import { useMediaQuery } from "../ui/useMediaQuery";
import { useBuffered } from "../ui/useBuffered";
import { refLabelOf } from "../ui/useReferenceOptions";
import { openModeOf } from "../workspace/Workspace";
import { chartSpec } from "./chartSpec";
import { defineBlockType, type BlockOptionsProps, type BlockProps } from "./registry";

// A chart of the block's items (Carbon Charts). Like a table, its filter picks the items and its
// grouping (Sort and group) makes the categories: a bar per group, a slice, a step of a line. Its
// settings say what is measured and how it looks (domain/chart.ts); views/chartSpec.ts makes
// Carbon's data and options of them. Carbon Charts (and d3) load the first time a chart is shown.

const ChartCanvas = lazy(() => import("./ChartCanvas"));

function ChartView({ collection, result, options, refs, actions }: BlockProps<ChartOptions>) {
  const dark = useMediaQuery("(prefers-color-scheme: dark)");
  // The block's grouping (its categories): read from its actions, which follow its query.
  const groupBy = actions.groupBy;
  const spec = useMemo(() => {
    const groupField = groupBy ? pickableFields(collection).find((f) => f.id === groupBy) : undefined;
    const ctx = { refLabel: refLabelOf(refs, "(deleted)") };
    return chartSpec({ collection, result, groupField, ctx }, options, dark ? "g100" : "white");
  }, [collection, result, groupBy, refs, options, dark]);
  if ("problem" in spec) return <p className="helper chart-block__problem">{spec.problem}</p>;
  const byId = (id: string) => result.groups.flatMap((g) => g.items).find((i) => i.id === id);
  return (
    <div className="chart-block" style={{ maxInlineSize: `${options.width}rem` }}>
      <Suspense fallback={<div className="chart-block__loading" />}>
        <ChartCanvas
          spec={spec}
          onItem={(id, event) => {
            const item = byId(id);
            if (item) actions.open(item, event ? openModeOf(event) : "here");
          }}
        />
      </Suspense>
    </div>
  );
}

// --- Settings -------------------------------------------------------------------------------------

/** Which settings a chart type has. */
const has = (kind: ChartKind) => ({
  value: ["bar", "line", "pie", "treemap", "wordcloud", "heatmap", "gauge", "meter", "bullet"].includes(kind),
  field: ["histogram", "boxplot"].includes(kind),
  split: ["bar", "line", "treemap", "heatmap"].includes(kind),
  dates: ["bar", "line", "pie", "treemap", "wordcloud", "heatmap"].includes(kind),
  top: ["bar", "pie", "treemap", "wordcloud", "radar"].includes(kind),
  empty: usesCategories(kind) && kind !== "line",
  second: kind === "bar" || kind === "line",
  measured: isSingleValue(kind),
  thresholds: kind === "gauge" || kind === "meter",
  height: kind !== "meter" && kind !== "bullet",
});

const TOPS = [0, 5, 8, 12, 20];
const BINS = [0, 5, 10, 20, 50];
/** "Measured against" as a select value: nothing (100), a typed number, or a field's id. */
const NONE = "";
const NUMBER = "$number";

/** A select of fields (or none). */
function FieldSelect({ id, label, fields, value, none, disabled, onChange }: { id: string; label: string; fields: FieldDef[]; value: string | null; none?: string; disabled?: boolean; onChange(id: string | null): void }) {
  return (
    <Select size="sm" id={id} labelText={label} value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
      {none !== undefined ? <SelectItem value="" text={none} /> : <SelectItem value="" text="Choose…" disabled hidden />}
      {fields.map((f) => (
        <SelectItem key={f.id} value={f.id} text={f.name} />
      ))}
    </Select>
  );
}

function ChartOptionsEditor({ collection, options, onChange }: BlockOptionsProps<ChartOptions>) {
  const uid = useId();
  const { components } = useStore();
  // Numbers are typed here and stored after a pause (each change of a block's options is stored).
  const [o, update] = useBuffered(options, onChange);
  const set = (patch: Partial<ChartOptions>) => update({ ...o, ...patch });
  const numbers = numberFields(collection, components);
  const show = has(o.chart);
  const sections = [...new Set(CHART_KINDS.map((k) => k.section))];
  const check = (key: keyof ChartOptions, label: string) => (
    <Checkbox id={`${uid}-${key}`} labelText={label} checked={o[key] === true} onChange={(_, { checked }) => set({ [key]: checked })} />
  );
  const aggregates = (id: string, label: string, value: Aggregate | null, onAggregate: (a: Aggregate | null) => void, opts: { none?: boolean; count?: boolean } = {}) => (
    <Select size="sm" id={id} labelText={label} value={value ?? ""} onChange={(e) => onAggregate((e.target.value || null) as Aggregate | null)}>
      {opts.none && <SelectItem value="" text="None" />}
      {AGGREGATES.filter((a) => opts.count !== false || a.value !== "count").map((a) => (
        <SelectItem key={a.value} value={a.value} text={a.text} />
      ))}
    </Select>
  );
  const measuredAgainst = o.maxField ?? (o.max !== null ? NUMBER : NONE);
  return (
    <div className="view-options">
      {/* A gauge as wide as a pane is mostly empty: switching to one makes a full-width chart small. */}
      <Select
        size="sm"
        id={`${uid}-chart`}
        labelText="Chart"
        value={o.chart}
        onChange={(e) => {
          const chart = e.target.value as ChartKind;
          set({ chart, ...(chart === "gauge" && o.width === CHART_WIDTH.max && { width: GAUGE_WIDTH }) });
        }}
      >
        {sections.map((s) => (
          <SelectItemGroup key={s} label={s}>
            {CHART_KINDS.filter((k) => k.section === s).map((k) => (
              <SelectItem key={k.kind} value={k.kind} text={k.label} />
            ))}
          </SelectItemGroup>
        ))}
      </Select>
      {usesCategories(o.chart) && <p className="helper chart-options__note">{o.chart === "meter" || o.chart === "bullet" ? "Grouped (Sort and group): a part or bar per group." : "Categories: the block's grouping (Sort and group)."}</p>}

      {show.value && (
        <>
          {aggregates(`${uid}-value`, "Value", o.value, (value) => set({ value: value ?? "count" }))}
          <FieldSelect id={`${uid}-value-field`} label="Of" fields={numbers} value={o.valueField} disabled={o.value === "count"} onChange={(valueField) => set({ valueField })} />
        </>
      )}
      {o.chart === "radar" && (
        <>
          {aggregates(`${uid}-value`, "Value", o.value === "count" ? "avg" : o.value, (value) => set({ value: value ?? "avg" }), { count: false })}
          <MultiSelect<FieldDef>
            autoAlign
            size="sm"
            id={`${uid}-spokes`}
            titleText="Spokes"
            label={o.fields.length ? numbers.filter((f) => o.fields.includes(f.id)).map((f) => f.name).join(", ") : "Choose number fields"}
            items={numbers}
            itemToString={(f) => f?.name ?? ""}
            selectedItems={numbers.filter((f) => o.fields.includes(f.id))}
            onChange={({ selectedItems }) => set({ fields: (selectedItems ?? []).map((f) => f.id) })}
          />
        </>
      )}
      {show.field && <FieldSelect id={`${uid}-field`} label="Field" fields={numbers} value={o.valueField} onChange={(valueField) => set({ valueField })} />}
      {o.chart === "histogram" && (
        <Select size="sm" id={`${uid}-bins`} labelText="Bins" value={String(o.bins)} onChange={(e) => set({ bins: Number(e.target.value) })}>
          {BINS.map((n) => (
            <SelectItem key={n} value={String(n)} text={n === 0 ? "Automatic" : String(n)} />
          ))}
        </Select>
      )}
      {o.chart === "scatter" && (
        <>
          <FieldSelect id={`${uid}-x`} label="X" fields={axisFields(collection, components)} value={o.xField} onChange={(xField) => set({ xField })} />
          <FieldSelect id={`${uid}-y`} label="Y" fields={numbers} value={o.valueField} onChange={(valueField) => set({ valueField })} />
          <FieldSelect id={`${uid}-size`} label="Size (bubbles)" fields={numbers} value={o.sizeField} none="Same size" onChange={(sizeField) => set({ sizeField })} />
        </>
      )}
      {show.split && <FieldSelect id={`${uid}-split`} label="Split by" fields={splitFields(collection)} value={o.splitBy} none="Not split" onChange={(splitBy) => set({ splitBy })} />}
      {show.dates && (
        <Select size="sm" id={`${uid}-dates`} labelText="Date steps" helperText="When grouped by a date" value={o.dateStep} onChange={(e) => set({ dateStep: e.target.value as ChartOptions["dateStep"] })}>
          {DATE_STEPS.map((d) => (
            <SelectItem key={d.value} value={d.value} text={d.text} />
          ))}
        </Select>
      )}
      {show.top && (
        <Select size="sm" id={`${uid}-top`} labelText="Show" value={String(o.top)} onChange={(e) => set({ top: Number(e.target.value) })}>
          {TOPS.map((n) => (
            <SelectItem key={n} value={String(n)} text={n === 0 ? "All groups" : `The largest ${n}, the rest as Other`} />
          ))}
        </Select>
      )}
      {show.measured && (
        <>
          <Select
            size="sm"
            id={`${uid}-max`}
            labelText={o.chart === "bullet" ? "Target" : "Measured against"}
            value={measuredAgainst}
            onChange={(e) => {
              const v = e.target.value;
              set(v === NONE ? { max: null, maxField: null } : v === NUMBER ? { max: o.max ?? 100, maxField: null } : { maxField: v });
            }}
          >
            <SelectItem value={NONE} text={o.chart === "bullet" ? "None" : "100 (the value is a %)"} />
            <SelectItem value={NUMBER} text="A number" />
            {numbers.map((f) => (
              <SelectItem key={f.id} value={f.id} text={f.name} />
            ))}
          </Select>
          {measuredAgainst === NUMBER && (
            <NumberInput size="sm" id={`${uid}-max-number`} label="Number" hideSteppers allowEmpty value={o.max ?? ""} onChange={(_, { value }) => set({ max: value === "" || Number.isNaN(Number(value)) ? null : Number(value) })} />
          )}
        </>
      )}
      {show.thresholds && (
        <>
          <NumberInput size="sm" id={`${uid}-warn`} label="Warning from (%)" hideSteppers allowEmpty value={o.warnAt ?? ""} onChange={(_, { value }) => set({ warnAt: value === "" || Number.isNaN(Number(value)) ? null : Number(value) })} />
          <NumberInput size="sm" id={`${uid}-danger`} label="Danger from (%)" hideSteppers allowEmpty value={o.dangerAt ?? ""} onChange={(_, { value }) => set({ dangerAt: value === "" || Number.isNaN(Number(value)) ? null : Number(value) })} />
        </>
      )}
      {show.second && (
        <>
          {aggregates(`${uid}-second`, "Second value (a line)", o.second, (second) => set({ second }), { none: true })}
          <FieldSelect id={`${uid}-second-field`} label="Of" fields={numbers} value={o.secondField} disabled={!o.second || o.second === "count"} onChange={(secondField) => set({ secondField })} />
        </>
      )}
      {show.height && (
        <Select size="sm" id={`${uid}-height`} labelText="Height" value={o.height} disabled={o.chart === "line" && o.compact} onChange={(e) => set({ height: e.target.value as ChartOptions["height"] })}>
          {CHART_HEIGHTS.map((h) => (
            <SelectItem key={h.value} value={h.value} text={h.text} />
          ))}
        </Select>
      )}
      <Slider
        id={`${uid}-width`}
        labelText="Width"
        min={CHART_WIDTH.min}
        max={CHART_WIDTH.max}
        step={CHART_WIDTH.step}
        value={o.width}
        formatLabel={(v) => `${v}rem`}
        hideTextInput
        onChange={({ value }) => set({ width: value })}
      />
      <div className="view-options__checks">
        {show.empty && check("showEmpty", "Show items without a value")}
        {/* Only what applies (with the chosen split, area, second value). */}
        {o.chart === "bar" && (
          <>
            {!o.second && check("horizontal", "Horizontal")}
            {o.splitBy && !o.lollipop && !o.second && check("stacked", "Stacked")}
            {check("lollipop", "Lollipops")}
          </>
        )}
        {o.chart === "line" && (
          <>
            {check("area", "Fill the area")}
            {o.area && o.splitBy && check("percent", "As shares of 100%")}
            {check("cumulative", "Running total")}
            {check("compact", "Compact (a sparkline)")}
          </>
        )}
        {o.chart === "pie" && check("donut", "Donut")}
        {o.chart === "gauge" && check("fullCircle", "Full circle")}
        {o.chart === "meter" && check("proportional", "Parts of a whole (by group)")}
      </div>
    </div>
  );
}

export const chartBlock = defineBlockType<ChartOptions>({
  kind: "chart",
  label: "Chart",
  icon: ChartColumn,
  defaultOptions: (collection) => defaultChartOptions(collection),
  normalizeOptions: (raw, collection) => normalizeChartOptions(raw, collection),
  // Its grouping is its categories (a gauge has none: one value of all its items).
  uses: (options) => ({ query: true, all: true, groups: options.chart !== "gauge" && !(options.chart === "meter" && !options.proportional), fields: null }),
  View: ChartView,
  OptionsEditor: ChartOptionsEditor,
});
