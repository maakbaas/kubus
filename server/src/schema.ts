import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SYNC_TABLES, type ColumnType, type SyncTable } from "../../shared/sync.ts";

// The server's schema: the synced tables follow from their list (shared/sync.ts), so they can't
// drift from what devices send; schema.sql adds the server's own (sequence, database id, file
// bytes). Created if missing at every start, and after a wipe; no migrations (pre-alpha: a changed
// schema means a new database). A readable replica: no foreign keys or CHECKs (the server trusts
// clients and a partial push must never fail); `seq` orders changes for pulling (server/src/sync.ts).

export const PG_TYPE: Record<ColumnType, string> = {
  text: "text", number: "double precision", int: "integer", bool: "boolean",
  json: "jsonb", date: "date", timestamp: "timestamptz",
};

/** A synced table. */
function tableSql(t: SyncTable): string {
  const cols = Object.entries(t.columns);
  const isKey = (c: string) => t.key.includes(c);
  return [
    `CREATE TABLE IF NOT EXISTS ${t.name} (`,
    ...cols.map(([c, type]) => `  ${c.padEnd(14)} ${PG_TYPE[type]}${isKey(c) ? " NOT NULL" : ""},`),
    "  seq            bigint NOT NULL DEFAULT 0,",
    `  PRIMARY KEY (${t.key.join(", ")})`,
    ");",
    `CREATE INDEX IF NOT EXISTS idx_${t.name}_seq ON ${t.name}(seq);`,
  ].join("\n");
}

/** The whole schema: the synced tables, then schema.sql. */
export async function loadSchema(): Promise<string> {
  const own = await readFile(join(import.meta.dirname, "../schema.sql"), "utf8");
  return `${SYNC_TABLES.map(tableSql).join("\n\n")}\n\n${own}`;
}
