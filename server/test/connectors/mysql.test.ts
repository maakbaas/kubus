// @vitest-environment node
// The MySQL / MariaDB connector against real servers (KUBUS_TEST_MYSQL, KUBUS_TEST_MARIADB:
// ../mysql.ts), each with a read-only user of its own, dropped again afterwards.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlConnector } from "../../src/connectors/mysql.ts";
import type { Statement } from "../../src/connectors/mysqlSql.ts";
import { admin, createDatabase, dropDatabase, SERVERS, sourceFor } from "../mysql.ts";
import type { SourceFilter, SourceQuery } from "../../../shared/sources.ts";

const DB = "kubus_source_test";
const READER = { name: "kubus_reader", password: "reader" };

const FIXTURE = `
  CREATE TABLE people (
    id int PRIMARY KEY,
    name varchar(50),
    nick varchar(20) COLLATE utf8mb4_bin,
    age int,
    score decimal(6, 2),
    active tinyint(1),
    lucky tinyint,
    born date,
    seen timestamp NULL DEFAULT NULL,
    local_seen datetime(3),
    tags set('math', 'music', 'poetry'),
    feeling enum('happy', 'sad'),
    data json,
    photo blob,
    place point
  );
  INSERT INTO people VALUES
    (1, 'Ada', 'ada', 36, 9.5, 1, 3, '1815-12-10', '2026-03-01 23:30:00', '2026-03-01 23:30:00.250', 'math,poetry', 'happy', '{"a": 1}', x'00', NULL),
    (2, 'Bob', NULL, 41, 7.25, 0, NULL, '1980-01-01', '2026-03-02 08:00:00', NULL, 'music', 'sad', NULL, NULL, NULL),
    (3, '', 'Cy', NULL, NULL, NULL, NULL, '0000-00-00', '0000-00-00 00:00:00', '2026-00-00 00:00:00', '', NULL, NULL, NULL, NULL),
    (4, 'dan', 'dan_100%', 7, 1, 1, 10, '2020-05-05', '2026-03-01 10:00:00', NULL, 'math', 'happy', NULL, NULL, NULL),
    (5, 'Customer 10', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    (6, 'Customer 9', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
  CREATE VIEW grown AS SELECT id, name FROM people WHERE age >= 18;
  CREATE TABLE words (id int PRIMARY KEY, word varchar(20));
  INSERT INTO words VALUES (1, 'Émile'), (2, 'emile'), (3, 'zoe 10'), (4, 'Zoe 9'), (5, 'zoë 2');
`;

