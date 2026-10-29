// Grouping by a date or date & time field: by its year, month, week (Sunday to Saturday, week 1 holds
// 1 January: `weekNumber` of the date filter), day or hour (date & time only). A group's key sorts as the time
// does ("2026", "2026-10", "2026-W44", "2026-10-28", "2026-10-28T14"), so groups order
// chronologically by key; its label reads out ("2026", "October 2026", "Week 44, 2026", "28 Oct 2026",
// "28 Oct 2026, 14:00"). Storage-free and UI-free.

import { addDays, weekNumber, weekStart } from "./datePeriod";

export type GroupDate = "year" | "month" | "week" | "day" | "hour";

/** The ways to group by a date, as the Group by panel lists them; `hour` is of a date & time only. */
export const GROUP_DATES: readonly { value: GroupDate; text: string }[] = [
  { value: "year", text: "Year" },
  { value: "month", text: "Month" },
  { value: "week", text: "Week" },
  { value: "day", text: "Day" },
  { value: "hour", text: "Hour" },
];

/** What a group of a date field is by when none is chosen. */
export const DEFAULT_GROUP_DATE: GroupDate = "day";

/** A stored value made valid (anything else, and the default, day: absent). */
export const parseGroupDate = (v: unknown): GroupDate | undefined => (v === "year" || v === "month" || v === "week" || v === "hour" ? v : undefined);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const dayText = (year: number, month: number, day: number) => `${pad(year, 4)}-${pad(month)}-${pad(day)}`;

/** The group a moment (month 1 to 12; an hour 0 to 23 for a date & time) falls in. `hour` of a date (no hour) is its day. */
export function dateGroup(year: number, month: number, day: number, hour: number | null, by: GroupDate = DEFAULT_GROUP_DATE): { key: string; label: string } {
  const dayKey = dayText(year, month, day);
  const dayLabel = `${day} ${MONTHS[month - 1].slice(0, 3)} ${year}`;
  if (by === "year") return { key: pad(year, 4), label: String(year) };
  if (by === "month") return { key: `${pad(year, 4)}-${pad(month)}`, label: `${MONTHS[month - 1]} ${year}` };
  if (by === "week") {
    const w = weekNumber(dayKey);
    return { key: `${pad(w.year, 4)}-W${pad(w.week)}`, label: `Week ${w.week}, ${w.year}` };
  }
  if (by === "hour" && hour !== null) return { key: `${dayKey}T${pad(hour)}`, label: `${dayLabel}, ${pad(hour)}:00` };
  return { key: dayKey, label: dayLabel };
}

/** The label of a date group by its key (any of the five shapes); the key itself when it is none. */
export function dateGroupLabel(key: string): string {
  let m = /^(\d{4})$/.exec(key);
  if (m) return dateGroup(+m[1], 1, 1, null, "year").label;
  m = /^(\d{4})-(\d{2})$/.exec(key);
  if (m) return dateGroup(+m[1], +m[2], 1, null, "month").label;
  m = /^(\d{4})-W(\d{2})$/.exec(key);
  if (m) return `Week ${+m[2]}, ${+m[1]}`;
  m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}))?$/.exec(key);
  if (m) return dateGroup(+m[1], +m[2], +m[3], m[4] === undefined ? null : +m[4], m[4] === undefined ? "day" : "hour").label;
  return key;
}

/** The date a new item in a group of a date field gets: the group's first day ("2026" 1 January, "2026-W44" its Sunday). */
export function dateGroupValue(key: string): string {
  if (/^\d{4}$/.test(key)) return `${key}-01-01`;
  if (/^\d{4}-\d{2}$/.test(key)) return `${key}-01`;
  const w = /^(\d{4})-W(\d{2})$/.exec(key);
  if (w) {
    return addDays(weekStart(`${w[1]}-01-01`), (+w[2] - 1) * 7);
  }
  return key.slice(0, 10);
}
