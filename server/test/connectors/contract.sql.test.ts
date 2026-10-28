// @vitest-environment node
// The Postgres, MySQL and MariaDB connectors against real servers (KUBUS_TEST_POSTGRES, KUBUS_TEST_MYSQL,
// KUBUS_TEST_MARIADB), asked the shared contract's questions (contract.ts) of the dataset's people.
import { afterAll, beforeAll, describe } from "vitest";
import { MysqlConnector } from "../../src/connectors/mysql.ts";
import { PostgresConnector } from "../../src/connectors/postgres.ts";
import type { MemoryRow } from "../../src/connectors/memory.ts";
import type { SourceColumn } from "../../../shared/sources.ts";
import { admin as mysqlAdmin, createDatabase as createMysql, dropDatabase as dropMysql, SERVERS, sourceFor as mysqlSource } from "../mysql.ts";
import { admin as pgAdmin, ADMIN as PG, dropDatabase as dropPg, sourceFor as pgSource } from "../postgres.ts";
import { runContract, type Fixture } from "./contract.ts";
import { PEOPLE, type Person } from "./dataset.ts";

const COLUMNS: SourceColumn[] = [
  { name: "id", type: "integer", kind: "number" },
  { name: "name", type: "text", kind: "string" },
  { name: "age", type: "integer", kind: "number" },
  { name: "score", type: "numeric", kind: "number" },
  { name: "active", type: "boolean", kind: "checkbox" },
  { name: "born", type: "date", kind: "date" },
  { name: "seen", type: "timestamptz", kind: "datetime" },
  { name: "tags", type: "text[]", kind: "string_list" },
  { name: "city", type: "text", kind: "string" },
];

/** A value as SQL text (quotes doubled; MySQL reads a backslash as an escape, Postgres doesn't). */
const sql = (v: string | number | boolean | null, backslashes = false) =>
  v === null ? "NULL" : typeof v === "string" ? `'${(backslashes ? v.replace(/\\/g, "\\\\") : v).replace(/'/g, "''")}'` : String(v);

/** The people as the app should read them: no list is an empty list. */
const rowOf = (p: Person): MemoryRow => ({ ...p, tags: p.tags ?? [] });

describe.skipIf(!PG)("Postgres connector, asked the shared contract", () => {
  const DB = "kubus_contract_test";
  let fixture: Fixture;
  let connector: PostgresConnector;

  beforeAll(async () => {
    // Texts sort by the database's collation: pinned, so that this runs the same on any server (docs/sync.md "Known limits").
    await dropPg(DB);
    await pgAdmin(`CREATE DATABASE ${DB} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8'`);
    await pgAdmin("DROP ROLE IF EXISTS kubus_contract_reader");
    const inserts = PEOPLE.map(
      (p) =>
        `(${[p.id, p.name, p.age, p.score, p.active, p.born, p.seen, p.tags === null ? null : `{${p.tags.map((t) => `"${t.replace(/["\\]/g, "\\$&")}"`).join(",")}}`, p.city].map((v) => sql(v)).join(", ")})`,
    );
    await pgAdmin(
      `SET standard_conforming_strings = on;
       CREATE TABLE people (id integer PRIMARY KEY, name text, age integer, score numeric(12, 3), active boolean, born date, seen timestamptz, tags text[], city text);
       INSERT INTO people VALUES ${inserts.join(",\n")};
       CREATE ROLE kubus_contract_reader LOGIN PASSWORD 'reader';
       GRANT SELECT ON ALL TABLES IN SCHEMA public TO kubus_contract_reader;`,
      DB,
    );
    connector = new PostgresConnector({ name: "TEST", ...pgSource(DB, { name: "kubus_contract_reader", password: "reader" }), schemas: [], timeoutMs: 10_000 });
    fixture = { connector, target: { table: { schema: "public", name: "people" } }, columns: COLUMNS, rows: PEOPLE.map(rowOf), key: "id", title: ["name", "city"], text: (a, b) => (a < b ? -1 : a > b ? 1 : 0) };
  });

  afterAll(async () => {
    await connector?.close();
    await dropPg(DB);
    await pgAdmin("DROP ROLE IF EXISTS kubus_contract_reader");
  });

  runContract(() => fixture);
});

describe.each([
  ["mysql", SERVERS.mysql],
  ["mariadb", SERVERS.mariadb],
] as const)("%s connector, asked the shared contract", (kind, url) => {
  const DB = "kubus_contract_test";
  let fixture: Fixture;
  let connector: MysqlConnector;

  describe.skipIf(!url)("on a server", () => {
    beforeAll(async () => {
      await createMysql(url!, DB);
      // A SET holds no comma ("a,b" is "ab" here), keeps its members in the order they were declared, and (with the
      // case-insensitive collation the connection compares in) can't tell "Music" from "music": it is "jazz" here.
      const MEMBERS = ["ab", "jazz", "math", "music", "poetry", "x"];
      const tags = (p: Person) => (p.tags === null ? null : MEMBERS.filter((m) => p.tags!.map((t) => (t === "a,b" ? "ab" : t === "Music" ? "jazz" : t)).includes(m)));
      const inserts = PEOPLE.map(
        (p) => `(${[p.id, p.name, p.age, p.score, p.active === null ? null : p.active ? 1 : 0, p.born, p.seen === null ? null : p.seen.replace("T", " ").replace("Z", ""), tags(p)?.join(",") ?? null, p.city].map((v) => sql(v, true)).join(", ")})`,
      );
      await mysqlAdmin(
        url!,
        `CREATE TABLE people (id int PRIMARY KEY, name varchar(100), age int, score decimal(12, 3), active tinyint(1), born date, seen timestamp(3) NULL DEFAULT NULL,
           tags set('ab', 'jazz', 'math', 'music', 'poetry', 'x'), city varchar(50));
         INSERT INTO people VALUES ${inserts.join(",\n")};
         DROP USER IF EXISTS 'kubus_contract_reader'@'%';
         CREATE USER 'kubus_contract_reader'@'%' IDENTIFIED BY 'reader';
         GRANT SELECT ON \`${DB}\`.* TO 'kubus_contract_reader'@'%'`,
        DB,
      );
      connector = new MysqlConnector({ name: "TEST", ...mysqlSource(kind, url!, DB, { name: "kubus_contract_reader", password: "reader" }), schemas: [], timeoutMs: 10_000 }, kind);
      fixture = {
        connector,
        target: { table: { schema: DB, name: "people" } },
        columns: COLUMNS,
        rows: PEOPLE.map((p) => ({ ...rowOf(p), tags: tags(p) ?? [] })),
        key: "id",
        title: ["name", "city"],
        // Accents and case don't tell texts apart when sorting (docs/sync.md): the key decides.
        text: new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare,
        looseTies: true,
      };
    });

    afterAll(async () => {
      await connector?.close();
      await dropMysql(url!, DB);
      await mysqlAdmin(url!, "DROP USER IF EXISTS 'kubus_contract_reader'@'%'");
    });

    runContract(() => fixture);
  });
});
