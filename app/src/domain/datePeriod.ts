// The date filter's periods: an hour, a day, a week, a month, a year or any start and end, kept as one
// "between" rule. Its value is fixed days ("yyyy-mm-dd..yyyy-mm-dd", both included) or minutes
// ("yyyy-mm-ddTHH:MM..yyyy-mm-ddTHH:MM", local, both included: an hour is 14:00..14:59), or rolling: an
// hour, day, week, month or year counted from now ("month+0" this month, "week-1" last week, "hour+0"
// this hour), worked out whenever the filter runs; a range ending now is rolling too, its minutes, hours
// or days counted from now ("day-6..day+0": the last 7 days, "hour-23..hour+0": the last 24 hours,
// "minute-29..minute+0": the last 30 minutes), and so is this week, month or year so far ("year+0..day+0":
// year to date). A date (no time) is in a period of minutes by its day. Which period fixed days are
// follows from them, so nothing but the rule is stored. Weeks run Sunday to Saturday, like the date pickers' calendars; week 1 is the one
// holding 1 January. Storage-free and UI-free.

import { formatDate, formatTime } from "./fieldKinds";
import { newId, pickableFields, type Collection, type FieldDef } from "./model";
import type { FilterRule } from "./query";

export type PeriodKind = "hour" | "day" | "week" | "month" | "year" | "range";
/** An hour, day, week, month or year (not a range). */
export type Unit = Exclude<PeriodKind, "range">;

export interface Period {
  /** First and last day ("yyyy-mm-dd") or minute ("yyyy-mm-ddTHH:MM", local), both included. */
  start: string;
  end: string;
}

const SEPARATOR = "..";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
/** Whether a period's bounds are minutes (not days). */
export const inMinutes = (period: Period) => period.start.length > 10;

/** A local moment as its minute ("yyyy-mm-ddTHH:MM"). */
export const formatMinute = (d: Date) => `${formatDate(d)}T${formatTime(d)}`;
/** Now, as its minute. */
export const nowMinute = () => formatMinute(new Date());
/** A day or minute as a local date (a day: its midnight). */
const toMoment = (at: string) => {
  const [y, m, d] = at.slice(0, 10).split("-").map(Number);
  return at.length > 10 ? new Date(y, m - 1, d, Number(at.slice(11, 13)), Number(at.slice(14, 16))) : new Date(y, m - 1, d);
};
/** A minute so many minutes on (over a change of summer time by the clock's minutes). */
const addMinutes = (at: string, n: number) => {
  const d = toMoment(at);
  d.setMinutes(d.getMinutes() + n);
  return formatMinute(d);
};
/** The minute an hour or minute starts at ("14:00" of 14:35). */
const floorTo = (at: string, unit: "minute" | "hour") => (unit === "hour" ? `${at.slice(0, 13)}:00` : at.slice(0, 16));
/** A moment's minute: a day's is its midnight. */
const asMinute = (at: string) => (at.length > 10 ? at.slice(0, 16) : `${at}T00:00`);

/** A between rule's value. */
export const rangeValue = ({ start, end }: Period) => `${start}${SEPARATOR}${end}`;

/** A rolling period: so many hours, days, weeks, months or years from now's (0: now's own). */
export interface Rolling {
  kind: Unit;
  offset: number;
}
const ROLLING = /^(hour|day|week|month|year)([+-]\d+)$/;

/** A rolling between rule's value ("week-1"). */
export const rollingValue = ({ kind, offset }: Rolling) => `${kind}${offset < 0 ? "-" : "+"}${Math.abs(offset)}`;

/** The rolling period of a between rule's value, or null when it holds fixed days (or nothing valid). */
export function parseRolling(value: string): Rolling | null {
  const m = ROLLING.exec(value.trim());
  return m ? { kind: m[1] as Unit, offset: Number(m[2]) } : null;
}

/** What a rolling range is counted in. */
export type RangeUnit = "minute" | Unit;

/**
 * A rolling range: its first and last day (minute, hour, week, month, year) counted from today's
 * ("day-6..day+0", the last 7 days; "month-11..month+0", the last 12 months, this one included).
 */
export interface RollingRange {
  from: number;
  to: number;
  /** Days unless given. */
  unit?: RangeUnit;
}
const ROLLING_RANGE = /^(minute|hour|day|week|month|year)([+-]\d+)\.\.(minute|hour|day|week|month|year)([+-]\d+)$/;

