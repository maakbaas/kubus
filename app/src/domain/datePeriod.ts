// The date filter's periods: a day, a week, a month, a year or any start and end, kept as one
// "between" rule (FilterRule value "yyyy-mm-dd..yyyy-mm-dd", both days included). Which of them
// a rule is follows from its two days, so nothing but the rule is stored. Weeks start on Monday
// (ISO weeks). Storage-free and UI-free.

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

/** The period of a between rule's value, or null when it isn't two days (first not after last). */
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
/** Monday of the day's week. */
const weekStart = (day: string) => addDays(day, -((toDate(day).getDay() + 6) % 7));

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

/** The ISO week number of a day (week 1 holds the year's first Thursday). */
export function isoWeek(day: string): { week: number; year: number } {
  const thursday = toDate(addDays(weekStart(day), 3));
  const jan1 = new Date(thursday.getFullYear(), 0, 1);
  return { week: Math.floor((thursday.getTime() - jan1.getTime()) / (7 * 86_400_000)) + 1, year: thursday.getFullYear() };
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
      const { week } = isoWeek(period.start);
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

/** The filter's date period rule (its first "between" rule), if any. */
export const periodRule = (filters: FilterRule[]) => filters.find((r) => r.operator === "between");
