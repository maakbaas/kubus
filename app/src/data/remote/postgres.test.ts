// @vitest-environment node
// The Postgres connector against a real database: only when KUBUS_TEST_POSTGRES names one
// (a superuser's connection string, e.g. postgres://postgres@localhost:5432/postgres). It makes
// its own database and read-only user, and drops them again. The server's packages (pg) load
// only then: CI installs the app's alone.
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Connector, SourceConfig } from "../../../../server/src/connectors/connector.ts";
import type { SourceQuery } from "../../../../shared/sources";

// What the test uses of pg (its types are the server's: not installed for the app).
interface Pg {
  Client: new (options: { connectionString: string }) => { connect(): Promise<void>; query(sql: string): Promise<unknown>; end(): Promise<void> };
}
let pg: Pg;
let PostgresConnector: new (config: SourceConfig) => Connector;

const ADMIN = process.env.KUBUS_TEST_POSTGRES;
const DB = "kubus_source_test";

const FIXTURE = `
  CREATE TYPE mood AS ENUM ('happy', 'sad');
  CREATE TABLE people (
    id integer PRIMARY KEY,
    name text,
    nick varchar(20),
    age integer,
    score numeric(6, 2),
    active boolean,
    born date,
    seen timestamptz,
    local_seen timestamp,
    tags text[],
    lucky int[],
    feeling mood,
    uid uuid,
    data jsonb,
    span interval,
    photo bytea
  );
  INSERT INTO people VALUES
    (1, 'Ada', 'ada', 36, 9.5, true, '1815-12-10', '2026-03-01 23:30:00+00', '2026-03-01 23:30', '{math,poetry}', '{3,7}', 'happy', '00000000-0000-0000-0000-000000000001', '{"a": 1}', '2 days', '\\x00'),
    (2, 'Bob', null, 41, 7.25, false, '1980-01-01', '2026-03-02 08:00:00+00', null, '{music}', '{}', 'sad', null, null, '1 hour', null),
    (3, '', 'Cy', null, null, null, null, null, null, null, null, null, null, null, null, null),
    (4, 'dan', 'dan_100%', 7, 1, true, '2020-05-05', '2026-03-01 10:00:00+00', null, '{math}', '{10}', 'happy', null, null, null, null);
  CREATE VIEW grown AS SELECT id, name FROM people WHERE age >= 18;
  CREATE SEQUENCE counter;
  CREATE ROLE kubus_reader LOGIN PASSWORD 'reader';
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO kubus_reader;
  GRANT USAGE ON SEQUENCE counter TO kubus_reader;
`;

const base = (over: Partial<SourceQuery> = {}): SourceQuery => ({
  target: { table: { schema: "public", name: "people" } },
  key: "id",
  columns: ["name", "age"],
  title: ["name", "nick"],
  untitled: "Person",
  filters: [],
  search: "",
  sort: [{ column: "$title", direction: "asc" }],
  groupBy: null,
  groupOrder: "asc",
  timeZone: "Europe/Amsterdam",
  offset: 0,
  limit: 50,
  counts: true,
  ...over,
});

