import { lazy, Suspense, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Accordion, AccordionItem, Button, Checkbox, IconButton, MultiSelect, NumberInput, Select, SelectItem, SelectItemGroup, Slider, TextInput } from "@carbon/react";
import { Add, ArrowDown, ArrowUp, ChartColumn, TrashCan } from "@carbon/icons-react";
import { useStore } from "../app/store";
import {
  AGGREGATES,
  axisFields,
  CHART_KINDS,
  CHART_WIDTH,
  chartItems,
  DATE_STEPS,
  defaultChartOptions,
  GAUGE_WIDTH,
  isParts,
  isXY,
  MAX_DECIMALS,
  MOVING_WINDOW,
  newSeries,
  normalizeChartOptions,
  numberFields,
  PREVIOUS,
  SERIES_STYLES,
  seriesLabel,
  splitFields,
  styleOf,
  TRANSFORMS,
  type Aggregate,
  type ChartKind,
  type ChartOptions,
  type ChartSeries,
  type ChartX,
  type Compare,
  type DateStep,
  type SeriesStyle,
  type ThresholdStatus,
  type Transform,
  type XBy,
} from "../domain/chart";
import type { Collection, FieldDef } from "../domain/model";
import type { GroupOrder } from "../domain/query";
import { useMediaQuery } from "../ui/useMediaQuery";
import { useBuffered } from "../ui/useBuffered";
import { refLabelOf } from "../ui/useReferenceOptions";
import { openModeOf } from "../workspace/Workspace";
import { chartSpec } from "./chartSpec";
import { HeightSlider } from "./HeightSlider";
import { defineBlockType, type BlockOptionsProps, type BlockProps } from "./registry";

// A chart of the block's items (Carbon Charts). Its filter and sort pick the items (on an item
// page it can chart the page's item alone: "Of"); everything else is the chart's own settings, in
// one place (domain/chart.ts): its X axis, its series, parts of a whole, thresholds, axes, values
// and size. It doesn't use the block's grouping: the X axis is its own. views/chartSpec.ts makes
// Carbon's data and options of them. Carbon Charts (and d3) load the first time a chart is shown.

const ChartCanvas = lazy(() => import("./ChartCanvas"));

function ChartView({ collection, result, options, refs, actions, page }: BlockProps<ChartOptions>) {
  const dark = useMediaQuery("(prefers-color-scheme: dark)");
  // "This item" charts the page's item, which only a block listing the page's collection has.
  const pageItem = page && page.collection.id === collection.id ? page.item : null;
  const wrongPage = options.scope === "page" && !!page && !pageItem;
  const items = useMemo(() => chartItems(result, options.scope, pageItem), [result, options.scope, pageItem]);
  const spec = useMemo(() => {
    const ctx = { refLabel: refLabelOf(refs, "(deleted)") };
    return chartSpec({ collection, items, ctx }, options, dark ? "g100" : "white");
  }, [collection, items, refs, options, dark]);
  if (wrongPage) return <p className="helper chart-block__problem">“Of this item” charts the page's item: the block lists {collection.pluralName}, not the page's collection.</p>;
  if ("problem" in spec) return <p className="helper chart-block__problem">{spec.problem}</p>;
  return (
    <div className="chart-block" style={{ maxInlineSize: `${options.width}rem` }}>
      <Suspense fallback={<div className="chart-block__loading" style={{ blockSize: String(spec.options.height) }} />}>
        <ChartCanvas
          spec={spec}
          onItem={(id, event) => {
            const item = items.find((i) => i.id === id);
            if (item) actions.open(item, event ? openModeOf(event) : "here");
          }}
        />
      </Suspense>
    </div>
  );
}

// --- Settings -------------------------------------------------------------------------------------
//
// Sections (a Carbon accordion) that are always the same for a chart kind: what doesn't apply to a
// kind is not in its sections; what doesn't apply because of another setting of it is shown
// disabled, with a short helper saying why, so nothing appears or vanishes under the pointer.
// Settings depend only on settings above them (or in sections above), so a helper text coming or
// going moves only what is below the control just used. One options shape for every kind:
// switching kind keeps the series, X axis and thresholds (`switchKind`).

/** Which sections and settings a chart kind has. */
function kindHas(kind: ChartKind) {
  const xy = isXY(kind);
  const parts = isParts(kind);
  return {
    xy,
    parts,
    /** Categories from the X axis (`options.x`). */
    x: xy || parts || kind === "radar" || kind === "boxplot" || kind === "heatmap",
    /** A list of series: bar / line / area (every setting), scatter (each a Y field). */
    seriesList: xy || kind === "scatter",
    /** One value (the first series): parts, gauge, heatmap. */
    value: parts || kind === "gauge" || kind === "heatmap",
    /** A number or date field whose values are spread. */
    spread: kind === "histogram" || kind === "boxplot",
    total: parts || kind === "gauge",
    thresholds: xy || kind === "gauge" || kind === "meter",
    axes: xy || kind === "histogram" || kind === "boxplot" || kind === "scatter",
    legend: kind !== "gauge",
    height: kind !== "meter",
    display: xy || kind === "pie" || kind === "gauge" || kind === "histogram",
  };
}

