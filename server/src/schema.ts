import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SYNC_TABLES, type ColumnType, type SyncTable, type WireValue } from "../../shared/sync.ts";

// The server's schema: the synced tables follow from their list (shared/sync.ts), so they can't
// drift from what devices send; schema.sql adds the server's own (sequence, database id, file
// bytes). Applied idempotently at every start, after the migrations (server/src/migrations.ts):
// a table or column added to the list is added here by itself (CREATE TABLE / ADD COLUMN IF NOT
// EXISTS); anything else (a rename, another type, converted values) is a migration. A readable
// replica: no foreign keys or CHECKs (the server trusts clients and a partial push must never
// fail); `seq` orders changes for pulling (server/src/sync.ts).

export const PG_TYPE: Record<ColumnType, string> = {
  text: "text", number: "double precision", int: "integer", bool: "boolean",
  json: "jsonb", date: "date", timestamp: "timestamptz",
};

/** A column default as SQL (wire values: bool as 0 / 1, json as text). */
function literal(type: ColumnType, v: WireValue): string {
  if (v === null) return "NULL";
  if (type === "bool") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  return `'${v.replace(/'/g, "''")}'::${PG_TYPE[type]}`;
}

/** A column's type, and its default for rows written without it. */
function columnSql(t: SyncTable, c: string): string {
  const type = t.columns[c];
  const fallback = t.defaults?.[c];
  return `${PG_TYPE[type]}${t.key.includes(c) ? " NOT NULL" : ""}${fallback === undefined ? "" : ` DEFAULT ${literal(type, fallback)}`}`;
}

/** A synced table, and the columns added to it since it was made. */
function tableSql(t: SyncTable): string {
  const cols = Object.keys(t.columns);
  return [
    `CREATE TABLE IF NOT EXISTS ${t.name} (`,
    ...cols.map((c) => `  ${c.padEnd(14)} ${columnSql(t, c)},`),
    "  seq            bigint NOT NULL DEFAULT 0,",
    `  PRIMARY KEY (${t.key.join(", ")})`,
    ");",
    ...cols.filter((c) => !t.key.includes(c)).map((c) => `ALTER TABLE ${t.name} ADD COLUMN IF NOT EXISTS ${c} ${columnSql(t, c)};`),
    `CREATE INDEX IF NOT EXISTS idx_${t.name}_seq ON ${t.name}(seq);`,
  ].join("\n");
}

/** The whole schema: the synced tables, then schema.sql. */
export async function loadSchema(): Promise<string> {
  const own = await readFile(join(import.meta.dirname, "../schema.sql"), "utf8");
  return `${SYNC_TABLES.map(tableSql).join("\n\n")}\n\n${own}`;
}