describe.skipIf(!ADMIN)("Postgres connector", () => {
  let connector: Connector;
  const admin = () => new pg.Client({ connectionString: ADMIN! });
  const urlFor = (user: string, password: string) => {
    const url = new URL(ADMIN!);
    url.username = user;
    url.password = password;
    url.pathname = `/${DB}`;
    return url.toString();
  };

  beforeAll(async () => {
    pg = createRequire(new URL("../../../../server/package.json", import.meta.url))("pg") as Pg;
    ({ PostgresConnector } = await import("../../../../server/src/connectors/postgres.ts"));
    const c = admin();
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${DB}`);
    await c.query("DROP ROLE IF EXISTS kubus_reader");
    await c.query(`CREATE DATABASE ${DB}`);
    await c.end();
    const d = new pg.Client({ connectionString: urlFor(new URL(ADMIN!).username, new URL(ADMIN!).password) });
    await d.connect();
    await d.query(FIXTURE);
    await d.end();
    connector = new PostgresConnector({ name: "TEST", url: urlFor("kubus_reader", "reader"), schemas: [], queries: true, timeoutMs: 5000 });
  });

  afterAll(async () => {
    await connector?.close();
    const c = admin();
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await c.query("DROP ROLE IF EXISTS kubus_reader");
    await c.end();
  });

  it("checks its user", async () => {
    expect(await connector.check()).toEqual([]);
  });

  it("lists tables and views", async () => {
    expect(await connector.tables()).toEqual([
      { schema: "public", name: "grown", type: "view" },
      { schema: "public", name: "people", type: "table" },
    ]);
  });

  it("describes columns as field types, dropping binary data", async () => {
    const d = await connector.describe({ table: { schema: "public", name: "people" } });
    expect(d.key).toEqual(["id"]);
    expect(d.dropped).toEqual([{ name: "photo", type: "bytea" }]);
    const kinds = Object.fromEntries(d.columns.map((c) => [c.name, [c.kind, c.plain ? "plain" : "", c.hidden ? "hidden" : ""].join(" ").trim()]));
    expect(kinds).toEqual({
      id: "number", name: "string", nick: "string", age: "number", score: "number", active: "checkbox", born: "date",
      seen: "datetime", local_seen: "datetime", tags: "string_list", lucky: "string_list", feeling: "string",
      uid: "string", data: "string plain hidden", span: "string plain",
    });
  });

  it("reads values as the app stores them", async () => {
    const r = await connector.query(base({ columns: ["score", "active", "born", "seen", "local_seen", "tags", "lucky", "feeling", "data", "span"], filters: [{ column: "id", operator: "is", value: "1" }] }));
    expect(r.rows).toEqual([
      {
        key: "1",
        values: [9.5, true, "1815-12-10", "2026-03-01T23:30:00.000Z", "2026-03-01T23:30:00.000Z", ["math", "poetry"], ["3", "7"], "happy", '{"a": 1}', "2 days"],
      },
    ]);
    expect(r.total).toBe(1);
  });

  it("sorts by title like the app (blank titles fall back, untitled last by name)", async () => {
    const r = await connector.query(base());
    // Ada, Bob, Cy (its nick: the name is blank), dan
    expect(r.rows.map((x) => x.key)).toEqual(["1", "2", "3", "4"]);
    const desc = await connector.query(base({ sort: [{ column: "age", direction: "desc" }] }));
    // Empty values last in both directions.
    expect(desc.rows.map((x) => x.key)).toEqual(["2", "1", "4", "3"]);
  });

  it("filters", async () => {
    const keys = async (filters: SourceQuery["filters"]) => (await connector.query(base({ filters }))).rows.map((r) => r.key);
    expect(await keys([{ column: "name", operator: "contains", value: "A" }])).toEqual(["1", "4"]);
    expect(await keys([{ column: "nick", operator: "contains", value: "_100%" }])).toEqual(["4"]);
    expect(await keys([{ column: "nick", operator: "notContains", value: "a" }])).toEqual(["2", "3"]);
    expect(await keys([{ column: "name", operator: "isEmpty", value: "" }])).toEqual(["3"]);
    expect(await keys([{ column: "name", operator: "is", value: "ada" }])).toEqual(["1"]);
    expect(await keys([{ column: "age", operator: "gt", value: "36" }])).toEqual(["2"]);
    expect(await keys([{ column: "age", operator: "isNot", value: "36" }])).toEqual(["2", "3", "4"]);
    expect(await keys([{ column: "age", operator: "lt", value: "7.5" }])).toEqual(["4"]);
    expect(await keys([{ column: "age", operator: "is", value: "abc" }])).toEqual([]);
    expect(await keys([{ column: "active", operator: "isNotChecked", value: "" }])).toEqual(["2", "3"]);
    expect(await keys([{ column: "tags", operator: "contains", value: "math" }])).toEqual(["1", "4"]);
    expect(await keys([{ column: "tags", operator: "isEmpty", value: "" }])).toEqual(["3"]);
    expect(await keys([{ column: "born", operator: "before", value: "1990-01-01" }])).toEqual(["1", "2"]);
    expect(await keys([{ column: "data", operator: "contains", value: '"a"' }])).toEqual(["1"]);
    // 23:30 UTC on 1 March is 2 March in Amsterdam.
    expect(await keys([{ column: "seen", operator: "is", value: "2026-03-02" }])).toEqual(["1", "2"]);
    expect(await keys([{ column: "seen", operator: "between", value: "2026-03-01..2026-03-01" }])).toEqual(["4"]);
    expect(await keys([{ column: "seen", operator: "after", value: "2026-03-01" }])).toEqual(["1", "2"]);
  });

  it("refuses what a column can't do", async () => {
    await expect(connector.query(base({ sort: [{ column: "span", direction: "asc" }] }))).rejects.toThrow(/can't be sorted/);
    await expect(connector.query(base({ columns: ["missing"] }))).rejects.toThrow(/no column/);
  });

  it("searches every read column", async () => {
    const r = await connector.query(base({ columns: ["name", "nick", "tags"], search: "POET" }));
    expect(r.rows.map((x) => x.key)).toEqual(["1"]);
  });

  it("pages, with the key breaking ties", async () => {
    const first = await connector.query(base({ limit: 2, sort: [{ column: "active", direction: "asc" }] }));
    const second = await connector.query(base({ limit: 2, offset: 2, counts: false, sort: [{ column: "active", direction: "asc" }] }));
    expect(first.more).toBe(true);
    expect(second.more).toBe(false);
    expect(second.total).toBeUndefined();
    expect([...first.rows, ...second.rows].map((r) => r.key)).toEqual(["2", "3", "1", "4"]);
  });

  it("groups, the empty group last, a list column per value", async () => {
    const byActive = await connector.query(base({ groupBy: "active" }));
    expect(byActive.groups).toEqual([{ key: "yes", count: 2 }, { key: "no", count: 2 }]);
    expect(byActive.rows.map((r) => [r.group, r.key])).toEqual([["yes", "1"], ["yes", "4"], ["no", "2"], ["no", "3"]]);
    const byTag = await connector.query(base({ groupBy: "tags", groupOrder: "count" }));
    expect(byTag.groups).toEqual([{ key: "math", count: 2 }, { key: "music", count: 1 }, { key: "poetry", count: 1 }, { key: "", count: 1 }]);
    expect(byTag.total).toBe(4);
    const byAge = await connector.query(base({ groupBy: "age", groupOrder: "desc" }));
    expect(byAge.groups?.map((g) => g.key)).toEqual(["41", "36", "7", ""]);
    const byDay = await connector.query(base({ groupBy: "seen" }));
    expect(byDay.groups).toEqual([{ key: "2026-03-01", count: 1 }, { key: "2026-03-02", count: 2 }, { key: "", count: 1 }]);
  });

  it("reads a query, and refuses writing through it", async () => {
    const r = await connector.query(base({ target: { query: "SELECT id, upper(name) AS shout FROM people WHERE id < 3;" }, columns: ["shout"], title: ["shout"] }));
    expect(r.rows).toEqual([{ key: "1", values: ["ADA"] }, { key: "2", values: ["BOB"] }]);
    await expect(connector.describe({ query: "SELECT 1; DELETE FROM people" })).rejects.toThrow();
    await expect(connector.describe({ query: "SELECT 1 AS a, 2 AS a" })).rejects.toThrow(/Two columns/);
    await expect(connector.query(base({ target: { query: "SELECT 1 AS id, nextval('counter') AS n" }, columns: ["n"], title: [] }))).rejects.toThrow(/read-only/);
  });

  it("reads one row by its key", async () => {
    const shape = { target: { table: { schema: "public", name: "people" } }, key: "id", columns: ["name"], title: ["name"], untitled: "Person" };
    expect(await connector.row({ ...shape, keyValue: "2" })).toEqual({ key: "2", values: ["Bob"] });
    expect(await connector.row({ ...shape, keyValue: "nope" })).toBeNull();
    expect(await connector.row({ ...shape, keyValue: "99" })).toBeNull();
  });

  it("warns about a user that can write", async () => {
    const writer = new PostgresConnector({ name: "W", url: urlFor(new URL(ADMIN!).username, new URL(ADMIN!).password), schemas: [], queries: false, timeoutMs: 5000 });
    expect((await writer.check()).join()).toMatch(/superuser/);
    await expect(writer.describe({ query: "SELECT 1" })).rejects.toThrow(/doesn't allow queries/);
    await writer.close();
  });
});