const base = (over: Partial<SourceQuery> = {}): SourceQuery => ({
  target: { table: { schema: DB, name: "people" } },
  key: "id",
  columns: ["name", "age"],
  title: ["name", "nick"],
  untitled: "Person",
  filter: { and: [] },
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

/** The connector's own read (a transaction), to send a statement it would never make. */
const readOf = (c: MysqlConnector) =>
  (c as unknown as { read: (work: (run: (s: Statement) => Promise<unknown>) => Promise<unknown>) => Promise<unknown> }).read.bind(c);

describe.each([
  ["mysql", SERVERS.mysql],
  ["mariadb", SERVERS.mariadb],
] as const)("%s connector", (kind, url) => {
  let connector: MysqlConnector;
  beforeAll(async () => {
    if (!url) return;
    await createDatabase(url, DB);
    await admin(url, `DROP USER IF EXISTS '${READER.name}'@'%'; CREATE USER '${READER.name}'@'%' IDENTIFIED BY '${READER.password}'; GRANT SELECT ON \`${DB}\`.* TO '${READER.name}'@'%'`);
    await admin(url, FIXTURE, DB);
    connector = new MysqlConnector({ name: "TEST", ...sourceFor(kind, url, DB, READER), schemas: [], timeoutMs: 5000 }, kind);
  });

  afterAll(async () => {
    if (!url) return;
    await connector?.close();
    await dropDatabase(url, DB);
    await admin(url, `DROP USER IF EXISTS '${READER.name}'@'%'`);
  });

  describe.skipIf(!url)("on a server", () => {
    it("checks its user", async () => {
      expect(await connector.check()).toEqual([]);
    });

    it("lists tables and views, databases as schemas", async () => {
      expect(await connector.tables()).toEqual([
        { schema: DB, name: "grown", type: "view" },
        { schema: DB, name: "people", type: "table" },
        { schema: DB, name: "words", type: "table" },
      ]);
    });

    it("describes columns as field types, dropping binary data and shapes", async () => {
      const d = await connector.describe({ table: { schema: DB, name: "people" } });
      expect(d.key).toEqual(["id"]);
      expect(d.dropped.map((x) => x.name)).toEqual(["photo", "place"]);
      const kinds = Object.fromEntries(d.columns.map((c) => [c.name, [c.kind, c.plain ? "plain" : "", c.hidden ? "hidden" : ""].join(" ").trim()]));
      expect(kinds).toEqual({
        id: "number", name: "string", nick: "string", age: "number", score: "number", active: "checkbox", lucky: "number", born: "date",
        seen: "datetime", local_seen: "datetime", tags: "string_list", feeling: "string", data: "string plain hidden",
      });
      expect((await connector.describe({ table: { schema: null, name: "grown" } })).columns.map((c) => c.name)).toEqual(["id", "name"]);
    });

    it("reads values as the app stores them, zero dates empty", async () => {
      const columns = ["score", "active", "lucky", "born", "seen", "local_seen", "tags", "feeling", "data"];
      const r = await connector.query(base({ columns, filter: { or: [{ column: "id", operator: "is", value: "1" }, { column: "id", operator: "is", value: "3" }] } }));
      expect(r.rows).toEqual([
        { key: "1", values: [9.5, true, 3, "1815-12-10", "2026-03-01T23:30:00.000Z", "2026-03-01T23:30:00.250Z", ["math", "poetry"], "happy", '{"a": 1}'] },
        { key: "3", values: [null, null, null, null, null, null, [], null, null] },
      ]);
      expect(r.total).toBe(2);
    });

    it("sorts by title like the app (numbers in text by value, blank titles fall back), empty values last", async () => {
      const r = await connector.query(base());
      // Ada, Bob, Customer 9, Customer 10, Cy (its nick: the name is blank), dan
      expect(r.rows.map((x) => x.key)).toEqual(["1", "2", "6", "5", "3", "4"]);
      const desc = await connector.query(base({ sort: [{ column: "age", direction: "desc" }] }));
      expect(desc.rows.map((x) => x.key)).toEqual(["2", "1", "4", "3", "5", "6"]);
      const born = await connector.query(base({ sort: [{ column: "born", direction: "asc" }] }));
      expect(born.rows.map((x) => x.key)).toEqual(["1", "2", "4", "3", "5", "6"]);
      const nick = await connector.query(base({ sort: [{ column: "nick", direction: "desc" }] }));
      expect(nick.rows.map((x) => x.key)).toEqual(["4", "3", "1", "2", "5", "6"]);
    });

    it("filters", async () => {
      const keys = async (filters: SourceFilter[]) => (await connector.query(base({ filter: { and: filters } }))).rows.map((r) => r.key);
      expect(await keys([{ column: "name", operator: "contains", value: "A" }])).toEqual(["1", "4"]);
      // A binary collation is compared case-insensitively too.
      expect(await keys([{ column: "nick", operator: "contains", value: "CY" }])).toEqual(["3"]);
      expect(await keys([{ column: "nick", operator: "contains", value: "_100%" }])).toEqual(["4"]);
      expect(await keys([{ column: "nick", operator: "notContains", value: "a" }])).toEqual(["2", "6", "5", "3"]);
      expect(await keys([{ column: "name", operator: "isEmpty", value: "" }])).toEqual(["3"]);
      expect(await keys([{ column: "name", operator: "is", value: "ADA" }])).toEqual(["1"]);
      expect(await keys([{ column: "age", operator: "gt", value: "36" }])).toEqual(["2"]);
      expect(await keys([{ column: "age", operator: "isNot", value: "36" }])).toEqual(["2", "6", "5", "3", "4"]);
      expect(await keys([{ column: "age", operator: "lt", value: "7.5" }])).toEqual(["4"]);
      expect(await keys([{ column: "age", operator: "is", value: "abc" }])).toEqual([]);
      expect(await keys([{ column: "score", operator: "is", value: "7.25" }])).toEqual(["2"]);
      expect(await keys([{ column: "active", operator: "isNotChecked", value: "" }])).toEqual(["2", "6", "5", "3"]);
      expect(await keys([{ column: "tags", operator: "contains", value: "math" }])).toEqual(["1", "4"]);
      expect(await keys([{ column: "tags", operator: "contains", value: "math, poetry" }])).toEqual(["1"]);
      expect(await keys([{ column: "tags", operator: "isEmpty", value: "" }])).toEqual(["6", "5", "3"]);
      expect(await keys([{ column: "feeling", operator: "is", value: "Sad" }])).toEqual(["2"]);
      expect(await keys([{ column: "born", operator: "before", value: "1990-01-01" }])).toEqual(["1", "2"]);
      expect(await keys([{ column: "born", operator: "isEmpty", value: "" }])).toEqual(["6", "5", "3"]);
      expect(await keys([{ column: "data", operator: "contains", value: '"a"' }])).toEqual(["1"]);
      // 23:30 UTC on 1 March is 2 March in Amsterdam.
      expect(await keys([{ column: "seen", operator: "is", value: "2026-03-02" }])).toEqual(["1", "2"]);
      expect(await keys([{ column: "local_seen", operator: "is", value: "2026-03-02" }])).toEqual(["1"]);
      expect(await keys([{ column: "seen", operator: "between", value: "2026-03-01..2026-03-01" }])).toEqual(["4"]);
      expect(await keys([{ column: "seen", operator: "after", value: "2026-03-01" }])).toEqual(["1", "2"]);
      expect(await keys([{ column: "local_seen", operator: "before", value: "2026-03-01" }])).toEqual([]);
      expect(await keys([{ column: "seen", operator: "isNotEmpty", value: "" }])).toEqual(["1", "2", "4"]);
    });

    it("compares text case-insensitively but accents apart, as the app does", async () => {
      const words = (over: Partial<SourceQuery>) => connector.query(base({ target: { table: { schema: DB, name: "words" } }, columns: ["word"], title: ["word"], ...over }));
      const keys = async (filter: SourceFilter) => (await words({ filter })).rows.map((r) => r.key);
      expect(await keys({ column: "word", operator: "contains", value: "ÉM" })).toEqual(["1"]);
      expect(await keys({ column: "word", operator: "is", value: "émile" })).toEqual(["1"]);
      expect(await keys({ column: "word", operator: "contains", value: "zoe" })).toEqual(["4", "3"]);
      expect((await words({ sort: [{ column: "word", direction: "desc" }] })).rows.map((r) => r.key).slice(0, 3)).toEqual(["3", "4", "5"]);
    });

    it("filters by and / or trees", async () => {
      const keys = async (filter: SourceQuery["filter"]) => (await connector.query(base({ filter }))).rows.map((r) => r.key);
      const named = { column: "name", operator: "contains", value: "A" } as const;
      expect(await keys({ or: [named, { column: "age", operator: "gt", value: "36" }] })).toEqual(["1", "2", "4"]);
      expect(await keys({ and: [{ or: [named, { column: "age", operator: "gt", value: "36" }] }, { column: "active", operator: "isNotChecked", value: "" }] })).toEqual(["2"]);
      expect(await keys({ or: [] })).toEqual([]);
    });

    it("refuses what a column can't do", async () => {
      await expect(connector.query(base({ sort: [{ column: "data", direction: "asc" }] }))).rejects.toThrow(/can't be sorted/);
      await expect(connector.query(base({ columns: ["missing"] }))).rejects.toThrow(/no column/);
      await expect(connector.describe({ table: { schema: DB, name: "missing" } })).rejects.toThrow(/no table/);
    });

    it("searches every read column", async () => {
      const r = await connector.query(base({ columns: ["name", "nick", "tags"], search: "POET" }));
      expect(r.rows.map((x) => x.key)).toEqual(["1"]);
    });

    it("pages, with the key breaking ties", async () => {
      const first = await connector.query(base({ limit: 3, sort: [{ column: "active", direction: "asc" }] }));
      const second = await connector.query(base({ limit: 3, offset: 3, counts: false, sort: [{ column: "active", direction: "asc" }] }));
      expect(first.more).toBe(true);
      expect(second.more).toBe(false);
      expect(second.total).toBeUndefined();
      expect([...first.rows, ...second.rows].map((r) => r.key)).toEqual(["2", "3", "5", "6", "1", "4"]);
    });

    it("groups, the empty group last, a SET per member", async () => {
      const byActive = await connector.query(base({ groupBy: "active" }));
      expect(byActive.groups).toEqual([{ key: "yes", count: 2 }, { key: "no", count: 4 }]);
      expect(byActive.rows.map((r) => [r.group, r.key])).toEqual([["yes", "1"], ["yes", "4"], ["no", "2"], ["no", "6"], ["no", "5"], ["no", "3"]]);
      const byTag = await connector.query(base({ groupBy: "tags", groupOrder: "count" }));
      expect(byTag.groups).toEqual([{ key: "math", count: 2 }, { key: "music", count: 1 }, { key: "poetry", count: 1 }, { key: "", count: 3 }]);
      expect(byTag.rows.map((r) => [r.group, r.key])).toEqual([["math", "1"], ["math", "4"], ["music", "2"], ["poetry", "1"], ["", "6"], ["", "5"], ["", "3"]]);
      expect(byTag.total).toBe(6);
      const byAge = await connector.query(base({ groupBy: "age", groupOrder: "desc" }));
      expect(byAge.groups?.map((g) => g.key)).toEqual(["41", "36", "7", ""]);
      const byScore = await connector.query(base({ groupBy: "score" }));
      expect(byScore.groups?.map((g) => g.key)).toEqual(["1", "7.25", "9.5", ""]);
      const byDay = await connector.query(base({ groupBy: "seen" }));
      expect(byDay.groups).toEqual([{ key: "2026-03-01", count: 1 }, { key: "2026-03-02", count: 2 }, { key: "", count: 3 }]);
      const byName = await connector.query(base({ groupBy: "name", counts: true }));
      expect(byName.groups?.map((g) => g.key)).toEqual(["Ada", "Bob", "Customer 9", "Customer 10", "dan", ""]);
    });

    it("reads one row by its key", async () => {
      const shape = { target: { table: { schema: DB, name: "people" } }, key: "id", columns: ["name"], title: ["name"], untitled: "Person" };
      expect(await connector.row({ ...shape, keyValue: "2" })).toEqual({ key: "2", values: ["Bob"] });
      expect(await connector.row({ ...shape, keyValue: "nope" })).toBeNull();
      expect(await connector.row({ ...shape, keyValue: "99" })).toBeNull();
    });

    it("only reads: a write is refused by the read-only transaction", async () => {
      await expect(readOf(connector)((run) => run({ sql: "SELECT 1; DELETE FROM people", params: [] }))).rejects.toThrow();
      await expect(connector.describe({ query: "SELECT 1" })).rejects.toThrow(/tables only/);
      const writer = new MysqlConnector({ name: "W", ...sourceFor(kind, url!, DB), schemas: [], timeoutMs: 5000 }, kind);
      try {
        await expect(readOf(writer)((run) => run({ sql: "DELETE FROM people", params: [] }))).rejects.toThrow(/READ ONLY/i);
        expect((await connector.query(base())).total).toBe(6);
      } finally {
        await writer.close();
      }
    });

    it("warns about a user that can write, and a server of the other kind", async () => {
      const other = kind === "mysql" ? "mariadb" : "mysql";
      const writer = new MysqlConnector({ name: "W", ...sourceFor(other, url!, DB), schemas: [], timeoutMs: 5000 }, other);
      try {
        const warnings = (await writer.check()).join("\n");
        expect(warnings).toMatch(/superuser/);
        expect(warnings).toMatch(new RegExp(`is a ${kind === "mysql" ? "MySQL" : "MariaDB"} server`));
        // Read as what it is afterwards.
        expect((await writer.query(base())).total).toBe(6);
      } finally {
        await writer.close();
      }
    });

    it("stops a statement at the source's time limit", async () => {
      const slow = new MysqlConnector({ name: "S", ...sourceFor(kind, url!, DB), schemas: [], timeoutMs: 300 }, kind);
      try {
        const started = Date.now();
        await expect(
          readOf(slow)((run) =>
            run({ sql: "SELECT COUNT(*) AS n FROM information_schema.COLUMNS a, information_schema.COLUMNS b, information_schema.COLUMNS c", params: [] }),
          ),
        ).rejects.toThrow(/too long/);
        expect(Date.now() - started).toBeLessThan(4000);
      } finally {
        await slow.close();
      }
    });

    it("offers only its databases", async () => {
      const narrow = new MysqlConnector({ name: "N", ...sourceFor(kind, url!, DB, READER), schemas: ["other"], timeoutMs: 5000 }, kind);
      try {
        expect(await narrow.tables()).toEqual([]);
        await expect(narrow.describe({ table: { schema: DB, name: "people" } })).rejects.toThrow(/doesn't offer/);
      } finally {
        await narrow.close();
      }
    });
  });
});
