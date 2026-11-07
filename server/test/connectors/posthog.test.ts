// @vitest-environment node
// The PostHog connector (server/src/connectors/posthog.ts) against a stand-in for PostHog's query API
// (POST /api/projects/<id>/query/): the requests it makes, how it reads the answers (columns, ClickHouse
// types, values in the project's zone) and PostHog's errors. The stand-in can't run HogQL: it answers by kind
// and by which table a statement reads (the statements themselves: posthogHogql.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceError } from "../../src/connectors/connector.ts";
import { PostHogConnector, posthogEndpoint } from "../../src/connectors/posthog.ts";
import type { SourceQuery } from "../../../shared/sources.ts";

interface Sent {
  url: string;
  authorization: string | null;
  query: { kind: string; query?: string };
}

let sent: Sent[];
let answer: (q: Sent["query"]) => Response;

const SCHEMA = {
  tables: {
    events: { name: "events", type: "posthog", fields: { uuid: { name: "uuid", type: "string" }, event: { name: "event", type: "string" }, timestamp: { name: "timestamp", type: "datetime" }, person: { name: "person", type: "lazy_table" } } },
    sessions: { name: "sessions", type: "posthog", fields: { session_id: { name: "session_id", type: "string" }, $is_bounce: { name: "$is_bounce", type: "expression" } } },
    "stripe.customers": { name: "stripe.customers", type: "data_warehouse", fields: {} },
  },
};

function standIn(q: Sent["query"]): Response {
  if (q.kind === "DatabaseSchemaQuery") return Response.json(SCHEMA);
  const text = q.query ?? "";
  if (text === "SELECT 1") return Response.json({ columns: ["1"], types: [["1", "UInt8"]], results: [[1]] });
  if (text === "SELECT `uuid`, `event`, `timestamp` FROM `events` WHERE `timestamp` >= now() - INTERVAL 1 DAY LIMIT 1")
    return Response.json({ columns: ["uuid", "event", "timestamp"], types: [["uuid", "UUID"], ["event", "String"], ["timestamp", "DateTime64(6, 'Europe/Amsterdam')"]], results: [] });
  if (text.startsWith("SELECT count()")) return Response.json({ columns: ["count()"], results: [[3]] });
  if (text.includes("FROM `events`"))
    return Response.json({
      columns: ["toString(uuid)", "event", "timestamp"],
      results: [
        // Key, values, then the sort keys (a time sort's Unix seconds, the key).
        ["u1", "$pageview", "2024-07-01T10:00:00.123000+02:00", 1719820800, "u1"],
        ["u2", "signed_up", "2024-07-01T11:00:00+02:00", 1719824400, "u2"],
        ["u3", "$pageview", null, null, "u3"],
      ],
    });
  return Response.json({ type: "validation_error", detail: `Unknown table in: ${text}` }, { status: 400 });
}

beforeEach(() => {
  sent = [];
  answer = standIn;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { query: Sent["query"] };
    const s = { url, authorization: new Headers(init.headers).get("authorization"), query: body.query };
    sent.push(s);
    return answer(s.query);
  });
});

afterEach(() => vi.unstubAllGlobals());

const connector = (fields: Record<string, string> = { address: "eu.posthog.com", project: "42" }) =>
  new PostHogConnector({ name: "Analytics", kind: "posthog", fields, password: "phx_key", schemas: [], timeoutMs: 5000 });

const events = (over: Partial<SourceQuery> = {}): SourceQuery => ({
  target: { table: { schema: null, name: "events" } },
  key: "uuid",
  columns: ["event", "timestamp"],
  title: ["event"],
  untitled: "Event",
  filter: { and: [] },
  search: "",
  sort: [],
  groupBy: null,
  groupOrder: "asc",
  timeZone: "UTC",
  offset: 0,
  limit: 2,
  counts: true,
  ...over,
});

