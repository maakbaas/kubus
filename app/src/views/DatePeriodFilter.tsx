import { useId, useState } from "react";
import { ContentSwitcher, DatePicker, DatePickerInput, IconButton, NumberInput, Select, SelectItem, Switch, Tag } from "@carbon/react";
import { Calendar, ChevronLeft, ChevronRight, Close } from "@carbon/icons-react";
import { formatDate } from "../domain/fieldKinds";
import type { Collection } from "../domain/model";
import type { FilterRule } from "../domain/query";
import {
  dateFields,
  defaultDateField,
  kindValue,
  nowMinute,
  periodAround,
  periodRule,
  periodState,
  periodText,
  rangeValue,
  rollingLabel,
  splitAnchor,
  stepValue,
  toDateLabel,
  windowValue,
  withPeriod,
  type Period,
  type PeriodKind,
  type PeriodState,
  type Unit,
  type Window,
} from "../domain/datePeriod";

/** The kinds of period, as the filter panel's switcher names them (the filter bar's switch: all but Range). */
export const KINDS: { kind: PeriodKind; text: string }[] = [
  { kind: "hour", text: "Hour" },
  { kind: "day", text: "Day" },
  { kind: "week", text: "Week" },
  { kind: "month", text: "Month" },
  { kind: "year", text: "Year" },
  { kind: "range", text: "Range" },
];

/** Whether ‹ › step the period: one up to now (so far, the last n) has nothing before or after it, nor has one counted from a page's item. */
export const steps = (state: PeriodState | null, anchored: boolean): boolean => !!state && !anchored && !state.toDate && !state.last;

const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));
const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString(undefined, { month: "long" }));

/** The years to pick from: a century back up to this one (none in the future), and the year shown if outside. */
function yearsAround(shown: number, current: number): number[] {
  const first = Math.min(shown, current - 100);
  const last = Math.max(shown, current);
  return Array.from({ length: last - first + 1 }, (_, i) => last - i);
}

/** The window choices of a kind ("Last n minutes" only for an hour, "… to date" not for an hour or a day). */
function windows(kind: Unit): { value: Window; text: string }[] {
  return [
    { value: "current", text: kind === "hour" ? "Counted from now" : "Counted from today" },
    ...(kind === "week" || kind === "month" || kind === "year" ? [{ value: "toDate" as const, text: toDateLabel(kind) }] : []),
    { value: "last", text: `Last n ${kind}s` },
    ...(kind === "hour" ? [{ value: "lastMinutes" as const, text: "Last n minutes" }] : []),
    { value: "fixed", text: `A chosen ${kind}` },
  ];
}

/**
 * The top of a filter: which hour, day, week, month, year or range the items' date falls in, in as
 * few clicks as there can be. It goes by the first date or date & time field (none: Updated), or
 * another one picked on its line (Created, Updated too), and is kept as the filter's one "between"
 * rule (domain/datePeriod.ts), which the rule list doesn't show. A kind's Window says which one: counted
 * from now (this week, and ‹ › to last week, still counted from today once saved), so far (year to
 * date), the last n up to now (the last 7 days, the last 12 months), or a chosen one (its days, fixed);
 * a rolling one is tagged so. A range is two chosen days. On an item page (`page`, its collection) a
 * rolling one can be counted from the page's item's date instead ("Counted from": the last 7 days up to
 * this measurement's date; `anchoredValue`), worked out for each page's item.
 */
