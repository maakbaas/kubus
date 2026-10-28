// @vitest-environment node
// The InfluxDB connector against a real InfluxDB 2 (KUBUS_TEST_INFLUX: influxSeed.ts), through a token that
// can only read its bucket. Skipped without the server locally; CI starts it (tests/services.yml).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SourceError } from "../../src/connectors/connector.ts";
import { InfluxConnector } from "../../src/connectors/influx.ts";
import type { MemoryRow } from "../../src/connectors/memory.ts";
import type { SourceColumn } from "../../../shared/sources.ts";
import { baseQuery, runContract, type Fixture } from "./contract.ts";
import { PEOPLE } from "./dataset.ts";
import { ADMIN_TOKEN, countPoints, createBucket, createToken, deleteBucket, deleteToken, INFLUX, influxFields, peopleLines, timeOf, write } from "./influxSeed.ts";

if (!INFLUX && process.env.CI) throw new Error("KUBUS_TEST_INFLUX isn't set: CI runs the InfluxDB connector's tests against a real InfluxDB (tests/services.yml)");

const BUCKET = "kubus_contract";
const config = (token: string, over: { fields?: Record<string, string>; schemas?: string[]; timeoutMs?: number } = {}) => ({
  name: "Sensors",
  kind: "influxdb",
  fields: influxFields(),
  password: token,
  schemas: [],
  timeoutMs: 10_000,
  ...over,
});

const COLUMNS: SourceColumn[] = [
  { name: "_time", type: "dateTime", kind: "datetime" },
  { name: "city", type: "tag", kind: "string" },
  { name: "name", type: "string", kind: "string" },
  { name: "id", type: "long", kind: "number" },
  { name: "age", type: "double", kind: "number" },
  { name: "score", type: "double", kind: "number" },
  { name: "active", type: "boolean", kind: "checkbox" },
];

