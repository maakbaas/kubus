import { createHash } from "node:crypto";
import ICAL from "ical.js";
import type { SourceColumn, SourceCondition, SourceDescription, SourceFilter, SourceQuery, SourceResult, SourceRow, SourceRowRequest, SourceTable, SourceTarget } from "../../../shared/sources.ts";
import { SourceError, type Connector, type SourceConfig } from "./connector.ts";
import { documentAddress, fetchDocument, hasSecretPlace, withSecret, type HttpDocument } from "./httpDocument.ts";
import { requiredRules } from "./influxFlux.ts";
import { findRow, queryRows, type MemoryRow } from "./memory.ts";

// A calendar subscription (an ICS file: webcal://, webcals:// or https://), read-only, as one table
// `events` (schema null). Its field is the address; the secret fills `{secret}` in it (a calendar's
// private address carries its secret in the path), else a set one goes as `Authorization: Bearer`.
// One GET (httpDocument.ts: kept a minute, revalidated), parsed by ical.js, queried in memory (memory.ts).
//
// A row is an occurrence: a single event, or one of a repeating event's (RRULE / RDATE, less EXDATE;
// a RECURRENCE-ID override in its place, wherever it moved to). Repeating events are expanded only
// over the dates the query's filter keeps (its rules on the start or end, all of which a row meets),
// else a year back and ahead of now, at most MAX_ROWS rows. Times in the event's VTIMEZONE, else its
// TZID as an IANA zone, else (floating) as UTC; start / end as ISO UTC. An all-day event has no start
// or end time: its days are its start date and end date (inclusive: DTEND, exclusive, a day earlier),
// which for a timed event are the days it starts and ends on where the calendar has it. The key is
// the UID and the occurrence's start (`uid@2026-03-01T09:00:00.000Z`, `uid@2026-03-01` all day), so an
// item page finds its occurrence by expanding around that start.

/** The most rows (occurrences) a query reads. */
export const MAX_ROWS = 50_000;
/** The most occurrences one repeating event is stepped through (from its first). */
const MAX_STEPS = 200_000;
const DAY_MS = 86_400_000;
const YEAR_MS = 366 * DAY_MS;
const TABLE = "events";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Time = InstanceType<typeof ICAL.Time>;
type IcalEvent = InstanceType<typeof ICAL.Event>;
type Component = InstanceType<typeof ICAL.Component>;

export const ICS_COLUMNS: SourceColumn[] = [
  { name: "title", type: "SUMMARY", kind: "string" },
  { name: "start", type: "DTSTART", kind: "datetime" },
  { name: "end", type: "DTEND", kind: "datetime" },
  { name: "all-day", type: "VALUE=DATE", kind: "checkbox" },
  { name: "start date", type: "DTSTART", kind: "date" },
  { name: "end date", type: "DTEND", kind: "date" },
  { name: "location", type: "LOCATION", kind: "string" },
  { name: "description", type: "DESCRIPTION", kind: "string" },
  { name: "status", type: "STATUS", kind: "string" },
  { name: "categories", type: "CATEGORIES", kind: "string_list" },
  { name: "recurring", type: "RRULE", kind: "checkbox" },
  { name: "url", type: "URL", kind: "string" },
  { name: "organizer", type: "ORGANIZER", kind: "string" },
  { name: "uid", type: "UID", kind: "string", hidden: true },
  { name: "id", type: "UID@start", kind: "string", hidden: true },
];
const COLUMNS = new Map(ICS_COLUMNS.map((c) => [c.name, c]));
/** The columns whose rules bound the dates read. */
const DATE_COLUMNS = new Set(["start", "end", "start date", "end date"]);

/** The dates repeating events are expanded over, in ms since 1970: an occurrence overlapping them is read. */
export interface Window {
  from: number;
  to: number;
}