const offsetText = (offset: number) => `${offset < 0 ? "-" : "+"}${Math.abs(offset)}`;
/** A rolling range's value ("day-6..day+0", "hour-23..hour+0"). */
export const rollingRangeValue = ({ from, to, unit = "day" }: RollingRange) => `${unit}${offsetText(from)}${SEPARATOR}${unit}${offsetText(to)}`;

/** The rolling range of a between rule's value, or null when it is none (two units, or first after last). */
export function parseRollingRange(value: string): RollingRange | null {
  const m = ROLLING_RANGE.exec(value.trim());
  if (!m || m[1] !== m[3]) return null;
  const range = { from: Number(m[2]), to: Number(m[4]), unit: m[1] as RangeUnit };
  return range.from <= range.to ? range : null;
}

/** This week, month or year up to today (year to date). */
export type ToDate = "week" | "month" | "year";
const TO_DATE = /^(week|month|year)\+0\.\.day\+0$/;

/** A to-date period's value ("year+0..day+0"). */
export const toDateValue = (kind: ToDate) => `${rollingValue({ kind, offset: 0 })}${SEPARATOR}${rollingValue({ kind: "day", offset: 0 })}`;

/** The to-date period of a between rule's value, or null when it is none. */
export function parseToDate(value: string): ToDate | null {
  const m = TO_DATE.exec(value.trim());
  return m ? (m[1] as ToDate) : null;
}

/** A to-date period in words: "Year to date". */
export const toDateLabel = (kind: ToDate) => `${kind[0].toUpperCase()}${kind.slice(1)} to date`;

/** A range kept as it is stored: one of days ending today as days counted from today (so it moves with it), any other as its days or minutes. */
export function rangeOrRolling(period: Period, today: string): string {
  return !inMinutes(period) && period.end === today && period.start <= today ? rollingRangeValue({ from: daysBetween(today, period.start), to: 0 }) : rangeValue(period);
}

const RANGE_WORDS: Record<RangeUnit, [one: string, many: string, current: string]> = {
  minute: ["minute", "minutes", "This minute"],
  hour: ["hour", "hours", "This hour"],
  day: ["day", "days", "Today"],
  week: ["week", "weeks", "This week"],
  month: ["month", "months", "This month"],
  year: ["year", "years", "This year"],
};
/** A rolling range in words: "Last 7 days" (up to today), "Today", "Last 24 hours", "7 days up to 7 days ago" (one stepped back). */
export function rollingRangeLabel({ from, to, unit = "day" }: RollingRange): string {
  const n = to - from + 1;
  const [one, many, current] = RANGE_WORDS[unit];
  if (to !== 0) {
    const distance = `${Math.abs(to)} ${Math.abs(to) === 1 ? one : many}`;
    return `${n} ${n === 1 ? one : many} up to ${distance} ${to < 0 ? "ago" : "from now"}`;
  }
  return n === 1 ? current : `Last ${n} ${many}`;
}

/**
 * The days (or minutes) of a between rule's value as of now (a rolling one worked out), or null when
 * it isn't a period. `now` is a minute, or a day (counted from its midnight).
 */
export function resolveRange(value: string, now = nowMinute()): Period | null {
  const today = now.slice(0, 10);
  const rolling = parseRolling(value);
  if (rolling) return rollingPeriod(rolling, rolling.kind === "hour" ? asMinute(now) : today);
  const toDate = parseToDate(value);
  if (toDate) return { start: periodAround(toDate, today).start, end: today };
  const range = parseRollingRange(value);
  if (range?.unit === "minute") {
    const current = asMinute(now);
    return { start: addMinutes(current, range.from), end: addMinutes(current, range.to) };
  }
  // From the first one's start to the last one's end (an hour's from now's).
  if (range) {
    const kind = range.unit ?? "day";
    const at = kind === "hour" ? asMinute(now) : today;
    return { start: rollingPeriod({ kind, offset: range.from }, at).start, end: rollingPeriod({ kind, offset: range.to }, at).end };
  }
  return parseRange(value);
}

/** The fixed days or minutes of a between rule's value, or null when it isn't two of either (first not after last). */
export function parseRange(value: string): Period | null {
  const [start, end, ...rest] = value.trim().split(SEPARATOR);
  const days = DAY.test(start ?? "") && DAY.test(end ?? "");
  const minutes = MINUTE.test(start ?? "") && MINUTE.test(end ?? "");
  if (rest.length || !(days || minutes) || start > end) return null;
  return { start, end };
}