/** The label of the X axis's "By" for a kind: what its categories are. */
const X_LABEL: Partial<Record<ChartKind, string>> = { radar: "A shape per", pie: "Parts", meter: "Parts", treemap: "Parts", wordcloud: "Parts", boxplot: "A box per", heatmap: "Columns" };
const X_BY: { value: XBy; text: string }[] = [
  { value: "none", text: "Nothing (all items)" },
  { value: "field", text: "A field's values" },
  { value: "item", text: "Each item" },
];
const ORDERS: { value: GroupOrder; text: string }[] = [
  { value: "asc", text: "By value, ascending" },
  { value: "desc", text: "By value, descending" },
  { value: "count", text: "Largest first" },
];
const TOPS = [0, 5, 8, 12, 20];
const BINS = [0, 5, 10, 20, 50];
const STATUSES: { value: ThresholdStatus; text: string }[] = [
  { value: "warning", text: "Warning" },
  { value: "danger", text: "Danger" },
];
/** The merged Total select: the sum of the parts (or 100), a typed number, or a field's id. */
const TOTAL_NONE = "";
const TOTAL_NUMBER = "$number";

/** A series' "Draw as": the chart's own style kept as none (it follows the chart's kind), another as itself. */
const chartsStyle = (s: ChartSeries, style: SeriesStyle, chart: ChartKind): SeriesStyle | null => (style === styleOf({ ...s, style: null }, chart) ? null : style);
const isDate = (f: FieldDef | undefined) => f?.kind === "date" || f?.kind === "datetime";
const unique = <T,>(list: T[]) => [...new Set(list)];

/**
 * The options after switching chart kind: everything kept (one shape for all kinds), only what
 * must change adjusted. A gauge as wide as a pane is mostly empty: a full-width chart narrows to
 * GAUGE_WIDTH (and widens back when it leaves the gauge with that width). A scatter places each
 * item along its X field (`x.by` "item"), so it gets an axis field if it has none. Spokes (radar)
 * and parts from number fields start from the series' fields when none are chosen yet; a histogram
 * or box plot without a field starts from the first series'.
 */
function switchKind(o: ChartOptions, chart: ChartKind, axis: FieldDef[]): ChartOptions {
  const next: ChartOptions = { ...o, chart };
  if (chart === "gauge" && o.width === CHART_WIDTH.max) next.width = GAUGE_WIDTH;
  else if (o.chart === "gauge" && chart !== "gauge" && o.width === GAUGE_WIDTH) next.width = CHART_WIDTH.max;
  if (chart === "scatter") {
    const field = axis.some((f) => f.id === o.x.field) ? o.x.field : (axis[0]?.id ?? null);
    next.x = { ...o.x, by: "item", field };
  }
  const seriesFields = unique(o.series.flatMap((s) => (s.field && s.value !== "count" ? [s.field] : [])));
  if ((chart === "radar" || (isParts(chart) && o.parts === "fields")) && o.fields.length === 0) next.fields = seriesFields;
  if ((chart === "histogram" || chart === "boxplot") && !o.spreadField) next.spreadField = seriesFields[0] ?? axis[0]?.id ?? null;
  return next;
}

/** A select of fields (or none). */
function FieldSelect({
  id,
  label,
  fields,
  value,
  none,
  disabled,
  helper,
  hideLabel,
  onChange,
}: {
  id: string;
  label: string;
  fields: FieldDef[];
  value: string | null;
  none?: string;
  disabled?: boolean;
  helper?: ReactNode;
  hideLabel?: boolean;
  onChange(id: string | null): void;
}) {
  return (
    <Select size="sm" id={id} labelText={label} hideLabel={hideLabel} helperText={helper} value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
      {none !== undefined ? <SelectItem value="" text={none} /> : <SelectItem value="" text="Choose…" disabled hidden />}
      {fields.map((f) => (
        <SelectItem key={f.id} value={f.id} text={f.name} />
      ))}
    </Select>
  );
}

/**
 * A number typed in (empty allowed: `null`). It keeps what is typed ("1.", "-") while the stored
 * number follows, and shows a number changed elsewhere.
 */
