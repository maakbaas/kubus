import { useId, useState } from "react";
import { ContentSwitcher, DatePicker, DatePickerInput, IconButton, Select, SelectItem, Switch } from "@carbon/react";
import { Calendar, ChevronLeft, ChevronRight, Close } from "@carbon/icons-react";
import { formatDate } from "../domain/fieldKinds";
import { newId, type Collection } from "../domain/model";
import type { FilterRule } from "../domain/query";
import {
  dateFields,
  defaultDateField,
  parseRolling,
  periodAround,
  periodKind,
  periodLabel,
  periodRule,
  rangeValue,
  resolveRange,
  rollingLabel,
  rollingValue,
  shiftPeriod,
  type Period,
  type PeriodKind,
} from "../domain/datePeriod";

const KINDS: { kind: PeriodKind; text: string; current: string }[] = [
  { kind: "day", text: "Day", current: "Today" },
  { kind: "week", text: "Week", current: "This week" },
  { kind: "month", text: "Month", current: "This month" },
  { kind: "year", text: "Year", current: "This year" },
  { kind: "range", text: "Range", current: "" },
];

/**
 * The top of a filter: which day, week, month, year or range the items' date falls in, in as few
 * clicks as there can be (one for this week, then one per week back or on). It goes by the first
 * date or date & time field (none: Updated), or another one picked beside it (Created, Updated
 * too), and is kept as the filter's one "between" rule (domain/datePeriod.ts), which the rule list
 * doesn't show. The current day, week, month or year is kept counted from today ("this week" stays
 * this week once saved); any other is kept as its days.
 */
export function DatePeriodFilter({ collection, filters, onChange }: { collection: Collection; filters: FilterRule[]; onChange(filters: FilterRule[]): void }) {
  const uid = useId();
  const fields = dateFields(collection);
  const rule = periodRule(filters);
  const today = formatDate(new Date());
  const rolling = rule ? parseRolling(rule.value) : null;
  const period = rule ? resolveRange(rule.value, today) : null;
  // The field and "Range" before a period is set (no rule yet), and "Range" for a period
  // that is also a whole month (say), so the switcher doesn't jump to "Month" while start and end are chosen.
  const [chosenField, setChosenField] = useState<string>();
  const [rangeChosen, setRangeChosen] = useState(false);
  const fieldId = rule?.fieldId ?? (fields.some((f) => f.id === chosenField) ? chosenField! : defaultDateField(collection));
  const kind: PeriodKind | null = rangeChosen ? "range" : rolling ? rolling.kind : period ? periodKind(period) : null;
  const spec = KINDS.find((k) => k.kind === kind);

  /** Stores a period: today's day, week, month or year as counted from today ("month+0"), any other as its days. */
  const write = (next: Period | null, nextKind = kind) => {
    if (!next) return onChange(filters.filter((r) => r !== rule));
    const current = nextKind && nextKind !== "range" && rangeValue(periodAround(nextKind, today)) === rangeValue(next);
    const value = current ? rollingValue({ kind: nextKind, offset: 0 }) : rangeValue(next);
    const written: FilterRule = { id: rule?.id ?? newId(), fieldId, operator: "between", value };
    onChange(rule ? filters.map((r) => (r === rule ? written : r)) : [written, ...filters]);
  };
  const pick = (next: PeriodKind) => {
    setRangeChosen(next === "range");
    // A range starts as the period shown (its two days to change; fixed days, never rolling); the
    // others around today, or around the period shown when that isn't now (a month of last year →
    // that week).
    if (next === "range") return period && rolling && write(period, "range");
    const showsToday = period && period.start <= today && today <= period.end;
    write(periodAround(next, period && !showsToday ? period.start : today), next);
  };
  const label = !period || !kind ? (kind === "range" ? "Choose the first and last day" : "Any date") : rolling ? `${rollingLabel(rolling)} · ${periodLabel(period, kind)}` : periodLabel(period, kind);

  return (
    <div className="date-period">
      <div className="date-period__kinds">
        <ContentSwitcher
          size="sm"
          selectedIndex={KINDS.findIndex((k) => k.kind === kind)}
          onChange={({ index }) => index !== undefined && pick(KINDS[index].kind)}
        >
          {KINDS.map((k) => (
            <Switch key={k.kind} name={k.kind} text={k.text} />
          ))}
        </ContentSwitcher>
        <Select
          id={`${uid}-date-field`}
          labelText="Date field"
          hideLabel
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
      </div>
      <div className="date-period__nav">
        <span className="date-period__label">{label}</span>
        <IconButton autoAlign label="Previous" kind="ghost" size="sm" disabled={!period || !kind} onClick={() => period && kind && write(shiftPeriod(period, kind, -1))}>
          <ChevronLeft />
        </IconButton>
        <IconButton autoAlign label="Next" kind="ghost" size="sm" disabled={!period || !kind} onClick={() => period && kind && write(shiftPeriod(period, kind, 1))}>
          <ChevronRight />
        </IconButton>
        <IconButton
          autoAlign
          label={spec?.current || "Today"}
          kind="ghost"
          size="sm"
          disabled={!kind || kind === "range"}
          onClick={() => kind && kind !== "range" && write(periodAround(kind, today))}
        >
          <Calendar />
        </IconButton>
        <IconButton
          autoAlign
          label="Any date"
          kind="ghost"
          size="sm"
          align="left"
          disabled={!rule && !rangeChosen}
          onClick={() => {
            setRangeChosen(false);
            write(null);
          }}
        >
          <Close />
        </IconButton>
      </div>
      {kind === "range" && (
        <DatePicker
          className="date-period__range"
          datePickerType="range"
          dateFormat="Y-m-d"
          value={period ? [period.start, period.end] : undefined}
          onChange={(dates) => {
            const [start, end] = dates;
            if (start && end) write({ start: formatDate(start), end: formatDate(end) }, "range");
          }}
        >
          <DatePickerInput id={`${uid}-date-start`} size="sm" labelText="First day" placeholder="yyyy-mm-dd" />
          <DatePickerInput id={`${uid}-date-end`} size="sm" labelText="Last day" placeholder="yyyy-mm-dd" />
        </DatePicker>
      )}
    </div>
  );
}