describe.skipIf(!INFLUX)("InfluxDB connector, against InfluxDB 2", () => {
  let bucket: { id: string; orgId: string };
  let reader: { id: string; token: string };
  let connector: InfluxConnector;
  let fixture: Fixture;

  beforeAll(async () => {
    bucket = await createBucket(BUCKET);
    await write(BUCKET, peopleLines());
    reader = await createToken(bucket.orgId, [bucket.id], "kubus connector test (read)");
    connector = new InfluxConnector(config(reader.token));
    const rows: MemoryRow[] = PEOPLE.map((p, i) => ({
      _time: new Date(timeOf(p.seen, i)).toISOString(),
      city: p.city,
      name: p.name === "" ? null : p.name,
      id: p.id,
      age: p.age,
      score: p.score,
      active: p.active,
    }));
    fixture = { connector, target: { table: { schema: BUCKET, name: "people" } }, columns: COLUMNS, rows, key: "id", describedKey: ["_id"], title: ["name", "city"], text: (a, b) => (a < b ? -1 : a > b ? 1 : 0), looseTies: true };
  }, 60_000);

  afterAll(async () => {
    await connector?.close();
    if (reader) await deleteToken(reader.id);
    if (bucket) await deleteBucket(bucket.id);
  });

  it("checks a token that can only read", async () => {
    expect(await connector.check()).toEqual([]);
  });

  it("lists the measurement of its bucket", async () => {
    expect(await connector.tables()).toEqual([{ schema: BUCKET, name: "people", type: "measurement" }]);
  });

  it("describes a measurement with its time, tags and fields, and a hidden key of its own", async () => {
    const d = await connector.describe(fixture.target);
    expect(d.time).toBe("_time");
    expect(d.columns.map((c) => [c.name, c.kind, c.type])).toEqual([
      ["_time", "datetime", "dateTime"],
      ["city", "string", "tag"],
      ["active", "checkbox", "boolean"],
      ["age", "number", "double"],
      ["id", "number", "long"],
      ["name", "string", "string"],
      ["score", "number", "double"],
      ["_id", "string", "series and time"],
    ]);
    expect(d.columns.find((c) => c.name === "_id")).toMatchObject({ hidden: true });
    expect(d.key).toEqual(["_id"]);
    expect(d.dropped).toEqual([]);
  });

  runContract(() => fixture);

  it("reads rows by their own key, which is series and time", async () => {
    const q = baseQuery(fixture, { key: "_id", columns: ["_id", "id"], sort: [{ column: "_time", direction: "asc" }], limit: 3 });
    const page = await connector.query(q);
    expect(page.rows[0].key).toMatch(/^2025-01-01T00:00:02\.000000000Z,/);
    const again = await connector.row({ ...q, keyValue: page.rows[1].key });
    expect(again).toEqual(page.rows[1]);
  });

  it("counts a time range from the index and the rest the slow way, with the same answer", async () => {
    const range = { column: "_time", operator: "between" as const, value: "2026-03-01..2026-03-02" };
    const fast = await connector.query(baseQuery(fixture, { filter: range, limit: 2 }));
    const slow = await connector.query(baseQuery(fixture, { filter: { and: [range, { column: "id", operator: "gt", value: "-100" }] }, limit: 2 }));
    expect(fast.total).toBe(slow.total);
    expect(fast.total).toBe(PEOPLE.filter((p) => p.seen && p.seen >= "2026-03-01" && p.seen < "2026-03-03").length);
  });

  it("refuses a written query, a bucket it doesn't offer, and a measurement without data", async () => {
    await expect(connector.describe({ query: 'from(bucket: "x") |> range(start: -1h)' })).rejects.toThrow(/measurements only/);
    const narrow = new InfluxConnector(config(reader.token, { schemas: ["somewhere_else"] }));
    await expect(narrow.describe(fixture.target)).rejects.toThrow(/doesn't offer the bucket/);
    expect(await narrow.tables()).toEqual([]);
    await expect(connector.describe({ table: { schema: BUCKET, name: "nothing" } })).rejects.toThrow(SourceError);
    await expect(connector.describe({ table: { schema: null, name: "people" } })).rejects.toThrow(/from a bucket/);
  });

  it("tells a bucket it has no access to (a token for another bucket) from the server's trouble", async () => {
    const other = await createBucket("kubus_contract_other");
    const token = await createToken(bucket.orgId, [other.id], "kubus connector test (other)");
    try {
      const c = new InfluxConnector(config(token.token));
      // The token sees no bucket of this one: nothing to list, and reading it is refused.
      expect((await c.tables()).filter((t) => t.schema === BUCKET)).toEqual([]);
      await expect(c.describe(fixture.target)).rejects.toThrow();
    } finally {
      await deleteToken(token.id);
      await deleteBucket(other.id);
    }
  });

  it("warns about a token that can write (as far as InfluxDB lets it tell)", async () => {
    const writer = await createToken(bucket.orgId, [bucket.id], "kubus connector test (write)", ["read", "write"]);
    try {
      // InfluxDB shows a token only the authorizations it may read, so a token that can write but not read them can't be told from a reader.
      expect(await new InfluxConnector(config(writer.token)).check()).toEqual([]);
    } finally {
      await deleteToken(writer.id);
    }
    expect(await new InfluxConnector(config(ADMIN_TOKEN)).check()).toEqual([expect.stringMatching(/can write/)]);
  });

  it("fails on a wrong token and an unreachable server, in words, not as the request's mistake", async () => {
    const wrong = await new InfluxConnector(config("not-a-token")).tables().catch((e: Error) => e);
    expect(wrong).toBeInstanceOf(Error);
    expect(wrong).not.toBeInstanceOf(SourceError);
    expect((wrong as Error).message).toMatch(/401/);
    const nobody = new InfluxConnector(config(reader.token, { fields: { address: "http://127.0.0.1:1", org: "kubus" } }));
    await expect(nobody.check()).rejects.toThrow();
    await expect(new InfluxConnector(config(reader.token, { fields: { address: INFLUX!, org: "no-such-org" } })).tables()).rejects.toThrow();
  });

  it("only reads: the bucket holds the same points after everything above", async () => {
    const before = await countPoints(BUCKET);
    expect(before).toBe(PEOPLE.length);
    const c = new InfluxConnector(config(reader.token));
    await c.check();
    await c.tables();
    await c.describe(fixture.target);
    await c.query(baseQuery(fixture, { groupBy: "city" }));
    await c.row({ ...baseQuery(fixture), keyValue: "1" });
    expect(await countPoints(BUCKET)).toBe(before);
  });

  it("stops a query at the source's time limit", async () => {
    // A limit shorter than any round trip.
    const c = new InfluxConnector(config(reader.token, { timeoutMs: 1 }));
    await expect(c.tables()).rejects.toThrow(/too long|aborted|timeout/i);
  });
});