/** A rule's day bounds (as UTC days: the window's margin covers any time zone). */
function boundsOf(rule: SourceFilter): { from?: number; to?: number } | null {
  const value = rule.value.trim();
  const at = (day: string, days = 0) => Date.parse(`${day}T00:00:00Z`) + days * DAY_MS;
  if (rule.operator === "between") {
    const [start, end] = value.split("..");
    return DAY.test(start ?? "") && DAY.test(end ?? "") ? { from: at(start), to: at(end, 1) } : null;
  }
  if (!DAY.test(value)) return null;
  if (rule.operator === "is") return { from: at(value), to: at(value, 1) };
  if (rule.operator === "before") return { to: at(value) };
  if (rule.operator === "after") return { from: at(value, 1) };
  return null;
}

/**
 * The window a filter leaves: its rules on the start or end that every row meets (an end after a
 * day means the occurrence ends after it, a start before one that it starts before it: either way it
 * overlaps). Unbounded sides a year beyond now (or the other bound); a day's margin either way, for
 * the device's time zone and the event's own.
 */
export function windowOf(filter: SourceCondition, now = Date.now()): Window {
  let from = -Infinity;
  let to = Infinity;
  for (const rule of requiredRules(filter)) {
    if (!DATE_COLUMNS.has(rule.column)) continue;
    const b = boundsOf(rule);
    if (b?.from !== undefined) from = Math.max(from, b.from);
    if (b?.to !== undefined) to = Math.min(to, b.to);
  }
  if (from === -Infinity) from = Math.min(to, now) - YEAR_MS;
  if (to === Infinity) to = Math.max(from, now) + YEAR_MS;
  return { from: from - DAY_MS, to: Math.max(from, to) + DAY_MS };
}

const knownZones = new Map<string, Intl.DateTimeFormat | null>();
/** An IANA time zone's format, or null when it isn't one. */
function zoneFormat(tz: string): Intl.DateTimeFormat | null {
  if (!knownZones.has(tz)) {
    let format: Intl.DateTimeFormat | null = null;
    try {
      format = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    } catch {
      // Not an IANA zone ("W. Europe Standard Time" without its VTIMEZONE).
    }
    knownZones.set(tz, format);
  }
  return knownZones.get(tz)!;
}

