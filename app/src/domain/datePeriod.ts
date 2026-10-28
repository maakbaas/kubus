// The date filter's periods: a day, a week, a month, a year or any start and end, kept as one
// "between" rule. Its value is fixed days ("yyyy-mm-dd..yyyy-mm-dd", both included), or rolling: a
// day, week, month or year counted from today ("month+0" this month, "week-1" last week), worked
// out whenever the filter runs; a range ending today is rolling too, its days counted from today
// ("day-6..day+0": the last 7 days). Which period fixed days are follows from them, so nothing but the
// rule is stored. Weeks run Sunday to Saturday, like the date pickers' calendars; week 1 is the one
// holding 1 January. Storage-free and UI-free.

import { formatDate } from "./fieldKinds";
import { pickableFields, type Collection, type FieldDef } from "./model";
import type { FilterRule } from "./query";

export type PeriodKind = "day" | "week" | "month" | "year" | "range";

export interface Period {
  /** First and last day, both included ("yyyy-mm-dd"). */
  start: string;
  end: string;
}

const SEPARATOR = "..";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A between rule's value. */
export const rangeValue = ({ start, end }: Period) => `${start}${SEPARATOR}${end}`;

/** A rolling period: so many days, weeks, months or years from today's (0: today's own). */
export interface Rolling {
  kind: Exclude<PeriodKind, "range">;
  offset: number;
}
const ROLLING = /^(day|week|month|year)([+-]\d+)$/;

/** A rolling between rule's value ("week-1"). */
export const rollingValue = ({ kind, offset }: Rolling) => `${kind}${offset < 0 ? "-" : "+"}${Math.abs(offset)}`;

/** The rolling period of a between rule's value, or null when it holds fixed days (or nothing valid). */
export function parseRolling(value: string): Rolling | null {
  const m = ROLLING.exec(value.trim());
  return m ? { kind: m[1] as Rolling["kind"], offset: Number(m[2]) } : null;
}

/** A rolling range: its first and last day as days from today ("day-6..day+0", the last 7 days). */
export interface RollingRange {
  from: number;
  to: number;
}
const ROLLING_RANGE = /^day([+-]\d+)\.\.day([+-]\d+)$/;

/** A rolling range's value ("day-6..day+0"). */
export const rollingRangeValue = ({ from, to }: RollingRange) => `${rollingValue({ kind: "day", offset: from })}${SEPARATOR}${rollingValue({ kind: "day", offset: to })}`;

/** The rolling range of a between rule's value, or null when it is none (first not after last). */
export function parseRollingRange(value: string): RollingRange | null {
  const m = ROLLING_RANGE.exec(value.trim());
  if (!m) return null;
  const range = { from: Number(m[1]), to: Number(m[2]) };
  return range.from <= range.to ? range : null;
}

/** A range kept as it is stored: one ending today as days counted from today (so it moves with it), any other as its days. */
export function rangeOrRolling(period: Period, today: string): string {
  return period.end === today && period.start <= today ? rollingRangeValue({ from: daysBetween(today, period.start), to: 0 }) : rangeValue(period);
}

/** A rolling range in words: "Last 7 days" (up to today), "Today". */
export function rollingRangeLabel({ from, to }: RollingRange): string {
  const days = to - from + 1;
  if (to !== 0) return `${days} days`;
  return days === 1 ? "Today" : `Last ${days} days`;
}

/** The days of a between rule's value as of today (a rolling one worked out), or null when it isn't a period. */
export function resolveRange(value: string, today = formatDate(new Date())): Period | null {
  const rolling = parseRolling(value);
  if (rolling) return rollingPeriod(rolling, today);
  const range = parseRollingRange(value);
  if (range) return { start: addDays(today, range.from), end: addDays(today, range.to) };
  return parseRange(value);
}

/** The fixed days of a between rule's value, or null when it isn't two days (first not after last). */
export function parseRange(value: string): Period | null {
  const [start, end, ...rest] = value.trim().split(SEPARATOR);
  if (rest.length || !DAY.test(start ?? "") || !DAY.test(end ?? "") || start > end) return null;
  return { start, end };
}

/** A "yyyy-mm-dd" day as a local date (midnight). */
const toDate = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (day: string, n: number) => {
  const d = toDate(day);
  d.setDate(d.getDate() + n);
  return formatDate(d);
};
const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000);
/** Sunday of the day's week. */
const weekStart = (day: string) => addDays(day, -toDate(day).getDay());

