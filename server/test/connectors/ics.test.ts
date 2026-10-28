// @vitest-environment node
// The calendar (ICS) connector (server/src/connectors/ics.ts) against a stand-in server.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { forgetDocuments } from "../../src/connectors/httpDocument.ts";
import { IcsConnector, MAX_ROWS, parseCalendar, rowsOf, windowOf } from "../../src/connectors/ics.ts";
import type { SourceCondition, SourceQuery } from "../../../shared/sources.ts";

const ics = (...lines: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", ...lines, "END:VCALENDAR", ""].join("\r\n");

const AMSTERDAM = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Amsterdam",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

const CALENDAR = ics(
  ...AMSTERDAM,
  // Weekly on Mondays 09:00 Amsterdam, ten times; not on 9 March; 16 March moved to Tuesday 17th 14:00.
  "BEGIN:VEVENT",
  "UID:standup-1@example.com",
  "SUMMARY:Standup",
  "DTSTART;TZID=Europe/Amsterdam:20260302T090000",
  "DTEND;TZID=Europe/Amsterdam:20260302T093000",
  "RRULE:FREQ=WEEKLY;COUNT=10",
  "EXDATE;TZID=Europe/Amsterdam:20260309T090000",
  "CATEGORIES:Work,Daily",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:standup-1@example.com",
  "RECURRENCE-ID;TZID=Europe/Amsterdam:20260316T090000",
  "SUMMARY:Standup (moved)",
  "DTSTART;TZID=Europe/Amsterdam:20260317T140000",
  "DTEND;TZID=Europe/Amsterdam:20260317T143000",
  "END:VEVENT",
  // All day, 1 to 3 April (DTEND exclusive).
  "BEGIN:VEVENT",
  "UID:trip",
  "SUMMARY:Trip",
  "DTSTART;VALUE=DATE:20260401",
  "DTEND;VALUE=DATE:20260404",
  "LOCATION:Lisbon",
  "END:VEVENT",
  // All day, no DTEND: one day.
  "BEGIN:VEVENT",
  "UID:holiday",
  "SUMMARY:Holiday",
  "DTSTART;VALUE=DATE:20260410",
  "END:VEVENT",
  // Every year since 2000.
  "BEGIN:VEVENT",
  "UID:bday",
  "SUMMARY:Birthday",
  "DTSTART;VALUE=DATE:20000505",
  "RRULE:FREQ=YEARLY",
  "END:VEVENT",
  // A TZID with no VTIMEZONE: read as the IANA zone.
  "BEGIN:VEVENT",
  "UID:call",
  "SUMMARY:Call",
  "DTSTART;TZID=America/New_York:20260701T090000",
  "DTEND;TZID=America/New_York:20260701T100000",
  "STATUS:CONFIRMED",
  "ORGANIZER;CN=Ann:mailto:ann@example.com",
  "URL:https://example.com/call",
  "DESCRIPTION:Talk\\, then plan",
  "END:VEVENT",
  // Until midnight: ends on its day.
  "BEGIN:VEVENT",
  "UID:late",
  "SUMMARY:Late",
  "DTSTART:20260601T220000Z",
  "DTEND:20260602T000000Z",
  "END:VEVENT",
);

const MANY = ics("BEGIN:VEVENT", "UID:tick", "SUMMARY:Tick", "DTSTART:20261001T000000Z", "RRULE:FREQ=MINUTELY", "END:VEVENT");

let server: Server;
let base = "";
const seen: IncomingMessage[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(req);
    const path = req.url ?? "/";
    if (path === "/cal.ics") return res.writeHead(200, { "Content-Type": "text/calendar; charset=utf-8" }).end(CALENDAR);
    if (path === "/plain.ics") return res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(CALENDAR);
    if (path === "/many.ics") return res.writeHead(200, { "Content-Type": "text/calendar" }).end(MANY);
    if (path === "/empty.ics") return res.writeHead(200, { "Content-Type": "text/calendar" }).end(ics());
    if (path === "/private/s%2F1/basic.ics") return res.writeHead(200, { "Content-Type": "text/calendar" }).end(CALENDAR);
    if (path === "/login") return res.writeHead(200, { "Content-Type": "text/html" }).end("<html></html>");
    if (path === "/hello") return res.writeHead(200, { "Content-Type": "text/plain" }).end("hello");
    if (path === "/broken.ics") return res.writeHead(200, { "Content-Type": "text/calendar" }).end("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nnonsense\r\n");
    if (path === "/bearer.ics") return res.writeHead(req.headers.authorization === "Bearer pw" ? 200 : 401, { "Content-Type": "text/calendar" }).end(CALENDAR);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  forgetDocuments();
  seen.length = 0;
});

