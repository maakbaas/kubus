import { useId, useState } from "react";
import { Checkbox, ContentSwitcher, DatePicker, DatePickerInput, IconButton, NumberInput, Select, SelectItem, Switch } from "@carbon/react";
import { Calendar, ChevronLeft, ChevronRight, Close } from "@carbon/icons-react";
import { formatDate } from "../domain/fieldKinds";
import { newId, type Collection } from "../domain/model";
import type { FilterRule } from "../domain/query";
import {
  anchoredValue,
  dateFields,
  defaultDateField,
  nowMinute,
  parseRolling,
  parseRollingRange,
  parseToDate,
  periodAround,
  periodKind,
  periodLabel,
  periodRule,
  RANGE_UNITS,
  rangeOrRolling,
  rangeValue,
  resolveRange,
  rollingLabel,
  rollingRangeLabel,
  rollingRangeValue,
  rollingValue,
  shiftPeriod,
  splitAnchor,
  toDateLabel,
  toDateValue,
  type Period,
  type PeriodKind,
  type RangeUnit,
} from "../domain/datePeriod";

const KINDS: { kind: PeriodKind; text: string; current: string }[] = [
  { kind: "hour", text: "Hour", current: "This hour" },
  { kind: "day", text: "Day", current: "Today" },
  { kind: "week", text: "Week", current: "This week" },
  { kind: "month", text: "Month", current: "This month" },
  { kind: "year", text: "Year", current: "This year" },
  { kind: "range", text: "Range", current: "" },
];

const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));
const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString(undefined, { month: "long" }));

/** The years to pick from: a century back up to this one (none in the future), and the year shown if outside. */
function yearsAround(shown: number, current: number): number[] {
  const first = Math.min(shown, current - 100);
  const last = Math.max(shown, current);
  return Array.from({ length: last - first + 1 }, (_, i) => last - i);
}

/**
 * The top of a filter: which day, week, month, year or range the items' date falls in, in as few
 * clicks as there can be (one for this week, then one per week back or on, or any other one picked
 * straight away: a day of its calendar, its month and year). It goes by the first
 * date or date & time field (none: Updated), or another one picked beside it (Created, Updated
 * too), and is kept as the filter's one "between" rule (domain/datePeriod.ts), which the rule list
 * doesn't show. The current day, week, month or year is kept counted from today ("this week" stays
 * this week once saved), and so are a range ending today ("the last 7 days") and this week, month
 * or year so far ("To date": year to date); any other is kept as its days. On an item page (`page`, its
 * collection) one counted from a day can be counted from the page's item's date instead ("Counted from":
 * the last 7 days up to this measurement's date; `anchoredValue`), worked out for each page's item.
 */