/** The moment a wall-clock time (as UTC ms) is in an IANA zone. */
function zoned(wall: number, format: Intl.DateTimeFormat): number {
  const offset = (at: number) => {
    const p = Object.fromEntries(format.formatToParts(at).map((x) => [x.type, Number(x.value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
  };
  return wall - offset(wall - offset(wall));
}

/** A time's wall clock, as if UTC. */
const wallOf = (t: Time) => Date.UTC(t.year, t.month - 1, t.day, t.isDate ? 0 : t.hour, t.isDate ? 0 : t.minute, t.isDate ? 0 : t.second);

/** A time's moment: in its zone (UTC, a VTIMEZONE), else its TZID as an IANA zone, else its wall clock as UTC. */
function momentOf(t: Time, tzid: string | null): number {
  if (t.zone && t.zone.tzid !== "floating") return t.toUnixTime() * 1000;
  const format = tzid ? zoneFormat(tzid) : null;
  return format ? zoned(wallOf(t), format) : wallOf(t);
}

const dayText = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** What a VEVENT says besides its times (shared by a repeating event's occurrences). */
function detailsOf(c: Component, uid: string, recurring: boolean): MemoryRow {
  const text = (name: string) => {
    const v = c.getFirstPropertyValue(name);
    return v === null || v === undefined || String(v) === "" ? null : String(v);
  };
  const organizer = c.getFirstProperty("organizer");
  const cn = organizer?.getParameter("cn");
  const email = organizer ? String(organizer.getFirstValue() ?? "").replace(/^mailto:/i, "") : "";
  return {
    title: text("summary"),
    location: text("location"),
    description: text("description"),
    status: text("status"),
    categories: c.getAllProperties("categories").flatMap((p) => p.getValues().map(String)).filter((x) => x.trim() !== ""),
    recurring,
    url: text("url"),
    organizer: (typeof cn === "string" && cn) || email || null,
    uid,
  };
}

/** One occurrence as a row: its details, its times and its key. */
function occurrence(details: MemoryRow, startTime: Time, endTime: Time | null, tzid: string | null, endTzid: string | null): { row: MemoryRow; start: number; end: number } {
  const allDay = startTime.isDate;
  const startWall = wallOf(startTime);
  if (allDay) {
    // DTEND is the day after the last (none: one day).
    const endWall = Math.max(endTime ? wallOf(endTime) : startWall + DAY_MS, startWall + DAY_MS);
    const row: MemoryRow = { ...details, start: null, end: null, "all-day": true, "start date": dayText(startWall), "end date": dayText(endWall - DAY_MS) };
    row.id = `${details.uid}@${dayText(startWall)}`;
    return { row, start: startWall, end: endWall };
  }
  const start = momentOf(startTime, tzid);
  const end = Math.max(endTime ? momentOf(endTime, endTzid ?? tzid) : start, start);
  // An end at midnight is on the day before (a meeting until 00:00), unless it is the start too.
  let endWall = endTime ? Math.max(wallOf(endTime), startWall) : startWall;
  if (endWall > startWall && endWall % DAY_MS === 0) endWall -= DAY_MS;
  const row: MemoryRow = { ...details, start: new Date(start).toISOString(), end: new Date(end).toISOString(), "all-day": false, "start date": dayText(startWall), "end date": dayText(endWall) };
  row.id = `${details.uid}@${row.start}`;
  return { row, start, end };
}

const tzidOf = (c: Component, name: string): string | null => {
  const v = c.getFirstProperty(name)?.getParameter("tzid");
  return typeof v === "string" ? v : null;
};

/** A repeating event: expanded per window. */
interface Repeating {
  event: IcalEvent;
  details: MemoryRow;
  tzid: string | null;
  endTzid: string | null;
}

/** A parsed calendar: its single events' rows (read whatever the window), its repeating events. */
export interface Calendar {
  singles: MemoryRow[];
  repeating: Repeating[];
  /** VEVENTs left out (no start, a bad rule). */
  skipped: number;
  /** TZIDs neither defined nor known, read as UTC. */
  unknownZones: string[];
  /** The last windows' rows. */
  expanded: Map<string, MemoryRow[]>;
}

/** An ICS document as a calendar; a document that isn't one is the source's problem. */
export function parseCalendar(text: string): Calendar {
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("The address doesn't answer with a calendar (there is no BEGIN:VCALENDAR)");
  let roots: Component[];
  try {
    const parsed = ICAL.parse(text);
    // Several VCALENDARs in one file: an array of them.
    const list = (Array.isArray(parsed) && Array.isArray(parsed[0]) ? parsed : [parsed]) as unknown[];
    roots = list.map((jcal) => new ICAL.Component(jcal as unknown[]));
  } catch (e) {
    throw new Error(`The calendar can't be read: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  const masters: Component[] = [];
  const overrides = new Map<string, Component[]>();
  const uidOf = (c: Component) => {
    const uid = c.getFirstPropertyValue("uid");
    if (uid) return String(uid);
    // None (RFC 5545 wants one): one of its own, the same on every read.
    return createHash("sha1").update(`${c.getFirstPropertyValue("summary") ?? ""} ${c.getFirstProperty("dtstart")?.toICALString() ?? ""}`).digest("hex").slice(0, 16);
  };
  for (const root of roots) {
    for (const c of root.getAllSubcomponents("vevent")) {
      if (c.hasProperty("recurrence-id")) {
        const uid = uidOf(c);
        overrides.set(uid, [...(overrides.get(uid) ?? []), c]);
      } else masters.push(c);
    }
  }
  const calendar: Calendar = { singles: [], repeating: [], skipped: 0, unknownZones: [], expanded: new Map() };
  const zones = new Set<string>();
  const noteZone = (t: Time, tzid: string | null) => {
    if (tzid && (!t.zone || t.zone.tzid === "floating") && !zoneFormat(tzid)) zones.add(tzid);
  };
  const single = (c: Component, uid: string) => {
    const event = new ICAL.Event(c, { exceptions: [] });
    const start = event.startDate;
    if (!start) throw new Error("no DTSTART");
    const tzid = tzidOf(c, "dtstart");
    noteZone(start, tzid);
    calendar.singles.push(occurrence(detailsOf(c, uid, c.hasProperty("recurrence-id")), start, event.endDate, tzid, tzidOf(c, "dtend")).row);
  };
  const seenUids = new Set<string>();
  for (const c of masters) {
    const uid = uidOf(c);
    seenUids.add(uid);
    try {
      if (c.hasProperty("rrule") || c.hasProperty("rdate")) {
        const event = new ICAL.Event(c, { exceptions: overrides.get(uid) ?? [] });
        if (!event.startDate) throw new Error("no DTSTART");
        const tzid = tzidOf(c, "dtstart");
        noteZone(event.startDate, tzid);
        calendar.repeating.push({ event, details: detailsOf(c, uid, true), tzid, endTzid: tzidOf(c, "dtend") });
      } else {
        // A single event with an override of itself: the override.
        const own = (overrides.get(uid) ?? []).filter((o) => String(o.getFirstPropertyValue("recurrence-id")) !== String(c.getFirstPropertyValue("dtstart")));
        if (own.length === (overrides.get(uid) ?? []).length) single(c, uid);
        for (const o of overrides.get(uid) ?? []) single(o, uid);
      }
    } catch {
      calendar.skipped++;
    }
  }
  // Overrides whose repeating event isn't in the file: events of their own.
  for (const [uid, list] of overrides) {
    if (seenUids.has(uid)) continue;
    for (const o of list) {
      try {
        single(o, uid);
      } catch {
        calendar.skipped++;
      }
    }
  }
  if (calendar.singles.length > MAX_ROWS) throw new Error(`The calendar has more than ${MAX_ROWS.toLocaleString("en")} events, more than a source reads`);
  calendar.unknownZones = [...zones].sort();
  return calendar;
}

/** Whether a repeating event's occurrence (its recurrence id) is overridden by a RECURRENCE-ID of its own. */
function overridden(event: IcalEvent, at: Time): boolean {
  if (at.toString() in event.exceptions) return true;
  return at.convertToZone(ICAL.Timezone.utcTimezone).toString() in event.exceptions;
}

/** The calendar's rows over a window: its single events, and its repeating events' occurrences that overlap the window. */
export function rowsOf(calendar: Calendar, window: Window): MemoryRow[] {
  const cacheKey = `${window.from} ${window.to}`;
  const have = calendar.expanded.get(cacheKey);
  if (have) return have;
  const rows = [...calendar.singles];
  const tooMany = () =>
    new SourceError(`More than ${MAX_ROWS.toLocaleString("en")} events from ${dayText(window.from)} to ${dayText(window.to)}: filter by a shorter range of start dates`);
  const add = (o: { row: MemoryRow; start: number; end: number }) => {
    if (o.start >= window.to || o.end < window.from) return;
    if (rows.length >= MAX_ROWS) throw tooMany();
    rows.push(o.row);
  };
  for (const r of calendar.repeating) {
    try {
      const it = r.event.iterator();
      let steps = 0;
      for (let at = it.next(); at && steps < MAX_STEPS; at = it.next(), steps++) {
        if (overridden(r.event, at)) continue;
        // A RANGE=THISANDFUTURE override shifts this one and gives its details.
        const d = r.event.getOccurrenceDetails(at);
        const details = d.item === r.event ? r.details : detailsOf(d.item.component, r.details.uid as string, true);
        const o = occurrence(details, d.startDate, d.endDate, r.tzid, r.endTzid);
        if (o.start >= window.to) break;
        add(o);
      }
      // The overrides, wherever they moved to.
      for (const ex of Object.values(r.event.exceptions)) {
        const c = ex.component;
        add(occurrence(detailsOf(c, r.details.uid as string, true), ex.startDate, ex.endDate, tzidOf(c, "dtstart") ?? r.tzid, tzidOf(c, "dtend")));
      }
    } catch (e) {
      if (e instanceof SourceError) throw e;
      // A rule ical.js can't step through: the occurrences found so far.
    }
  }
  // A key twice (a file listing an event twice): the first.
  const seen = new Set<string>();
  const unique = rows.filter((row) => !seen.has(row.id as string) && (seen.add(row.id as string), true));
  calendar.expanded.set(cacheKey, unique);
  while (calendar.expanded.size > 8) calendar.expanded.delete(calendar.expanded.keys().next().value!);
  return unique;
}

/** Whether a Content-Type can be a calendar (servers often send ICS as text or bytes). */
const isCalendarType = (t: string) => /^(text\/calendar|text\/x-vcalendar|application\/ics|text\/plain|application\/octet-stream)\b/.test(t);

const parsed = new WeakMap<HttpDocument, Calendar>();

export class IcsConnector implements Connector {
  readonly kind = "ics";
  private config: SourceConfig;
  private url: string;
  private headers: Record<string, string>;

  constructor(config: SourceConfig) {
    this.config = config;
    const address = documentAddress(config.fields.address ?? "");
    if (hasSecretPlace(address)) {
      if (!config.password) throw new SourceError("The address has {secret} in it, but there is no secret");
      this.url = withSecret(address, config.password);
      this.headers = {};
    } else {
      this.url = address.toString();
      this.headers = config.password ? { Authorization: `Bearer ${config.password}` } : {};
    }
  }

  private async calendar(): Promise<Calendar> {
    const doc = await fetchDocument(this.url, { headers: this.headers, timeoutMs: this.config.timeoutMs, what: "a calendar", accepts: isCalendarType });
    let calendar = parsed.get(doc);
    if (!calendar) {
      calendar = parseCalendar(doc.text);
      parsed.set(doc, calendar);
    }
    return calendar;
  }

  private target(target: SourceTarget) {
    if ("query" in target) throw new SourceError(`${this.config.name} is read by its table only (${TABLE}: a calendar has no query language)`);
    if (target.table.name !== TABLE || target.table.schema !== null) throw new SourceError(`${this.config.name} has no table “${target.table.name}” (only ${TABLE})`);
  }

  async check(): Promise<string[]> {
    const calendar = await this.calendar();
    const warnings: string[] = [];
    if (!calendar.singles.length && !calendar.repeating.length) warnings.push("The calendar has no events");
    if (calendar.skipped) warnings.push(`${calendar.skipped} of its events can't be read and are left out`);
    if (calendar.unknownZones.length) warnings.push(`Its time zones ${calendar.unknownZones.join(", ")} aren't defined in it or known: their times are read as UTC`);
    return warnings;
  }

  async tables(): Promise<SourceTable[]> {
    return [{ schema: null, name: TABLE, type: "calendar" }];
  }

  async describe(target: SourceTarget): Promise<SourceDescription> {
    this.target(target);
    return { columns: ICS_COLUMNS, key: ["id"], dropped: [] };
  }

  async query(query: SourceQuery): Promise<SourceResult> {
    this.target(query.target);
    return queryRows(rowsOf(await this.calendar(), windowOf(query.filter)), COLUMNS, query);
  }

  async row(request: SourceRowRequest): Promise<SourceRow | null> {
    this.target(request.target);
    // The key's start (after the UID, which may have an @ itself): its occurrence is found around it.
    const at = Date.parse(request.keyValue.slice(request.keyValue.lastIndexOf("@") + 1));
    if (request.key === "id" && Number.isNaN(at)) return null;
    const window = request.key === "id" ? { from: at - 2 * DAY_MS, to: at + 2 * DAY_MS } : windowOf({ and: [] });
    return findRow(rowsOf(await this.calendar(), window), COLUMNS, request);
  }

  async close() {}
}
