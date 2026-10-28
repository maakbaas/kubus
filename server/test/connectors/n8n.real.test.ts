// @vitest-environment node
// The n8n connector against a real n8n (KUBUS_TEST_N8N: n8nSeed.ts), through an API key that can only read data
// tables, asked the shared contract's questions (contract.ts) of a table filled through n8n's own API. This is where
// the rules the connector sends n8n to narrow a read (ilike, gte, lt, eq on dates) meet n8n's real filter.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SourceError } from "../../src/connectors/connector.ts";
import { N8nConnector } from "../../src/connectors/n8n.ts";
import type { MemoryRow } from "../../src/connectors/memory.ts";
import type { SourceColumn } from "../../../shared/sources.ts";
import { baseQuery, runContract, type Fixture } from "./contract.ts";
import { PEOPLE } from "./dataset.ts";
import { api, countRows, createKey, createTable, deleteKey, deleteTable, N8N, READ_SCOPES, unique, WRITE_SCOPES, type Table } from "./n8nSeed.ts";

if (!N8N && process.env.CI) throw new Error("KUBUS_TEST_N8N isn't set: CI runs the n8n connector's tests against a real n8n (tests/services.yml)");

const TABLE = unique("Kubus contract people");
const config = (key: string, over: { address?: string; schemas?: string[]; timeoutMs?: number } = {}) => ({
  name: "Flows",
  kind: "n8n",
  fields: { address: over.address ?? N8N ?? "" },
  password: key,
  schemas: over.schemas ?? [],
  timeoutMs: over.timeoutMs ?? 20_000,
});

const COLUMNS: SourceColumn[] = [
  { name: "name", type: "string", kind: "string" },
  { name: "age", type: "number", kind: "number" },
  { name: "score", type: "number", kind: "number" },
  { name: "active", type: "boolean", kind: "checkbox" },
  { name: "born", type: "date", kind: "datetime" },
  { name: "seen", type: "date", kind: "datetime" },
  { name: "city", type: "string", kind: "string" },
  { name: "id", type: "id", kind: "number" },
];

describe.skipIf(!N8N)("n8n connector, against n8n", () => {
  let writer: { id: string; key: string };
  let reader: { id: string; key: string };
  let table: Table;
  let connector: N8nConnector;
  let fixture: Fixture;

  beforeAll(async () => {
    writer = await createKey(unique("kubus connector test (write)"), WRITE_SCOPES);
    reader = await createKey(unique("kubus connector test (read)"), READ_SCOPES);
    const iso = (day: string | null) => (day === null ? null : `${day}T00:00:00.000Z`);
    table = await createTable(
      writer.key,
      TABLE,
      [
        { name: "name", type: "string" },
        { name: "age", type: "number" },
        { name: "score", type: "number" },
        { name: "active", type: "boolean" },
        { name: "born", type: "date" },
        { name: "seen", type: "date" },
        { name: "city", type: "string" },
      ],
      PEOPLE.map((p) => ({ name: p.name, age: p.age, score: p.score, active: p.active, born: iso(p.born), seen: p.seen, city: p.city })),
    );
    connector = new N8nConnector(config(reader.key));
    const rows: MemoryRow[] = PEOPLE.map((p) => ({ name: p.name, age: p.age, score: p.score, active: p.active, born: iso(p.born), seen: p.seen, city: p.city, id: p.id }));
    fixture = { connector, target: { table: { schema: null, name: TABLE } }, columns: COLUMNS, rows, key: "id", title: ["name", "city"] };
  }, 120_000);

  afterAll(async () => {
    await connector?.close();
    try {
      if (table) await deleteTable(writer.key, table.id);
    } finally {
      if (reader) await deleteKey(reader.id);
      if (writer) await deleteKey(writer.id);
    }
  });

  it("checks its key", async () => {
    expect(await connector.check()).toEqual([]);
  });

  it("lists its data tables as tables without a schema", async () => {
    const tables = await connector.tables();
    expect(tables).toContainEqual({ schema: null, name: TABLE, type: "table" });
    expect(tables.every((t) => t.schema === null && t.type === "table")).toBe(true);
  });

  it("describes the columns n8n has, in its order, with n8n's own after them", async () => {
    const d = await connector.describe(fixture.target);
    expect(d.key).toEqual(["id"]);
    expect(d.dropped).toEqual([]);
    expect(d.columns.map((c) => [c.name, c.type, c.kind])).toEqual([
      ["name", "string", "string"],
      ["age", "number", "number"],
      ["score", "number", "number"],
      ["active", "boolean", "checkbox"],
      ["born", "date", "datetime"],
      ["seen", "date", "datetime"],
      ["city", "string", "string"],
      ["id", "id", "number"],
      ["createdAt", "date", "datetime"],
      ["updatedAt", "date", "datetime"],
    ]);
  });

  runContract(() => fixture);

  it("offers only the projects asked for", async () => {
    expect((await new N8nConnector(config(reader.key, { schemas: [table.projectId] })).tables()).map((t) => t.name)).toContain(TABLE);
    expect(await new N8nConnector(config(reader.key, { schemas: ["no-such-project"] })).tables()).toEqual([]);
  });

  it("refuses a written query, and a table that isn't there", async () => {
    await expect(connector.describe({ query: "SELECT 1" })).rejects.toThrow(/tables only/);
    await expect(connector.describe({ table: { schema: null, name: "No such table" } })).rejects.toThrow(SourceError);
    await expect(connector.describe({ table: { schema: "p", name: TABLE } })).rejects.toThrow(SourceError);
  });

  it("fails on a wrong key, a key without the scope, and an unreachable n8n, in words, not as the request's mistake", async () => {
    const wrong = await new N8nConnector(config("not-a-key")).check().catch((e: Error) => e);
    expect(wrong).toBeInstanceOf(Error);
    expect(wrong).not.toBeInstanceOf(SourceError);
    expect((wrong as Error).message).toMatch(/401/);
    const narrow = await createKey(unique("kubus connector test (no list)"), ["dataTable:read"]);
    try {
      const refused = await new N8nConnector(config(narrow.key)).check().catch((e: Error) => e);
      expect(refused).not.toBeInstanceOf(SourceError);
      expect((refused as Error).message).toMatch(/n8n answered 40[13]/);
    } finally {
      await deleteKey(narrow.id);
    }
    await expect(new N8nConnector(config(reader.key, { address: "http://127.0.0.1:1" })).check()).rejects.toThrow();
  });

  it("only reads: the table holds the same rows after everything above, and its key can't write", async () => {
    const before = await countRows(writer.key, table.id);
    expect(before).toBe(PEOPLE.length);
    const c = new N8nConnector(config(reader.key));
    await c.check();
    await c.describe(fixture.target);
    await c.query(baseQuery(fixture, { groupBy: "city" }));
    await c.row({ ...baseQuery(fixture), keyValue: "1" });
    expect(await countRows(writer.key, table.id)).toBe(before);
    // The read key is refused when it tries what the connector never does.
    await expect(api(reader.key, `/data-tables/${table.id}/rows`, { method: "POST", body: { data: [{ name: "x" }], returnType: "count" } })).rejects.toThrow(/40[13]/);
    expect(await countRows(writer.key, table.id)).toBe(before);
  });

  it("stops at the source's time limit", async () => {
    await expect(new N8nConnector(config(reader.key, { timeoutMs: 1 })).check()).rejects.toThrow(/too long|abort|timeout/i);
  });
});