describe("PostHog connector", () => {
  it("finds the project's query endpoint", () => {
    expect(posthogEndpoint("eu.posthog.com", "42")).toBe("https://eu.posthog.com/api/projects/42/query/");
    expect(posthogEndpoint("https://us.i.posthog.com/", "")).toBe("https://us.posthog.com/api/projects/@current/query/");
    expect(posthogEndpoint("http://localhost:8000", "1")).toBe("http://localhost:8000/api/projects/1/query/");
    expect(() => posthogEndpoint("eu.posthog.com", "my project")).toThrow(SourceError);
  });

  it("sends HogQL with the key as a bearer token", async () => {
    expect(await connector().check()).toEqual([]);
    expect(sent[0]).toEqual({ url: "https://eu.posthog.com/api/projects/42/query/", authorization: "Bearer phx_key", query: { kind: "HogQLQuery", query: "SELECT 1" } });
  });

  it("lists HogQL's tables, PostHog's own first", async () => {
    expect(await connector().tables()).toEqual([
      { schema: null, name: "events", type: "table" },
      { schema: null, name: "sessions", type: "table" },
      { schema: null, name: "stripe.customers", type: "data warehouse" },
    ]);
  });

  it("lists PostHog's own tables when the schema can't be read", async () => {
    answer = (q) => (q.kind === "DatabaseSchemaQuery" ? Response.json({ detail: "Unknown query kind" }, { status: 400 }) : standIn(q));
    expect((await connector().tables()).map((t) => t.name)).toEqual(["events", "persons", "sessions", "groups"]);
  });

  it("describes a table by a probe row of its listed fields (joins left out), with its key and time", async () => {
    const d = await connector().describe({ table: { schema: null, name: "events" } });
    expect(sent.at(-1)!.query.query).toBe("SELECT `uuid`, `event`, `timestamp` FROM `events` WHERE `timestamp` >= now() - INTERVAL 1 DAY LIMIT 1");
    expect(d).toEqual({
      columns: [
        { name: "uuid", type: "UUID", kind: "string" },
        { name: "event", type: "String", kind: "string" },
        { name: "timestamp", type: "DateTime64(6, 'Europe/Amsterdam')", kind: "datetime" },
      ],
      key: ["uuid"],
      dropped: [],
      time: "timestamp",
    });
  });

  it("pages and counts, dates & times made UTC", async () => {
    const c = connector();
    const r = await c.query(events());
    expect(r).toEqual({
      rows: [
        { key: "u1", values: ["$pageview", "2024-07-01T08:00:00.123Z"] },
        { key: "u2", values: ["signed_up", "2024-07-01T09:00:00.000Z"] },
      ],
      more: true,
      total: 3,
    });
    // The same statement again within a few seconds is answered once.
    const asked = sent.length;
    await c.query(events());
    expect(sent.length).toBe(asked);
  });

  it("asks for a later page after the last row's keys, never by OFFSET (refused with a personal API key)", async () => {
    // PostHog's own answer to OFFSET on events with a personal API key.
    answer = (q) => (q.query?.includes("OFFSET") ? Response.json({ type: "validation_error", detail: "OFFSET is not supported on queries made with a personal API key." }, { status: 400 }) : standIn(q));
    const c = connector();
    const first = await c.query(events({ sort: [{ column: "timestamp", direction: "asc" }] }));
    expect(first.more).toBe(true);
    await c.query(events({ sort: [{ column: "timestamp", direction: "asc" }], offset: 2, counts: false }));
    const next = sent.at(-1)!.query.query!;
    expect(next).not.toContain("OFFSET");
    // After the second row's keys: its time and its key.
    expect(next).toContain("WHERE (((toUnixTimestamp(`timestamp`) > 1719824400 OR toUnixTimestamp(`timestamp`) IS NULL)) OR (toUnixTimestamp(`timestamp`) = 1719824400 AND (toString(`uuid`) > 'u2' OR toString(`uuid`) IS NULL)))");
  });

  it("says what PostHog refuses, and tells the key's fault apart", async () => {
    await expect(connector().query(events({ target: { table: { schema: null, name: "nope" } } }))).rejects.toThrow(SourceError);
    answer = () => Response.json({ type: "authentication_error", detail: "Invalid personal API key." }, { status: 401 });
    const e = await connector().check().catch((x: Error) => x);
    expect(e).not.toBeInstanceOf(SourceError);
    expect(String(e)).toContain("Invalid personal API key.");
    answer = () => Response.json({ detail: "Request was throttled." }, { status: 429 });
    await expect(connector().check()).rejects.toThrow(/rate limit/);
  });
});
