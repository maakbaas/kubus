// @vitest-environment node
// The D1 connector asked the shared contract's questions (contract.ts), on a real SQLite behind the stand-in for
// Cloudflare's API (d1Api.ts; D1 itself can't run locally). Texts are ASCII here: D1's SQLite folds the case of ASCII only
// (docs/sync.md; d1.test.ts checks that).
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SourceError } from "../../src/connectors/connector.ts";
import { D1Connector } from "../../src/connectors/d1.ts";
import type { SourceColumn } from "../../../shared/sources.ts";
import { baseQuery, runContract, type Fixture } from "./contract.ts";
import { PEOPLE, type Person } from "./dataset.ts";
import { stubD1, type D1Stub } from "./d1Api.ts";

const COLUMNS: SourceColumn[] = [
  { name: "id", type: "INTEGER", kind: "number" },
  { name: "name", type: "TEXT", kind: "string" },
  { name: "age", type: "INTEGER", kind: "number" },
  { name: "score", type: "REAL", kind: "number" },
  { name: "active", type: "BOOLEAN", kind: "checkbox" },
  { name: "born", type: "DATE", kind: "date" },
  { name: "seen", type: "DATETIME", kind: "datetime" },
  { name: "city", type: "TEXT", kind: "string" },
];

/** The people with ASCII texts (D1's case folding is ASCII only). */
const ascii = (p: Person): Person => ({ ...p, name: p.name?.replace("Émile", "Emile").replace("zoë", "zoe") ?? null });

describe("D1 connector, asked the shared contract", () => {
  let db: DatabaseSync;
  let stub: D1Stub;
  let fixture: Fixture;

  beforeAll(() => {
    db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, age INTEGER, score REAL, active BOOLEAN, born DATE, seen DATETIME, city TEXT)");
    const insert = db.prepare("INSERT INTO people VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const p of PEOPLE.map(ascii)) insert.run(p.id, p.name, p.age, p.score, p.active === null ? null : p.active ? 1 : 0, p.born, p.seen, p.city);
    stub = stubD1(db);
    const connector = new D1Connector({ name: "Edge", kind: "d1", fields: { account: "acc", database: "db-1" }, password: "token-1", schemas: [], timeoutMs: 10_000 });
    fixture = {
      connector,
      target: { table: { schema: null, name: "people" } },
      columns: COLUMNS,
      rows: PEOPLE.map(ascii).map(({ tags: _tags, ...p }) => p),
      key: "id",
      title: ["name", "city"],
      text: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
    };
  });

  afterAll(() => vi.unstubAllGlobals());

  runContract(() => fixture);

  it("sends nothing but reads, one statement each, within D1's limits (100 parameters, 100 KB)", async () => {
    stub.requests.length = 0;
    await fixture.connector.query(baseQuery(fixture, { filter: { or: PEOPLE.map((p) => ({ column: "id", operator: "is" as const, value: String(p.id) })) }, groupBy: "city", search: "a" }));
    expect(stub.requests.length).toBeGreaterThan(0);
    for (const r of stub.requests) {
      expect(r.method).toBe("POST");
      expect(r.contentType).toBe("application/json");
      expect(r.sql).toMatch(/^(SELECT|PRAGMA table_xinfo\()/i);
      expect(r.params.length).toBeLessThanOrEqual(100);
      expect(r.sql.length).toBeLessThan(100_000);
    }
  });

  it("asks for as many parameters as a filter has rules, and D1 refuses more than 100 (so does the stand-in)", async () => {
    // 120 rules of a filter would be 120 parameters: D1 answers 400 "too many SQL variables" (a request's mistake).
    const many = Array.from({ length: 120 }, (_, i) => ({ column: "name", operator: "contains" as const, value: `x${i}` }));
    const error = await fixture.connector.query(baseQuery(fixture, { filter: { or: many } })).catch((e: Error) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as Error).message).toMatch(/too many SQL variables/);
  });
});