/** The day, week, month or year a day falls in (a range: that day alone). */
export function periodAround(kind: PeriodKind, day: string): Period {
  const d = toDate(day);
  switch (kind) {
    case "week": {
      const start = weekStart(day);
      return { start, end: addDays(start, 6) };
    }
    case "month":
      return { start: formatDate(new Date(d.getFullYear(), d.getMonth(), 1)), end: formatDate(new Date(d.getFullYear(), d.getMonth() + 1, 0)) };
    case "year":
      return { start: `${d.getFullYear()}-01-01`, end: `${d.getFullYear()}-12-31` };
    default:
      return { start: day, end: day };
  }
}

/** What a period is: one day, a whole week, month or year, or another range. */
export function periodKind({ start, end }: Period): PeriodKind {
  if (start === end) return "day";
  for (const kind of ["week", "month", "year"] as const) {
    const p = periodAround(kind, start);
    if (p.start === start && p.end === end) return kind;
  }
  return "range";
}

/** The period before (-1) or after (1): the next day, week, month or year; a range moves by its length. */
export function shiftPeriod(period: Period, kind: PeriodKind, direction: 1 | -1): Period {
  const d = toDate(period.start);
  switch (kind) {
    case "week":
      return periodAround("week", addDays(period.start, 7 * direction));
    case "month":
      return periodAround("month", formatDate(new Date(d.getFullYear(), d.getMonth() + direction, 1)));
    case "year":
      return periodAround("year", `${d.getFullYear() + direction}-01-01`);
    default: {
      const days = (daysBetween(period.start, period.end) + 1) * direction;
      return { start: addDays(period.start, days), end: addDays(period.end, days) };
    }
  }
}

/** The days a rolling period stands for today. */
export const rollingPeriod = ({ kind, offset }: Rolling, today: string): Period =>
  offset === 0 ? periodAround(kind, today) : shiftBy(periodAround(kind, today), kind, offset);
const shiftBy = (period: Period, kind: PeriodKind, steps: number): Period => {
  let p = period;
  for (let i = 0; i < Math.abs(steps); i++) p = shiftPeriod(p, kind, steps < 0 ? -1 : 1);
  return p;
};

const UNITS = { day: ["Today", "Yesterday", "Tomorrow"], week: ["This week", "Last week", "Next week"], month: ["This month", "Last month", "Next month"], year: ["This year", "Last year", "Next year"] };
/** A rolling period in words: "This week", "Last month", "3 days ago", "In 2 years". */
export function rollingLabel({ kind, offset }: Rolling): string {
  const [current, last, next] = UNITS[kind];
  if (offset === 0) return current;
  if (offset === -1) return last;
  if (offset === 1) return next;
  const unit = `${Math.abs(offset)} ${kind}s`;
  return offset < 0 ? `${unit} ago` : `In ${unit}`;
}

/** The week number of a day: week 1 is the week (Sunday to Saturday) holding 1 January. */
export function weekNumber(day: string): { week: number; year: number } {
  const start = weekStart(day);
  // The week belongs to the year of its Saturday (a week holding 1 January is that year's first).
  const year = toDate(addDays(start, 6)).getFullYear();
  return { week: daysBetween(weekStart(`${year}-01-01`), start) / 7 + 1, year };
}

/** A period in words ("Week 44 · 26 Oct – 1 Nov 2026", "October 2026", "Tue 27 Oct 2026", "1 Oct – 15 Nov 2026"). */
export function periodLabel(period: Period, kind: PeriodKind, locale?: string): string {
  const start = toDate(period.start);
  const end = toDate(period.end);
  const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleDateString(locale, o);
  switch (kind) {
    case "day":
      return fmt(start, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    case "week": {
      const { week } = weekNumber(period.start);
      return `Week ${week} · ${periodLabel(period, "range", locale)}`;
    }
    case "month":
      return fmt(start, { month: "long", year: "numeric" });
    case "year":
      return String(start.getFullYear());
    default: {
      const sameYear = start.getFullYear() === end.getFullYear();
      const first = fmt(start, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
      return `${first} – ${fmt(end, { day: "numeric", month: "short", year: "numeric" })}`;
    }
  }
}

/** The fields a date filter can go by: date and date & time fields in field order, then Created and Updated. */
export const dateFields = (collection: Collection): FieldDef[] =>
  pickableFields(collection).filter((f) => f.kind === "date" || f.kind === "datetime");

/** The field a date filter goes by unless another is picked: the first date or date & time field, else Updated. */
export const defaultDateField = (collection: Collection): string =>
  collection.fields.find((f) => f.kind === "date" || f.kind === "datetime")?.id ?? UPDATED_FIELD;
const UPDATED_FIELD = "$updated";

/** The filter's date period rule (its first "between" rule), if any. */
export const periodRule = (filters: FilterRule[]) => filters.find((r) => r.operator === "between");
