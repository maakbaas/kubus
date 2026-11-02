import { wallTime } from "../../../shared/sources.ts";
import { SourceError } from "./connector.ts";

// Time zones for the connectors: the day or minute a moment is on in the device's zone, and when a
// day starts there. One formatter per zone, cached (making one costs far more than using it).

const formats = new Map<string, Intl.DateTimeFormat>();

/** An IANA time zone's format, or null when it isn't one (an iCalendar TZID may be a Windows name). */
export function zoneFormat(tz: string): Intl.DateTimeFormat | null {
  let format = formats.get(tz);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
    } catch {
      return null; // not cached: a query's zone comes from outside
    }
    formats.set(tz, format);
  }
  return format;
}

/** A time zone's format; an unknown zone is refused. */
export function formatIn(tz: string): Intl.DateTimeFormat {
  const format = zoneFormat(tz);
  if (!format) throw new SourceError(`Unknown time zone “${tz}”`);
  return format;
}

/** The wall clock's parts (year, month, …, as text) at a moment. */
const partsOf = (format: Intl.DateTimeFormat, at: number): Record<string, string> =>
  Object.fromEntries(format.formatToParts(at).map((x) => [x.type, x.value]));

/** How far the zone is ahead of UTC at a moment, in milliseconds. */
function offsetOf(format: Intl.DateTimeFormat, at: number): number {
  const p = partsOf(format, at);
  const n = (type: string) => Number(p[type] ?? 0);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(at / 1000) * 1000;
}

/** The moment a wall-clock time (as UTC ms) is in the zone; in a gap (spring forward) the hour after it. */
export function zoned(wall: number, tz: string): number {
  const format = formatIn(tz);
  return wall - offsetOf(format, wall - offsetOf(format, wall));
}

/** The moment a day (yyyy-mm-dd) or minute (yyyy-mm-ddTHH:MM) starts in the time zone, `days` days (minutes) later than it, in ms since 1970. */
export const dayStart = (day: string, tz: string, days = 0): number => zoned(wallTime(day, days), tz);

/** The day (yyyy-mm-dd) a moment is on in the time zone. */
export function dayIn(at: number, tz: string): string {
  const p = partsOf(formatIn(tz), at);
  return `${p.year.padStart(4, "0")}-${p.month}-${p.day}`;
}

/** The minute (yyyy-mm-ddTHH:MM) an ISO date & time is at in a time zone (its first 10: its day); null if it isn't one. */
export function minuteIn(tz: string): (iso: string) => string | null {
  const format = formatIn(tz); // an unknown zone is refused up front, rows or not
  return (iso) => {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    const p = partsOf(format, t);
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  };
}

// --- A zone's offsets as a table, for SQL that has no time zones (D1, MySQL without its zone tables) ---

/** The offset (minutes) of a time zone at an instant (ms), to the minute. */
function offsetMinutes(format: Intl.DateTimeFormat, at: number): number {
  const p = partsOf(format, at);
  const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
  return Math.round((local - Math.floor(at / 60_000) * 60_000) / 60_000);
}

const FIRST_YEAR = 1990;
const LAST_YEAR = 2060;
const zones = new Map<string, { from: number; minutes: number }[]>();

/**
 * A time zone's offsets from 1990 to 2060: each from when (Unix seconds) and how many minutes
 * (outside those years the nearest applies). Unknown zones are refused.
 */
export function zoneOffsets(tz: string): { from: number; minutes: number }[] {
  const known = zones.get(tz);
  if (known) return known;
  const format = formatIn(tz);
  const week = 7 * 86_400_000;
  let at = Date.UTC(FIRST_YEAR, 0, 1);
  const end = Date.UTC(LAST_YEAR, 0, 1);
  const offsets = [{ from: -Infinity, minutes: offsetMinutes(format, at) }];
  for (; at < end; at += week) {
    const next = offsetMinutes(format, at + week);
    if (next === offsets[offsets.length - 1].minutes) continue;
    // The change is within the week: found to the minute.
    let [lo, hi] = [at, at + week];
    while (hi - lo > 60_000) {
      const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
      if (offsetMinutes(format, mid) === next) hi = mid;
      else lo = mid;
    }
    offsets.push({ from: hi / 1000, minutes: next });
  }
  zones.set(tz, offsets);
  return offsets;
}