export function DatePeriodFilter({ collection, filters, page, onChange }: { collection: Collection; filters: FilterRule[]; page?: Collection; onChange(filters: FilterRule[]): void }) {
  const uid = useId();
  const fields = dateFields(collection);
  const rule = periodRule(filters);
  const now = nowMinute();
  const today = now.slice(0, 10);
  const { value, fieldId: anchor } = rule ? splitAnchor(rule.value) : { value: "", fieldId: null };
  const rolling = rule ? parseRolling(value) : null;
  const rollingRange = rule ? parseRollingRange(value) : null;
  const toDate = rule ? parseToDate(value) : null;
  const counted = !!(rolling || rollingRange || toDate);
  // The page's item's dates a period can be counted from; the one it is.
  const pageDates = page ? page.fields.filter((f) => f.kind === "date" || f.kind === "datetime") : [];
  const anchorField = anchor ? pageDates.find((f) => f.id === anchor) : undefined;
  const period = rule ? resolveRange(value, now) : null;
  // The field and "Range" before a period is set (no rule yet), and "Range" for a period
  // that is also a whole month (say), so the switcher doesn't jump to "Month" while start and end are chosen.
  const [chosenField, setChosenField] = useState<string>();
  const [rangeChosen, setRangeChosen] = useState(false);
  const fieldId = rule?.fieldId ?? (fields.some((f) => f.id === chosenField) ? chosenField! : defaultDateField(collection));
  const kind: PeriodKind | null = rangeChosen || rollingRange ? "range" : toDate ? toDate : rolling ? rolling.kind : period ? periodKind(period) : null;
  const spec = KINDS.find((k) => k.kind === kind);

  /**
   * Stores a period: today's day, week, month or year as counted from today ("month+0"), a range
   * ending today as its days counted from today ("day-6..day+0"), any other as its days.
   */
  const write = (next: Period | null, nextKind = kind) => {
    if (!next) return onChange(filters.filter((r) => r !== rule));
    const current = nextKind && nextKind !== "range" && rangeValue(periodAround(nextKind, now)) === rangeValue(next);
    store(current ? rollingValue({ kind: nextKind, offset: 0 }) : nextKind === "range" ? rangeOrRolling(next, today) : rangeValue(next));
  };
  // Counted from the page's item's date stays so while the period is counted from a day (a fixed one has its days).
  const store = (next: string, from = anchor) => {
    const fromDay = parseRolling(next) || parseRollingRange(next) || parseToDate(next);
    const written: FilterRule = { id: rule?.id ?? newId(), fieldId, operator: "between", value: anchoredValue(next, fromDay ? from : null) };
    onChange(rule ? filters.map((r) => (r === rule ? written : r)) : [written, ...filters]);
  };
  const pick = (next: PeriodKind) => {
    setRangeChosen(next === "range");
    // A range starts as the period shown (its two days to change; rolling only when it ends today); the
    // others around today, or around the period shown when that isn't now (a month of last year →
    // that week).
    if (next === "range") return period && rolling && write(period, "range");
    const showsNow = period && period.start.slice(0, 10) <= today && today <= period.end.slice(0, 10);
    // This week, month or year so far stays so far in another of them (year to date → month to date).
    if (toDate && next !== "day" && next !== "hour") return store(toDateValue(next));
    write(periodAround(next, period && !showsNow ? period.start : now), next);
  };
  const counting = toDate ? toDateLabel(toDate) : rolling ? rollingLabel(rolling) : rollingRange ? rollingRangeLabel(rollingRange) : "";
  const label = !period || !kind
    ? kind === "range"
      ? "Choose the first and last day"
      : "Any date"
    : anchor
      ? `${counting} · counted from this ${page?.name ?? "item"}'s ${anchorField?.name ?? "date"}`
      : toDate
      ? `${toDateLabel(toDate)} · ${periodLabel(period, "range")}`
      : rolling
        ? `${rollingLabel(rolling)} · ${periodLabel(period, kind)}`
        : rollingRange
          ? `${rollingRangeLabel(rollingRange)} · ${periodLabel(period, kind)}`
          : periodLabel(period, kind);

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
        <IconButton autoAlign label="Previous" kind="ghost" size="sm" disabled={!period || !kind || !!anchor} onClick={() => period && kind && write(shiftPeriod(period, kind, -1))}>
          <ChevronLeft />
        </IconButton>
        <IconButton autoAlign label="Next" kind="ghost" size="sm" disabled={!period || !kind || !!anchor} onClick={() => period && kind && write(shiftPeriod(period, kind, 1))}>
          <ChevronRight />
        </IconButton>
        <IconButton
          autoAlign
          label={spec?.current || "Today"}
          kind="ghost"
          size="sm"
          disabled={!kind || kind === "range"}
          onClick={() => kind && kind !== "range" && write(periodAround(kind, now))}
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
      {pageDates.length > 0 && (
        <Select
          id={`${uid}-date-from`}
          labelText="Counted from"
          size="sm"
          value={anchor ?? ""}
          disabled={!counted}
          helperText={counted ? undefined : "For a period counted from today: this week, the last 7 days, …"}
          onChange={(e) => store(value, e.target.value || null)}
        >
          <SelectItem value="" text="Today" />
          {pageDates.map((f) => (
            <SelectItem key={f.id} value={f.id} text={`This ${page!.name}'s ${f.name}`} />
          ))}
        </Select>
      )}
      {period && (kind === "week" || kind === "month" || kind === "year") && (
        <Checkbox
          id={`${uid}-to-date`}
          labelText={toDateLabel(kind)}
          checked={!!toDate}
          onChange={(_, { checked }) => (checked ? store(toDateValue(kind)) : write(periodAround(kind, now), kind))}
        />
      )}
      {period && (kind === "hour" || kind === "day" || kind === "week") && (
        <div className="date-period__pick">
          <DatePicker
            datePickerType="single"
            dateFormat="Y-m-d"
            value={period.start.slice(0, 10)}
            // An hour keeps its time on another day.
            onChange={([day]) => day && write(periodAround(kind, kind === "hour" ? `${formatDate(day)}${period.start.slice(10)}` : formatDate(day)))}
          >
            <DatePickerInput id={`${uid}-date-day`} size="sm" labelText={kind === "week" ? "A day of the week" : "Day"} placeholder="yyyy-mm-dd" />
          </DatePicker>
          {kind === "hour" && (
            <Select
              id={`${uid}-date-hour`}
              labelText="Hour"
              size="sm"
              value={period.start.slice(11, 13)}
              onChange={(e) => write(periodAround("hour", `${period.start.slice(0, 10)}T${e.target.value}:00`))}
            >
              {HOURS.map((h) => (
                <SelectItem key={h} value={h} text={`${h}:00`} />
              ))}
            </Select>
          )}
        </div>
      )}
      {period && (kind === "month" || kind === "year") && (
        <div className="date-period__pick">
          {kind === "month" && (
            <Select
              id={`${uid}-date-month`}
              labelText="Month"
              size="sm"
              value={Number(period.start.slice(5, 7))}
              onChange={(e) => write(periodAround("month", `${period.start.slice(0, 4)}-${e.target.value.padStart(2, "0")}-01`))}
            >
              {MONTHS.map((name, i) => (
                <SelectItem key={name} value={i + 1} text={name} />
              ))}
            </Select>
          )}
          <Select
            id={`${uid}-date-year`}
            labelText="Year"
            size="sm"
            value={Number(period.start.slice(0, 4))}
            onChange={(e) => write(periodAround(kind, `${e.target.value}${period.start.slice(4)}`))}
          >
            {yearsAround(Number(period.start.slice(0, 4)), Number(today.slice(0, 4))).map((y) => (
              <SelectItem key={y} value={y} text={String(y)} />
            ))}
          </Select>
        </div>
      )}
      {kind === "range" && (
        <LastRange
          id={`${uid}-date-last`}
          // The range shown when it ends now (the last 7 days): its length and unit.
          value={rollingRange && rollingRange.to === 0 ? { n: rollingRange.to - rollingRange.from + 1, unit: rollingRange.unit ?? "day" } : null}
          onChange={({ n, unit }) => store(rollingRangeValue({ from: 1 - n, to: 0, unit }))}
        />
      )}
      {kind === "range" && (
        <DatePicker
          className="date-period__range"
          datePickerType="range"
          dateFormat="Y-m-d"
          value={period ? [period.start.slice(0, 10), period.end.slice(0, 10)] : undefined}
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

/**
 * A range ending now by its length: the last 7 days, the last 24 hours, the last 30 minutes (empty
 * while the range shown is another one). Kept counted from now.
 */
function LastRange({ id, value, onChange }: { id: string; value: { n: number; unit: RangeUnit } | null; onChange(next: { n: number; unit: RangeUnit }): void }) {
  // The unit picked before a length is typed.
  const [unit, setUnit] = useState<RangeUnit>(value?.unit ?? "day");
  const shown = value?.unit ?? unit;
  return (
    <div className="date-period__pick">
      <NumberInput
        id={`${id}-n`}
        label="Last"
        size="sm"
        min={1}
        hideSteppers
        allowEmpty
        value={value?.n ?? ""}
        onChange={(_, { value: n }) => {
          const count = Number(n);
          if (Number.isInteger(count) && count >= 1) onChange({ n: count, unit: shown });
        }}
      />
      <Select
        id={`${id}-unit`}
        labelText="Counted in"
        size="sm"
        value={shown}
        onChange={(e) => {
          const next = e.target.value as RangeUnit;
          setUnit(next);
          if (value) onChange({ n: value.n, unit: next });
        }}
      >
        {RANGE_UNITS.map((u) => (
          <SelectItem key={u.unit} value={u.unit} text={u.text} />
        ))}
      </Select>
    </div>
  );
}