function NumberField({ id, label, value, disabled, helper, hideLabel, onChange }: { id: string; label: string; value: number | null; disabled?: boolean; helper?: ReactNode; hideLabel?: boolean; onChange(value: number | null): void }) {
  const [text, setText] = useState(value === null ? "" : String(value));
  const parsed = text.trim() === "" ? null : Number(text);
  useEffect(() => {
    if (parsed !== value) setText(value === null ? "" : String(value));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <NumberInput
      size="sm"
      id={id}
      label={label}
      hideLabel={hideLabel}
      helperText={helper}
      hideSteppers
      allowEmpty
      disabled={disabled}
      value={text}
      onChange={(_, { value: v }) => {
        const s = String(v ?? "");
        setText(s);
        const n = s.trim() === "" ? null : Number(s);
        if (n === null || Number.isFinite(n)) onChange(n);
      }}
    />
  );
}

/** An accordion section of the settings: closed when the settings open, so they read as a list of sections. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <AccordionItem title={title}>
      <div className="chart-options__section">{children}</div>
    </AccordionItem>
  );
}

/** A row's heading in a list (a series): its name, and buttons to move or remove it. */
function RowHead({ title, index, count, noun, onMove, onRemove }: { title: string; index: number; count: number; noun: string; onMove(by: number): void; onRemove(): void }) {
  return (
    <div className="chart-options__row-head">
      <span className="chart-options__row-title" title={title}>
        {title}
      </span>
      <IconButton autoAlign label={`Move ${noun} up`} kind="ghost" size="sm" align="top" disabled={index === 0} onClick={() => onMove(-1)}>
        <ArrowUp />
      </IconButton>
      <IconButton autoAlign label={`Move ${noun} down`} kind="ghost" size="sm" align="top" disabled={index === count - 1} onClick={() => onMove(1)}>
        <ArrowDown />
      </IconButton>
      {/* A chart has at least one series: the last can't be removed. */}
      <IconButton autoAlign label={`Remove ${noun}`} kind="ghost" size="sm" align="top-end" disabled={count === 1} onClick={onRemove}>
        <TrashCan />
      </IconButton>
    </div>
  );
}

function ChartOptionsEditor({ collection, options, place, pageCollectionId, onChange }: BlockOptionsProps<ChartOptions>) {
  const uid = useId();
  const { components } = useStore();
  // Everything typed here (numbers, labels, titles) is stored after a pause: each change of a block's options is stored.
  const [o, update] = useBuffered(options, onChange);
  const set = (patch: Partial<ChartOptions>) => update({ ...o, ...patch });
  const setX = (patch: Partial<ChartX>) => set({ x: { ...o.x, ...patch } });
  const setSeries = (id: string, patch: Partial<ChartSeries>) => set({ series: o.series.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  const moveSeries = (index: number, by: number) => {
    const series = [...o.series];
    const [s] = series.splice(index, 1);
    series.splice(index + by, 0, s);
    set({ series });
  };
  const numbers = numberFields(collection, components);
  const axis = axisFields(collection, components);
  const splits = splitFields(collection);
  const has = kindHas(o.chart);
  const sections = [...new Set(CHART_KINDS.map((k) => k.section))];
  const first = o.series[0] ?? newSeries();
  const xField = o.x.field ? collection.fields.find((f) => f.id === o.x.field) : undefined;
  const styles = o.series.map((s) => styleOf(s, o.chart));
  const rightUsed = o.series.some((s) => s.axis === "right");
  const compact = has.xy && o.compact;
  // "This item" only for the page's own collection (kept on show when set, so it can be switched back).
  const offerScope = place === "item" && (pageCollectionId === collection.id || o.scope === "page");

  const check = (key: "points" | "compact" | "donut" | "fullCircle" | "asValue" | "horizontal", label: string, disabled?: string | false) => (
    <Checkbox id={`${uid}-${key}`} labelText={label} checked={o[key]} disabled={!!disabled} helperText={disabled || undefined} onChange={(_, { checked }) => set({ [key]: checked })} />
  );
  const aggregateSelect = (id: string, label: string, value: Aggregate, onAggregate: (a: Aggregate) => void, noCount = false, hideLabel = false) => (
    <Select size="sm" id={id} labelText={label} hideLabel={hideLabel} value={value} onChange={(e) => onAggregate(e.target.value as Aggregate)}>
      {AGGREGATES.filter((a) => !noCount || a.value !== "count").map((a) => (
        <SelectItem key={a.value} value={a.value} text={a.text} />
      ))}
    </Select>
  );
  /** A number field's id the series don't use yet (a new series measures it), or null. */
  const unusedNumber = () => numbers.find((f) => !o.series.some((s) => s.field === f.id))?.id ?? null;

  // --- Data: what is charted (the X axis's categories, a spread field, a scatter's fields)
  const xDisabled = has.parts && o.parts !== "groups" ? "Only when the parts are groups" : false;
  const fieldMode = o.x.by === "field" ? false : "Only by a field's values";
  const xControls = has.x && (
    <>
      <Select
        size="sm"
        id={`${uid}-x-by`}
        labelText={X_LABEL[o.chart] ?? "X axis"}
        value={o.x.by}
        disabled={!!xDisabled}
        helperText={xDisabled || undefined}
        // The field carries over where it fits the new mode (a date is both groupable and an axis field).
        onChange={(e) => {
          const by = e.target.value as XBy;
          const fits = (by === "field" ? splits : by === "item" ? axis : []).some((f) => f.id === o.x.field);
          setX({ by, field: fits ? o.x.field : by === "field" ? (splits[0]?.id ?? null) : null });
        }}
      >
        {X_BY.map((b) => (
          // A box plot has a box per category: each item alone isn't one.
          <SelectItem key={b.value} value={b.value} text={b.text} disabled={o.chart === "boxplot" && b.value === "item"} />
        ))}
      </Select>
      <FieldSelect
        id={`${uid}-x-field`}
        label="Field"
        fields={o.x.by === "item" ? axis : splits}
        value={o.x.by === "none" ? null : o.x.field}
        none={o.x.by === "item" ? "None (by title, in the block's order)" : o.x.by === "none" ? "None" : undefined}
        disabled={!!xDisabled || o.x.by === "none"}
        helper={!xDisabled && o.x.by === "none" ? "All items are one category" : o.x.by === "item" && !xDisabled ? "A date or number each item is placed at" : undefined}
        onChange={(field) => setX({ field })}
      />
      <Select size="sm" id={`${uid}-x-order`} labelText="Order" value={o.x.order} disabled={!!xDisabled || !!fieldMode} helperText={xDisabled ? undefined : fieldMode || undefined} onChange={(e) => setX({ order: e.target.value as GroupOrder })}>
        {ORDERS.map((r) => (
          <SelectItem key={r.value} value={r.value} text={r.text} />
        ))}
      </Select>
      <Select
        size="sm"
        id={`${uid}-x-dates`}
        labelText="Date steps"
        value={o.x.dateStep}
        disabled={!!xDisabled || !!fieldMode || !isDate(xField)}
        helperText={xDisabled || fieldMode ? undefined : !isDate(xField) ? "Only for a date field" : undefined}
        onChange={(e) => setX({ dateStep: e.target.value as DateStep })}
      >
        {DATE_STEPS.map((d) => (
          <SelectItem key={d.value} value={d.value} text={d.text} />
        ))}
      </Select>
      <Select size="sm" id={`${uid}-x-top`} labelText="Show" value={String(o.x.top)} disabled={!!xDisabled || !!fieldMode} onChange={(e) => setX({ top: Number(e.target.value) })}>
        {TOPS.map((n) => (
          <SelectItem key={n} value={String(n)} text={n === 0 ? "All categories" : `The largest ${n}, the rest as Other`} />
        ))}
      </Select>
      <Checkbox id={`${uid}-x-empty`} labelText="Show items without a value" checked={o.x.showEmpty} disabled={!!xDisabled || !!fieldMode} onChange={(_, { checked }) => setX({ showEmpty: checked })} />
    </>
  );
  const splitSelect = (label: string) => <FieldSelect id={`${uid}-split`} label={label} fields={splits} value={o.splitBy} none="Not split" onChange={(splitBy) => set({ splitBy })} />;
  const data = (
    <>
      {offerScope && (
        <Select size="sm" id={`${uid}-scope`} labelText="Of" value={o.scope} onChange={(e) => set({ scope: e.target.value as ChartOptions["scope"] })}>
          <SelectItem value="items" text="These items" />
          <SelectItem value="page" text="This item" />
        </Select>
      )}
      {has.parts && (
        <Select size="sm" id={`${uid}-parts`} labelText="Parts from" value={o.parts} onChange={(e) => set({ parts: e.target.value as ChartOptions["parts"] })}>
          <SelectItem value="groups" text="Categories (below)" />
          <SelectItem value="fields" text="Number fields" />
          <SelectItem value="one" text="One value (against its total)" />
        </Select>
      )}
      {xControls}
      {has.parts && (
        <MultiSelect<FieldDef>
          autoAlign
          size="sm"
          id={`${uid}-part-fields`}
          titleText="Number fields"
          label={o.fields.length ? numbers.filter((f) => o.fields.includes(f.id)).map((f) => f.name).join(", ") : "Choose number fields"}
          helperText={o.parts === "fields" ? undefined : "Only when the parts are number fields"}
          disabled={o.parts !== "fields"}
          items={numbers}
          itemToString={(f) => f?.name ?? ""}
          selectedItems={numbers.filter((f) => o.fields.includes(f.id))}
          onChange={({ selectedItems }) => set({ fields: (selectedItems ?? []).map((f) => f.id) })}
        />
      )}
      {has.spread && <FieldSelect id={`${uid}-spread`} label="Field" fields={axis} value={o.spreadField} helper="The number or date whose values are spread" onChange={(spreadField) => set({ spreadField })} />}
      {o.chart === "histogram" && splitSelect("Split by")}
      {o.chart === "heatmap" && splitSelect("Rows (Split by)")}
      {o.chart === "scatter" && (
        <>
          <FieldSelect id={`${uid}-scatter-x`} label="X" fields={axis} value={o.x.field} onChange={(field) => setX({ by: "item", field })} />
          <FieldSelect id={`${uid}-size`} label="Size (bubbles)" fields={numbers} value={o.sizeField} none="Same size" onChange={(sizeField) => set({ sizeField })} />
          {splitSelect("Colour by (Split by)")}
        </>
      )}
    </>
  );
  const hasData = offerScope || has.parts || has.x || has.spread || o.chart === "histogram" || o.chart === "heatmap" || o.chart === "scatter";

  // --- Series: bar / line / area (every series' settings), scatter (each a Y field)
  const seriesRows = o.series.map((s, i) => {
    const sid = `${uid}-series-${s.id}`;
    const head = <RowHead title={seriesLabel(s, collection, o.x)} index={i} count={o.series.length} noun={o.chart === "scatter" ? "Y field" : "series"} onMove={(by) => moveSeries(i, by)} onRemove={() => set({ series: o.series.filter((x) => x.id !== s.id) })} />;
    if (o.chart === "scatter")
      return (
        <div key={s.id} className="chart-options__series">
          {head}
          <FieldSelect id={`${sid}-field`} label="Y" fields={numbers} value={s.field} onChange={(field) => setSeries(s.id, { field, value: s.value === "count" ? "sum" : s.value })} />
          <TextInput size="sm" id={`${sid}-label`} labelText="Label" placeholder={seriesLabel({ ...s, label: "" }, collection, o.x)} value={s.label} onChange={(e) => setSeries(s.id, { label: e.target.value })} />
        </div>
      );
    return (
      <div key={s.id} className="chart-options__series">
        {head}
        {aggregateSelect(`${sid}-value`, "Value", s.value, (value) => setSeries(s.id, { value, ...(value !== "count" && !s.field && { field: numbers[0]?.id ?? null }) }))}
        <FieldSelect id={`${sid}-field`} label="Of" fields={numbers} value={s.value === "count" ? null : s.field} none={s.value === "count" ? "—" : undefined} disabled={s.value === "count"} helper={s.value === "count" ? "Not for a count" : undefined} onChange={(field) => setSeries(s.id, { field })} />
        <TextInput size="sm" id={`${sid}-label`} labelText="Label" placeholder={seriesLabel({ ...s, label: "" }, collection, o.x)} value={s.label} onChange={(e) => setSeries(s.id, { label: e.target.value })} />
        <div className="chart-options__pair">
          <Select size="sm" id={`${sid}-style`} labelText="Draw as" value={styleOf(s, o.chart)} onChange={(e) => setSeries(s.id, { style: chartsStyle(s, e.target.value as SeriesStyle, o.chart) })}>
            {SERIES_STYLES.map((x) => (
              <SelectItem key={x.value} value={x.value} text={x.text} />
            ))}
          </Select>
          <Select size="sm" id={`${sid}-axis`} labelText="Axis" value={s.axis} onChange={(e) => setSeries(s.id, { axis: e.target.value as ChartSeries["axis"] })}>
            <SelectItem value="left" text="Left" />
            <SelectItem value="right" text="Right" />
          </Select>
        </div>
        <Select size="sm" id={`${sid}-transform`} labelText="Show" value={s.transform} onChange={(e) => setSeries(s.id, { transform: e.target.value as Transform })}>
          {TRANSFORMS.map((t) => (
            <SelectItem key={t.value} value={t.value} text={t.text} />
          ))}
        </Select>
        <NumberField
          id={`${sid}-window`}
          label="Steps averaged"
          value={s.window}
          disabled={s.transform !== "moving"}
          helper={s.transform === "moving" ? `${MOVING_WINDOW.min} to ${MOVING_WINDOW.max}` : "Only for a moving average"}
          onChange={(n) => n !== null && setSeries(s.id, { window: Math.max(MOVING_WINDOW.min, Math.min(MOVING_WINDOW.max, Math.round(n))) })}
        />
      </div>
    );
  });
  const seriesSection = has.seriesList && (
    <Section key="series" title={o.chart === "scatter" ? "Y" : "Series"}>
      {seriesRows}
      <Button
        kind="tertiary"
        size="sm"
        renderIcon={Add}
        className="chart-options__add"
        onClick={() => {
          const field = unusedNumber() ?? (o.chart === "scatter" ? (numbers[0]?.id ?? null) : null);
          set({ series: [...o.series, field ? newSeries({ value: "sum", field }) : newSeries()] });
        }}
      >
        {o.chart === "scatter" ? "Add Y field" : "Add series"}
      </Button>
      {has.xy && splitSelect("Split by")}
    </Section>
  );

  // --- One value (the first series): parts, gauge, heatmap; radar's spokes
  const setFirst = (patch: Partial<ChartSeries>) => set({ series: o.series.length ? o.series.map((s, i) => (i === 0 ? { ...s, ...patch } : s)) : [{ ...first, ...patch }] });
  const fieldsParts = has.parts && o.parts === "fields";
  const valueSection = has.value && (
    <Section key="value" title="Value">
      {aggregateSelect(`${uid}-value`, "Value", first.value, (value) =>
        set({
          series: (o.series.length ? o.series : [first]).map((s, i) => (i === 0 ? { ...s, value, ...(value !== "count" && !s.field && { field: numbers[0]?.id ?? null }) } : s)),
          // "Previous value" compares with the value before the last: only for the last value.
          ...(value !== "last" && o.compare === "prev" && { compare: null }),
        }),
      )}
      <FieldSelect
        id={`${uid}-value-field`}
        label="Of"
        fields={numbers}
        value={first.value === "count" || fieldsParts ? null : first.field}
        none={first.value === "count" || fieldsParts ? "—" : undefined}
        disabled={first.value === "count" || fieldsParts}
        helper={fieldsParts ? "Each part is a number field" : first.value === "count" ? "Not for a count" : undefined}
        onChange={(field) => setFirst({ field })}
      />
      <TextInput size="sm" id={`${uid}-value-label`} labelText="Label" placeholder={seriesLabel({ ...first, label: "" }, collection)} value={first.label} onChange={(e) => setFirst({ label: e.target.value })} />
    </Section>
  );
  const spokesSection = o.chart === "radar" && (
    <Section key="spokes" title="Spokes">
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
      {/* A spoke is a number field made into one per shape: a count of items isn't one. */}
      {aggregateSelect(`${uid}-spoke-value`, "Value", first.value === "count" ? "avg" : first.value, (value) => setFirst({ value }), true)}
    </Section>
  );

  // --- Total (parts, gauge)
  const totalValue = o.total.from === "field" ? (o.total.field ?? TOTAL_NONE) : o.total.from === "number" ? TOTAL_NUMBER : TOTAL_NONE;
  const totalSection = has.total && (
    <Section key="total" title="Total">
      <Select
        size="sm"
        id={`${uid}-total`}
        labelText="Measured against"
        value={totalValue}
        onChange={(e) => {
          const v = e.target.value;
          set({ total: v === TOTAL_NONE ? { ...o.total, from: "none" } : v === TOTAL_NUMBER ? { ...o.total, from: "number", number: o.total.number ?? 100 } : { ...o.total, from: "field", field: v } });
        }}
      >
        <SelectItem value={TOTAL_NONE} text={o.chart === "gauge" ? "100 (the value is a %)" : "The sum of the parts"} />
        <SelectItem value={TOTAL_NUMBER} text="A number" />
        <SelectItemGroup label="A field">
          {numbers.map((f) => (
            <SelectItem key={f.id} value={f.id} text={f.name} />
          ))}
        </SelectItemGroup>
      </Select>
      <NumberField
        id={`${uid}-total-number`}
        label="Number"
        value={o.total.number}
        disabled={o.total.from !== "number"}
        helper={o.total.from === "number" ? (o.chart === "gauge" ? undefined : "The rest is shown as Remaining") : "Only against a number"}
        onChange={(number) => set({ total: { ...o.total, number } })}
      />
    </Section>
  );

  // --- Display
  const bars = styles.some((s) => s === "bar" || s === "lollipop" || s === "area");
  const lines = styles.some((s) => s === "line" || s === "area");
  const across = o.series.every((s, i) => (styles[i] === "bar" || styles[i] === "lollipop") && s.axis === "left");
  const displaySection = has.display && (
    <Section key="display" title="Display">
      {has.xy && (
        <>
          <Select size="sm" id={`${uid}-stack`} labelText="Bars and areas" value={o.stack} disabled={!bars} helperText={bars ? undefined : "Only for bars and areas"} onChange={(e) => set({ stack: e.target.value as ChartOptions["stack"] })}>
            <SelectItem value="none" text="Side by side" />
            <SelectItem value="stacked" text="Stacked" />
            <SelectItem value="percent" text="Stacked as shares of 100%" />
          </Select>
          {check("horizontal", "Horizontal", !across && "Only when every series is bars or lollipops on the left axis")}
          <Select size="sm" id={`${uid}-curve`} labelText="Lines" value={o.curve} disabled={!lines} helperText={lines ? undefined : "Only for lines and areas"} onChange={(e) => set({ curve: e.target.value as ChartOptions["curve"] })}>
            <SelectItem value="smooth" text="Smooth" />
            <SelectItem value="straight" text="Straight" />
            <SelectItem value="step" text="Steps" />
          </Select>
          {check("points", "A dot on each value", !lines && "Only for lines and areas")}
          <Select size="sm" id={`${uid}-missing`} labelText="Missing values" value={o.missing} onChange={(e) => set({ missing: e.target.value as ChartOptions["missing"] })}>
            <SelectItem value="skip" text="Left out (the line joins its neighbours)" />
            <SelectItem value="zero" text="Drawn as 0" />
          </Select>
          {check("compact", "Compact (a sparkline: no axes, legend or grid)")}
        </>
      )}
      {o.chart === "pie" && check("donut", "Donut (the total in the middle)")}
      {o.chart === "gauge" && (
        <>
          {check("fullCircle", "Full circle")}
          {check("asValue", "Show the value, not a %", o.total.from === "none" && "Only against a total")}
          <Select size="sm" id={`${uid}-compare`} labelText="Compare with" value={o.compare ?? ""} onChange={(e) => set({ compare: (e.target.value || null) as Compare | null })}>
            <SelectItem value="" text="Nothing" />
            {[...AGGREGATES, ...(first.value === "last" ? [PREVIOUS] : [])].map((a) => (
              <SelectItem key={a.value} value={a.value} text={a.text} />
            ))}
          </Select>
          <FieldSelect
            id={`${uid}-compare-field`}
            label="Compared of"
            fields={numbers}
            value={o.compareField}
            none="The value's field"
            disabled={!o.compare || o.compare === "count"}
            helper={!o.compare ? "Only when compared" : o.compare === "count" ? "Not for a count" : undefined}
            onChange={(compareField) => set({ compareField })}
          />
        </>
      )}
      {o.chart === "histogram" && (
        <Select size="sm" id={`${uid}-bins`} labelText="Bins" value={String(o.bins)} onChange={(e) => set({ bins: Number(e.target.value) })}>
          {BINS.map((n) => (
            <SelectItem key={n} value={String(n)} text={n === 0 ? "Automatic" : String(n)} />
          ))}
        </Select>
      )}
    </Section>
  );

  // --- Axes (the right one only while a series is measured on it)
  const noAxes = compact ? "Not on a compact chart" : undefined;
  const axisGroup = (side: "left" | "right", title: string) => {
    const a = o[side];
    const setAxis = (patch: Partial<ChartOptions["left"]>) => set({ [side]: { ...a, ...patch } });
    return (
      <div className="chart-options__group" key={side}>
        <h4 className="chart-options__subheading">{title}</h4>
        <TextInput size="sm" id={`${uid}-${side}-title`} labelText="Title" placeholder="From its series" disabled={compact} value={a.title} onChange={(e) => setAxis({ title: e.target.value })} />
        <div className="chart-options__pair">
          <NumberField id={`${uid}-${side}-min`} label="Min" value={a.min} disabled={compact} onChange={(min) => setAxis({ min })} />
          <NumberField id={`${uid}-${side}-max`} label="Max" value={a.max} disabled={compact} onChange={(max) => setAxis({ max })} />
        </div>
        <Checkbox id={`${uid}-${side}-log`} labelText="Logarithmic" checked={a.log} disabled={compact} onChange={(_, { checked }) => setAxis({ log: checked })} />
      </div>
    );
  };
  const axesSection = has.axes && (
    <Section key="axes" title="Axes">
      <TextInput size="sm" id={`${uid}-x-title`} labelText="X axis title" placeholder={o.chart === "scatter" || has.x ? "The field's name" : ""} disabled={compact} helperText={noAxes} value={o.xTitle} onChange={(e) => set({ xTitle: e.target.value })} />
      {axisGroup("left", has.xy && rightUsed ? "Left axis" : "Value axis")}
      {has.xy && rightUsed && axisGroup("right", "Right axis")}
    </Section>
  );

  // --- Thresholds
  const thresholdsSection = has.thresholds && (
    <Section key="thresholds" title="Thresholds">
      {has.xy ? (
        <p className="helper chart-options__note">Lines on the left axis, from the value up.</p>
      ) : (
        <Select size="sm" id={`${uid}-threshold-mode`} labelText="Thresholds are" value={o.thresholdMode} onChange={(e) => set({ thresholdMode: e.target.value as ChartOptions["thresholdMode"] })}>
          <SelectItem value="percent" text="A % of the total" />
          <SelectItem value="absolute" text="Values" />
        </Select>
      )}
      {o.thresholds.map((t, i) => (
        <div key={i} className="chart-options__threshold">
          <NumberField
            id={`${uid}-threshold-${i}`}
            label={`Threshold ${i + 1}`}
            hideLabel
            value={t.value}
            // Emptied while typing: the threshold keeps its value until a number is typed.
            onChange={(value) => value !== null && set({ thresholds: o.thresholds.map((x, j) => (j === i ? { ...x, value } : x)) })}
          />
          <Select size="sm" id={`${uid}-threshold-${i}-status`} labelText={`Threshold ${i + 1} status`} hideLabel value={t.status} onChange={(e) => set({ thresholds: o.thresholds.map((x, j) => (j === i ? { ...x, status: e.target.value as ThresholdStatus } : x)) })}>
            {STATUSES.map((s) => (
              <SelectItem key={s.value} value={s.value} text={s.text} />
            ))}
          </Select>
          <IconButton autoAlign label="Remove threshold" kind="ghost" size="sm" align="left" onClick={() => set({ thresholds: o.thresholds.filter((_, j) => j !== i) })}>
            <TrashCan />
          </IconButton>
        </div>
      ))}
      <Button
        kind="tertiary"
        size="sm"
        renderIcon={Add}
        className="chart-options__add"
        // The first a warning, the next a danger above it.
        onClick={() => {
          const last = o.thresholds[o.thresholds.length - 1];
          const value = last ? last.value + (o.thresholdMode === "percent" && !has.xy ? 10 : 1) : !has.xy && o.thresholdMode === "percent" ? 80 : 0;
          set({ thresholds: [...o.thresholds, { value, status: last ? "danger" : "warning" }] });
        }}
      >
        Add threshold
      </Button>
    </Section>
  );

  // --- Values and legend
  const noLegend = compact ? "Not on a compact chart" : undefined;
  const valuesSection = (
    <Section key="values" title={has.legend ? "Values and legend" : "Values"}>
      <div className="chart-options__pair">
        <TextInput size="sm" id={`${uid}-unit`} labelText="Unit" placeholder="kg, €, h" value={o.unit} onChange={(e) => set({ unit: e.target.value })} />
        <Select size="sm" id={`${uid}-decimals`} labelText="Decimals" value={o.decimals === null ? "" : String(o.decimals)} onChange={(e) => set({ decimals: e.target.value === "" ? null : Number(e.target.value) })}>
          <SelectItem value="" text="As they are" />
          {Array.from({ length: MAX_DECIMALS + 1 }, (_, n) => (
            <SelectItem key={n} value={String(n)} text={String(n)} />
          ))}
        </Select>
      </div>
      {has.legend && (
        <>
          <Select size="sm" id={`${uid}-legend`} labelText="Legend" value={o.legend} disabled={compact} helperText={noLegend} onChange={(e) => set({ legend: e.target.value as ChartOptions["legend"] })}>
            <SelectItem value="auto" text="With more than one series or part" />
            <SelectItem value="show" text="Shown" />
            <SelectItem value="hide" text="Hidden" />
          </Select>
          <Select
            size="sm"
            id={`${uid}-legend-position`}
            labelText="Legend position"
            value={o.legendPosition}
            disabled={compact || o.legend === "hide"}
            helperText={!compact && o.legend === "hide" ? "The legend is hidden" : undefined}
            onChange={(e) => set({ legendPosition: e.target.value as ChartOptions["legendPosition"] })}
          >
            <SelectItem value="bottom" text="Bottom" />
            <SelectItem value="top" text="Top" />
            <SelectItem value="left" text="Left" />
            <SelectItem value="right" text="Right" />
          </Select>
        </>
      )}
    </Section>
  );

  // --- Size
  const sizeSection = (
    <Section key="size" title="Size">
      {has.height && (
        <>
          <HeightSlider id={`${uid}-height`} value={o.height} disabled={compact} onChange={(height) => set({ height })} />
          {compact && <p className="helper chart-options__note">A compact chart has its own, low height.</p>}
        </>
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
    </Section>
  );

  return (
    <div className="view-options chart-options">
      <Select size="sm" id={`${uid}-chart`} labelText="Chart" value={o.chart} onChange={(e) => update(switchKind(o, e.target.value as ChartKind, axis))}>
        {sections.map((s) => (
          <SelectItemGroup key={s} label={s}>
            {CHART_KINDS.filter((k) => k.section === s).map((k) => (
              <SelectItem key={k.kind} value={k.kind} text={k.label} />
            ))}
          </SelectItemGroup>
        ))}
      </Select>
      {/* Keyed sections keep their open / closed state when the kind changes. */}
      <Accordion size="sm" className="chart-options__sections">
        {hasData && (
          <Section key="data" title="Data">
            {data}
          </Section>
        )}
        {seriesSection}
        {spokesSection}
        {valueSection}
        {totalSection}
        {displaySection}
        {axesSection}
        {thresholdsSection}
        {valuesSection}
        {sizeSection}
      </Accordion>
    </div>
  );
}

export const chartBlock = defineBlockType<ChartOptions>({
  kind: "chart",
  label: "Chart",
  icon: ChartColumn,
  defaultOptions: (collection: Collection) => defaultChartOptions(collection),
  normalizeOptions: (raw, collection) => normalizeChartOptions(raw, collection),
  // Its X axis is its own setting (not the block's grouping); "This item" charts the page's item, not a query's.
  uses: (options) => ({ query: options.scope !== "page", all: true, groups: false, fields: null }),
  View: ChartView,
  OptionsEditor: ChartOptionsEditor,
});