/** A "yyyy-mm-dd" day as a local date (midnight). */
const toDate = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
};
export const addDays = (day: string, n: number) => {
  const d = toDate(day);
  d.setDate(d.getDate() + n);
  return formatDate(d);
};
const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000);
/** Sunday of the day's week. */
export const weekStart = (day: string) => addDays(day, -toDate(day).getDay());

/** The hour, day, week, month or year a day or minute falls in (a range: that day alone; an hour of a day: its first). */
export function periodAround(kind: PeriodKind, at: string): Period {
  if (kind === "hour") {
    const start = floorTo(asMinute(at), "hour");
    return { start, end: `${start.slice(0, 13)}:59` };
  }
  const day = at.slice(0, 10);
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

/** What a period is: one hour, one day, a whole week, month or year, or another range. */
export function periodKind({ start, end }: Period): PeriodKind {
  if (start.length > 10) return start.endsWith(":00") && end === `${start.slice(0, 13)}:59` ? "hour" : "range";
  if (start === end) return "day";
  for (const kind of ["week", "month", "year"] as const) {
    const p = periodAround(kind, start);
    if (p.start === start && p.end === end) return kind;
  }
  return "range";
}

/** The period before (-1) or after (1): the next hour, day, week, month or year; a range moves by its length. */
export function shiftPeriod(period: Period, kind: PeriodKind, direction: 1 | -1): Period {
  if (inMinutes(period)) {
    if (kind === "hour") return periodAround("hour", addMinutes(period.start, 60 * direction));
    const minutes = Math.round((toMoment(period.end).getTime() - toMoment(period.start).getTime()) / 60_000) + 1;
    return { start: addMinutes(period.start, minutes * direction), end: addMinutes(period.end, minutes * direction) };
  }
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

const UNITS = { hour: ["This hour", "Last hour", "Next hour"], day: ["Today", "Yesterday", "Tomorrow"], week: ["This week", "Last week", "Next week"], month: ["This month", "Last month", "Next month"], year: ["This year", "Last year", "Next year"] };
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

/** A period in words ("Week 44 - 26 Oct – 1 Nov 2026", "October 2026", "Tue 27 Oct 2026", "1 Oct – 15 Nov 2026", "Tue 27 Oct 2026, 14:00 – 15:00"). */
export function periodLabel(period: Period, kind: PeriodKind, locale?: string): string {
  if (inMinutes(period)) {
    // Up to the end of its last minute (an hour: 14:00 – 15:00).
    const start = toMoment(period.start);
    const end = toMoment(addMinutes(period.end, 1));
    const time = (d: Date) => d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    const day = (d: Date) => d.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    if (kind === "hour" || formatDate(start) === formatDate(toMoment(period.end))) return `${day(start)}, ${time(start)} – ${time(end)}`;
    const short = (d: Date) => `${d.toLocaleDateString(locale, { day: "numeric", month: "short" })} ${time(d)}`;
    return `${short(start)} – ${short(end)}`;
  }
  const start = toDate(period.start);
  const end = toDate(period.end);
  const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleDateString(locale, o);
  switch (kind) {
    case "day":
      return fmt(start, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    case "week": {
      const { week } = weekNumber(period.start);
      return `Week ${week} - ${periodLabel(period, "range", locale)}`;
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

/**
 * Which one of its kind a period is: counted from now (this week, last week: it moves on with
 * time), this week, month or year so far, the last n of them up to now (n minutes for an hour), or
 * a chosen one (fixed days).
 */
export type Window = "current" | "toDate" | "last" | "lastMinutes" | "fixed";
/** The n a "Last n" starts with. */
export const LAST: Record<RangeUnit, number> = { minute: 30, hour: 24, day: 7, week: 4, month: 12, year: 3 };

/** What a between rule's value (without its anchor) stands for: its days, kind and window. */
export interface PeriodState {
  /** Its first and last day or minute as of now. */
  period: Period;
  kind: PeriodKind;
  /** Null for a range. */
  window: Window | null;
  rolling: Rolling | null;
  rollingRange: RollingRange | null;
  toDate: ToDate | null;
  /** The last n up to now, or n of them stepped back or on from there ("7 days up to 7 days ago"). */
  last: RollingRange | null;
  /** Counted from now (it moves on with time). */
  counted: boolean;
  /** "Last week", "Year to date", "Last 7 days": the words for a counted period, else "". */
  counting: string;
}

/** What a between rule's value is as of now, or null when it is no period. */
export function periodState(value: string, now = nowMinute()): PeriodState | null {
  const period = resolveRange(value, now);
  if (!period) return null;
  const rolling = parseRolling(value);
  const rollingRange = parseRollingRange(value);
  const toDate = parseToDate(value);
  const last = rollingRange;
  const lastKind: PeriodKind | null = last ? (last.unit === "minute" ? "hour" : (last.unit ?? "day")) : null;
  const kind: PeriodKind = lastKind ?? (toDate || (rolling ? rolling.kind : rollingRange ? "range" : periodKind(period)));
  const window: Window | null =
    kind === "range" ? null : last ? (last.unit === "minute" ? "lastMinutes" : "last") : toDate ? "toDate" : rolling ? "current" : "fixed";
  const counting = toDate ? toDateLabel(toDate) : rolling ? rollingLabel(rolling) : rollingRange ? rollingRangeLabel(rollingRange) : "";
  return { period, kind, window, rolling, rollingRange, toDate, last, counted: !!(rolling || rollingRange || toDate), counting };
}

/** A period's words in two parts: how it is counted ("Last week", "" for a chosen one) and its days ("Week 43 - 18 Oct – 24 Oct 2026"). */
export function periodParts(state: PeriodState, kind: PeriodKind = state.kind): { counting: string; days: string } {
  const { period, counting, toDate, rollingRange } = state;
  return { counting, days: periodLabel(period, counting && (toDate || rollingRange) ? "range" : kind) };
}

const UNIT_WORD = /\b(minutes?|hours?|days?|weeks?|months?|years?)\b/i;

/**
 * A period's words with the unit word marked, for the filter bar (where it is a dropdown switching the
 * kind): `before + unit + after` is how it is counted ("This week": "This ", "week", ""; "7 weeks ago":
 * "7 ", "weeks", " ago"; "Last 7 days"; "Year to date": "", "Year", " to date"), `days` its days ("Week 44 · …").
 * A period with no unit word in its counting (a chosen one: "October 2026", a range, "Today") has `unit`
 * null, and `before` holds its counting whole (empty for a chosen one).
 */
export function periodWords(state: PeriodState): { before: string; unit: string | null; after: string; days: string } {
  const { counting, days } = periodParts(state);
  // A range is no kind of the switch, whatever its counting says ("3 days").
  const found = state.kind === "range" ? null : UNIT_WORD.exec(counting);
  if (!found) return { before: counting, unit: null, after: "", days };
  return { before: counting.slice(0, found.index), unit: found[0], after: counting.slice(found.index + found[0].length), days };
}

/** A period in words as the date filter's line shows it: "October 2026", "Last week - Week 43 - …", "Last 7 days - 23 Oct – 29 Oct 2026". */
export function periodText(state: PeriodState, kind: PeriodKind = state.kind): string {
  const { counting, days } = periodParts(state, kind);
  return counting ? `${counting} - ${days}` : days;
}

/** A window of a unit: the current one, so far, the last n (`n`, else the unit's own), or the chosen one around `at`. */
export function windowValue(unit: Unit, window: Window, at: string, n?: number): string {
  if (window === "current") return rollingValue({ kind: unit, offset: 0 });
  if (window === "toDate" && unit !== "hour" && unit !== "day") return toDateValue(unit);
  if (window === "last" || window === "lastMinutes") {
    const rangeUnit: RangeUnit = window === "lastMinutes" ? "minute" : unit;
    return rollingRangeValue({ unit: rangeUnit, from: 1 - (n ?? LAST[rangeUnit]), to: 0 });
  }
  return rangeValue(periodAround(unit, at));
}

/**
 * The period of another unit: the same window in it (a chosen one around the period shown; the
 * current one when there is none yet). So far isn't of an hour or a day, n minutes are of an hour,
 * and the last n of another unit starts as its own n (the last 7 days: the last 12 months).
 */
export function kindValue(value: string | null, unit: Unit, now = nowMinute()): string {
  const state = value ? periodState(value, now) : null;
  const window = state?.window ?? null;
  const next: Window = window === "toDate" && (unit === "hour" || unit === "day") ? "current" : window === "lastMinutes" && unit !== "hour" ? "last" : (window ?? "current");
  return windowValue(unit, next, state?.period.start ?? now);
}

/**
 * The period before (-1) or after (1): a rolling one stays rolling (this week, last week), a chosen
 * one moves by its kind (a range by its length; `kind` given, else the one it is), and the last n by n,
 * still counted from now ("day-13..day-7": the 7 days before the last 7). Null for one so far (year to
 * date), which has nothing before or after it, and for a value that is no period.
 */
export function stepValue(value: string, direction: 1 | -1, now = nowMinute(), kind?: PeriodKind): string | null {
  const state = periodState(value, now);
  if (!state || state.toDate) return null;
  if (state.last) {
    const { from, to, unit } = state.last;
    const by = (to - from + 1) * direction;
    return rollingRangeValue({ from: from + by, to: to + by, unit });
  }
  if (state.rolling) return rollingValue({ kind: state.rolling.kind, offset: state.rolling.offset + direction });
  return rangeValue(shiftPeriod(state.period, kind ?? state.kind, direction));
}

/** The most recent period of the value's kind, rolling: this hour, today, this week, month or year. Null for a range or no period. */
export function latestValue(value: string, now = nowMinute()): string | null {
  const state = periodState(value, now);
  return state && state.kind !== "range" ? rollingValue({ kind: state.kind, offset: 0 }) : null;
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

/**
 * A rolling period counted from a page item's date instead of today: its value, then "@$item." and the
 * item's date field ("day-6..day+0@$item.f1": the 7 days up to the item's date). On an item page the
 * filter works it out from that item's value (query.ts resolvePageValues); elsewhere it matches nothing.
 */
const ANCHOR = "@$item.";

/**
 * The filters with the period set to `value`: the existing rule's (keeping its field, and its
 * counted-from date when `from` is not given and the new period is counted from a day), else a new
 * "between" rule on `fieldId`, first.
 */
export function withPeriod(filters: FilterRule[], fieldId: string, value: string, from?: string | null): FilterRule[] {
  const rule = periodRule(filters);
  const anchor = from === undefined ? (rule ? splitAnchor(rule.value).fieldId : null) : from;
  const fromDay = parseRolling(value) || parseRollingRange(value) || parseToDate(value);
  const written: FilterRule = { id: rule?.id ?? newId(), fieldId: rule?.fieldId ?? fieldId, operator: "between", value: anchoredValue(value, fromDay ? anchor : null), ...(rule?.join && { join: rule.join }) };
  return rule ? filters.map((r) => (r === rule ? written : r)) : [written, ...filters];
}

/** A period value and the page item's date field it is counted from (null: today). */
export function splitAnchor(value: string): { value: string; fieldId: string | null } {
  const at = value.lastIndexOf(ANCHOR);
  return at < 0 ? { value, fieldId: null } : { value: value.slice(0, at), fieldId: value.slice(at + ANCHOR.length) || null };
}

/** A period value counted from the page item's date field (null: from today, as it is). */
export const anchoredValue = (value: string, fieldId: string | null) => (fieldId ? `${value}${ANCHOR}${fieldId}` : value);

/**
 * A period counted from a page item's date or time (`moment`: a day or a minute), worked out. One that
 * ends now ("last n" days, months, …, or so far) ends at the moment instead: the end of its month
 * would hold the weigh-ins after it. With a time the period is in minutes. Null when it is none.
 */
export function resolveAnchored(value: string, moment: string): Period | null {
  const period = resolveRange(value, moment);
  if (!period || !(parseToDate(value) || parseRollingRange(value)?.to === 0)) return period;
  if (moment.length <= 10 && !inMinutes(period)) return { start: period.start, end: period.end < moment ? period.end : moment };
  const start = asMinute(period.start);
  const end = period.end.length > 10 ? period.end : `${period.end}T23:59`;
  const cap = asMinute(moment.length > 10 ? moment : `${moment}T23:59`);
  return { start, end: end < cap ? end : cap };
}

/** The day (yyyy-mm-dd) of a date, or the minute (yyyy-mm-ddTHH:MM) a date & time is at here, or null. */
export function momentOfValue(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  if (DAY.test(v)) return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : formatMinute(new Date(t));
}