export function DatePeriodFilter({ collection, filters, page, onChange }: { collection: Collection; filters: FilterRule[]; page?: Collection; onChange(filters: FilterRule[]): void }) {
  const uid = useId();
  const fields = dateFields(collection);
  const rule = periodRule(filters);
  const now = nowMinute();
  const today = now.slice(0, 10);
  const { value, fieldId: anchor } = rule ? splitAnchor(rule.value) : { value: "", fieldId: null };
  const state = rule ? periodState(value, now) : null;
  const { last, counted } = state ?? { last: null, counted: false };
  // The page's item's dates a period can be counted from; the one it is.
  const pageDates = page ? page.fields.filter((f) => f.kind === "date" || f.kind === "datetime") : [];
  const anchorField = anchor ? pageDates.find((f) => f.id === anchor) : undefined;
  const period = state?.period ?? null;
  // The field and "Range" before a period is set (no rule yet), and "Range" for a period
  // that is also a whole month (say), so the switcher doesn't jump to "Month" while start and end are chosen.
  const [chosenField, setChosenField] = useState<string>();
  const [rangeChosen, setRangeChosen] = useState(false);
  const fieldId = rule?.fieldId ?? (fields.some((f) => f.id === chosenField) ? chosenField! : defaultDateField(collection));
  const kind: PeriodKind | null = rangeChosen ? "range" : (state?.kind ?? null);
  const window: Window | null = kind === "range" ? null : (state?.window ?? null);

  // Counted from the page's item's date stays so while the period is counted from a day (a fixed one has its days).
  const store = (next: string, from = anchor) => onChange(withPeriod(filters, fieldId, next, from));
  const clear = () => {
    setRangeChosen(false);
    onChange(filters.filter((r) => r !== rule));
  };
  const fixed = (p: Period) => store(rangeValue(p));
  /** A window of a kind: the current one, so far, the last n (`n`, else the unit's own), or the chosen one around `at`. */
  const choose = (next: Unit, w: Window, at = period?.start ?? now, n?: number) => store(windowValue(next, w, at, n));
  const pick = (next: PeriodKind) => {
    setRangeChosen(next === "range");
    // A range starts as the days shown (to change).
    if (next === "range") return period && fixed({ start: period.start.slice(0, 10), end: period.end.slice(0, 10) });
    // The same window in the other kind (see kindValue).
    store(kindValue(rule && !rangeChosen ? value : null, next, now));
  };
  const step = (direction: 1 | -1) => {
    const next = rule && stepValue(value, direction, now, kind ?? undefined);
    if (next) store(next);
  };

  const label = !state || !kind
    ? kind === "range"
      ? "Choose the first and last day"
      : "Any date"
    : anchor
      ? `${state.counting} - counted from this ${page?.name ?? "item"}'s ${anchorField?.name ?? "date"}`
      : periodText(state, kind);
  const unit = kind && kind !== "range" ? kind : null;

  return (
    <div className="date-period">
      <ContentSwitcher size="sm" selectedIndex={KINDS.findIndex((k) => k.kind === kind)} onChange={({ index }) => index !== undefined && pick(KINDS[index].kind)}>
        {KINDS.map((k) => (
          <Switch key={k.kind} name={k.kind} text={k.text} />
        ))}
      </ContentSwitcher>
      <div className="date-period__nav">
        <span className="date-period__label" title={label}>
          {label}
        </span>
        {/* Moves on with time (this week, the last 7 days, year to date), unlike chosen days. */}
        {period && counted && (
          <Tag size="sm" type="blue" className="date-period__rolling">
            Rolling
          </Tag>
        )}
        <Select
          id={`${uid}-date-field`}
          className="date-period__field"
          labelText="by"
          inline
          size="sm"
          value={fieldId}
          onChange={(e) => {
            setChosenField(e.target.value);
            if (rule) onChange(filters.map((r) => (r === rule ? { ...r, fieldId: e.target.value } : r)));
          }}
        >
          {fields.map((f) => (
            <SelectItem key={f.id} value={f.id} text={f.name} />
          ))}
        </Select>
        {(rule || rangeChosen) && (
          <>
            <IconButton autoAlign label="Previous" kind="ghost" size="sm" disabled={!steps(state, !!anchor)} onClick={() => step(-1)}>
              <ChevronLeft />
            </IconButton>
            <IconButton autoAlign label="Next" kind="ghost" size="sm" disabled={!steps(state, !!anchor)} onClick={() => step(1)}>
              <ChevronRight />
            </IconButton>
            <IconButton
              autoAlign
              label={unit ? rollingLabel({ kind: unit, offset: 0 }) : "Now"}
              kind="ghost"
              size="sm"
              disabled={!unit}
              onClick={() => unit && (window === "fixed" ? fixed(periodAround(unit, now)) : choose(unit, "current"))}
            >
              <Calendar />
            </IconButton>
            <IconButton autoAlign label="Any date" kind="ghost" size="sm" align="left" onClick={clear}>
              <Close />
            </IconButton>
          </>
        )}
      </div>
      {unit && window && period && (
        <div className="date-period__pick">
          <Select id={`${uid}-date-window`} labelText="Which" size="sm" value={window} onChange={(e) => choose(unit, e.target.value as Window, window === "fixed" ? period.start : now)}>
            {windows(unit).map((w) => (
              <SelectItem key={w.value} value={w.value} text={w.text} />
            ))}
          </Select>
          {(window === "last" || window === "lastMinutes") && last && (
            <NumberInput
              id={`${uid}-date-last`}
              label={window === "lastMinutes" ? "Minutes" : `${unit[0].toUpperCase()}${unit.slice(1)}s`}
              size="sm"
              min={1}
              hideSteppers
              allowEmpty
              value={1 - last.from}
              onChange={(_, { value: n }) => {
                const count = Number(n);
                if (Number.isInteger(count) && count >= 1) choose(unit, window, now, count);
              }}
            />
          )}
          {window === "fixed" && (unit === "hour" || unit === "day" || unit === "week") && (
            <DatePicker
              datePickerType="single"
              dateFormat="Y-m-d"
              value={period.start.slice(0, 10)}
              // An hour keeps its time on another day.
              onChange={([day]) => day && fixed(periodAround(unit, unit === "hour" ? `${formatDate(day)}${period.start.slice(10)}` : formatDate(day)))}
            >
              <DatePickerInput id={`${uid}-date-day`} size="sm" labelText={unit === "week" ? "A day of the week" : "Day"} placeholder="yyyy-mm-dd" />
            </DatePicker>
          )}
          {window === "fixed" && unit === "hour" && (
            <Select id={`${uid}-date-hour`} labelText="Hour" size="sm" value={period.start.slice(11, 13)} onChange={(e) => fixed(periodAround("hour", `${period.start.slice(0, 10)}T${e.target.value}:00`))}>
              {HOURS.map((h) => (
                <SelectItem key={h} value={h} text={`${h}:00`} />
              ))}
            </Select>
          )}
          {window === "fixed" && unit === "month" && (
            <Select
              id={`${uid}-date-month`}
              labelText="Month"
              size="sm"
              value={Number(period.start.slice(5, 7))}
              onChange={(e) => fixed(periodAround("month", `${period.start.slice(0, 4)}-${e.target.value.padStart(2, "0")}-01`))}
            >
              {MONTHS.map((name, i) => (
                <SelectItem key={name} value={i + 1} text={name} />
              ))}
            </Select>
          )}
          {window === "fixed" && (unit === "month" || unit === "year") && (
            <Select id={`${uid}-date-year`} labelText="Year" size="sm" value={Number(period.start.slice(0, 4))} onChange={(e) => fixed(periodAround(unit, `${e.target.value}${period.start.slice(4, 10)}`))}>
              {yearsAround(Number(period.start.slice(0, 4)), Number(today.slice(0, 4))).map((y) => (
                <SelectItem key={y} value={y} text={String(y)} />
              ))}
            </Select>
          )}
        </div>
      )}
      {pageDates.length > 0 && counted && (
        <Select id={`${uid}-date-from`} labelText="Counted from" size="sm" value={anchor ?? ""} onChange={(e) => store(value, e.target.value || null)}>
          <SelectItem value="" text="Today" />
          {pageDates.map((f) => (
            <SelectItem key={f.id} value={f.id} text={`This ${page!.name}'s ${f.name}`} />
          ))}
        </Select>
      )}
      {kind === "range" && (
        <DatePicker
          className="date-period__range"
          datePickerType="range"
          dateFormat="Y-m-d"
          value={period ? [period.start.slice(0, 10), period.end.slice(0, 10)] : undefined}
          onChange={(dates) => {
            const [start, end] = dates;
            if (start && end) fixed({ start: formatDate(start), end: formatDate(end) });
          }}
        >
          <DatePickerInput id={`${uid}-date-start`} size="sm" labelText="First day" placeholder="yyyy-mm-dd" />
          <DatePickerInput id={`${uid}-date-end`} size="sm" labelText="Last day" placeholder="yyyy-mm-dd" />
        </DatePicker>
      )}
    </div>
  );
}