const source = (path = "/cal.ics", password = "") => new IcsConnector({ name: "Calendar", kind: "ics", fields: { address: `${base}${path}` }, password, schemas: [], timeoutMs: 2000 });
const events = (over: Partial<SourceQuery> = {}): SourceQuery => ({
  target: { table: { schema: null, name: "events" } },
  key: "id",
  columns: ["title", "start", "end", "all-day", "start date", "end date"],
  title: ["title"],
  untitled: "Event",
  filter: { and: [] },
  search: "",
  sort: [{ column: "start", direction: "asc" }],
  groupBy: null,
  groupOrder: "asc",
  timeZone: "Europe/Amsterdam",
  offset: 0,
  limit: 500,
  counts: true,
  ...over,
});
const titled = (text: string, ...more: SourceCondition[]): SourceCondition => ({ and: [{ column: "title", operator: "contains", value: text }, ...more] });

describe("IcsConnector", () => {
  it("offers one table, events", async () => {
    const c = source();
    expect(await c.tables()).toEqual([{ schema: null, name: "events", type: "calendar" }]);
    const d = await c.describe({ table: { schema: null, name: "events" } });
    expect(d.key).toEqual(["id"]);
    expect(d.columns.map((x) => x.name)).toContain("categories");
    await expect(c.describe({ query: "x" })).rejects.toThrow(/its table only/);
    await expect(c.describe({ table: { schema: null, name: "todos" } })).rejects.toThrow(/no table/);
    expect(await c.check()).toEqual([]);
  });

  it("expands a weekly event: an EXDATE left out, an override moved, across the change to summer time", async () => {
    const r = await source().query(events({ filter: titled("standup", { column: "start date", operator: "between", value: "2026-03-01..2026-03-31" }), columns: ["title", "start", "end", "recurring", "categories"] }));
    expect(r.rows.map((x) => x.values)).toEqual([
      ["Standup", "2026-03-02T08:00:00.000Z", "2026-03-02T08:30:00.000Z", true, ["Work", "Daily"]],
      ["Standup (moved)", "2026-03-17T13:00:00.000Z", "2026-03-17T13:30:00.000Z", true, []],
      ["Standup", "2026-03-23T08:00:00.000Z", "2026-03-23T08:30:00.000Z", true, ["Work", "Daily"]],
      ["Standup", "2026-03-30T07:00:00.000Z", "2026-03-30T07:30:00.000Z", true, ["Work", "Daily"]],
    ]);
    expect(r.rows[3].key).toBe("standup-1@example.com@2026-03-30T07:00:00.000Z");
    expect(r.total).toBe(4);
    // Ten less the one left out.
    expect((await source().query(events({ filter: titled("standup") }))).total).toBe(9);
  });

  it("reads all-day events by their days, the end date inclusive", async () => {
    const r = await source().query(events({ filter: { or: [titled("trip"), titled("holiday")] }, sort: [{ column: "start date", direction: "asc" }] }));
    expect(r.rows.map((x) => x.values)).toEqual([
      ["Trip", null, null, true, "2026-04-01", "2026-04-03"],
      ["Holiday", null, null, true, "2026-04-10", "2026-04-10"],
    ]);
    expect(r.rows[0].key).toBe("trip@2026-04-01");
  });

  it("reads a zone it doesn't define as the IANA zone, and the rest of an event", async () => {
    const r = await source("/plain.ics").query(
      events({ filter: { or: [titled("call"), titled("late")] }, columns: ["title", "start", "end", "start date", "end date", "status", "organizer", "url", "description"] }),
    );
    expect(r.rows.map((x) => x.values)).toEqual([
      ["Late", "2026-06-01T22:00:00.000Z", "2026-06-02T00:00:00.000Z", "2026-06-01", "2026-06-01", null, null, null, null],
      ["Call", "2026-07-01T13:00:00.000Z", "2026-07-01T14:00:00.000Z", "2026-07-01", "2026-07-01", "CONFIRMED", "Ann", "https://example.com/call", "Talk, then plan"],
    ]);
  });

  it("expands repeating events over the filter's dates, else 20 years back and a year ahead of now", async () => {
    const far = await source().query(events({ filter: titled("birthday", { column: "start date", operator: "is", value: "2040-05-05" }) }));
    expect(far.rows.map((x) => x.key)).toEqual(["bday@2040-05-05"]);
    const near = await source().query(events({ filter: titled("birthday") }));
    // The yearly birthday (from 2000) from 20 years back to a year ahead (a day either way).
    const day = 86_400_000;
    let birthdays = 0;
    for (let y = 2000; Date.parse(`${y}-05-05T00:00:00Z`) <= Date.now() + 366 * day; y++) if (Date.parse(`${y}-05-05T00:00:00Z`) >= Date.now() - 20 * 366 * day) birthdays++;
    expect(near.total).toBeGreaterThanOrEqual(birthdays - 1);
    expect(near.total).toBeLessThanOrEqual(birthdays + 1);
    // Single events whatever the dates.
    expect((await source().query(events({ filter: titled("trip") }))).total).toBe(1);
    expect(windowOf({ and: [{ column: "end date", operator: "after", value: "2030-01-01" }, { column: "start", operator: "before", value: "2030-02-01" }] })).toEqual({
      from: Date.parse("2030-01-01T00:00:00Z"),
      to: Date.parse("2030-02-02T00:00:00Z"),
    });
    // A bound under an or doesn't narrow.
    const now = Date.parse("2026-10-28T00:00:00Z");
    const w = windowOf({ or: [{ column: "start date", operator: "is", value: "2040-01-01" }, titled("x")] }, now);
    expect(w.from).toBeLessThan(now - 20 * 365 * 86_400_000);
    expect(w.to).toBeLessThan(now + 2 * 366 * 86_400_000);
  });

  it("keeps an open side's bound the same all day (the window is the expansion's cache key)", () => {
    const morning = windowOf({ and: [] }, Date.parse("2026-10-28T00:00:01Z"));
    expect(windowOf({ and: [] }, Date.parse("2026-10-28T23:59:59Z"))).toEqual(morning);
    expect(morning.from % 86_400_000).toBe(0);
    expect(morning.to % 86_400_000).toBe(0);
    expect(windowOf({ and: [] }, Date.parse("2026-10-29T00:00:01Z"))).not.toEqual(morning);
  });

  it("finds an occurrence by its key, even outside the year around now", async () => {
    const c = source();
    const shape = { target: { table: { schema: null, name: "events" } }, key: "id", columns: ["title", "start date"], title: ["title"], untitled: "Event" };
    expect(await c.row({ ...shape, keyValue: "bday@2010-05-05" })).toEqual({ key: "bday@2010-05-05", values: ["Birthday", "2010-05-05"] });
    expect(await c.row({ ...shape, keyValue: "standup-1@example.com@2026-03-17T13:00:00.000Z" })).toEqual({
      key: "standup-1@example.com@2026-03-17T13:00:00.000Z",
      values: ["Standup (moved)", "2026-03-17"],
    });
    expect(await c.row({ ...shape, keyValue: "standup-1@example.com@2026-03-09T08:00:00.000Z" })).toBeNull();
    expect(await c.row({ ...shape, keyValue: "nonsense" })).toBeNull();
  });

  it("reads at most MAX_ROWS occurrences", async () => {
    // The limit itself on a small one: MAX_ROWS minutes of occurrences take seconds on a busy machine.
    const calendar = parseCalendar(MANY);
    const window = windowOf({ column: "start date", operator: "between", value: "2026-10-01..2026-12-31" });
    expect(() => rowsOf(calendar, window, 500)).toThrow(/More than 500 events from 2026-09-30 to 2027-01-02/);
    expect(rowsOf(calendar, windowOf({ column: "start date", operator: "is", value: "2026-10-02" }), 10_000).length).toBeGreaterThanOrEqual(1440);
    expect(MAX_ROWS).toBeGreaterThan(1440);
    // And the connector, on a day of them.
    const c = source("/many.ics");
    const day = await c.query(events({ filter: { column: "start date", operator: "is", value: "2026-10-02" }, timeZone: "UTC", limit: 10 }));
    expect(day.total).toBe(1440);
  });

  it("fills {secret} in the address, else sends the secret as Bearer; only GETs", async () => {
    expect((await source("/private/{secret}/basic.ics", "s/1").query(events({ filter: titled("trip") }))).total).toBe(1);
    expect((await source("/bearer.ics", "pw").query(events({ filter: titled("trip") }))).total).toBe(1);
    await expect(source("/bearer.ics").query(events())).rejects.toThrow(/401/);
    expect(() => source("/private/{secret}/basic.ics")).toThrow(/no secret/);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.method === "GET")).toBe(true);
  });

  it("says what is wrong in words", async () => {
    await expect(source("/login").query(events())).rejects.toThrow(/web page, not a calendar/);
    await expect(source("/hello").query(events())).rejects.toThrow(/no BEGIN:VCALENDAR/);
    await expect(source("/broken.ics").check()).rejects.toThrow(/can't be read/);
    await expect(source("/nothing.ics").check()).rejects.toThrow("There is no calendar at the address (404)");
    expect(await source("/empty.ics").check()).toEqual(["The calendar has no events"]);
  });
});
