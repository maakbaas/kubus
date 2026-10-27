import { describe, expect, it } from "vitest";
import { schema } from "../schema";
import { SYNC_TABLES } from "../../../../shared/sync";

const LOCAL_ONLY = ["meta", "sync_outbox", "file_uses"];
/** Columns of synced tables that stay on the device. */
const LOCAL_COLUMNS: Record<string, string[]> = { files: ["data"] };

/** Column names of every CREATE TABLE in an SQL file. */
function columnsByTable(sql: string): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+) \(([\s\S]*?)\n\);/g)) {
    const columns = [...m[2].matchAll(/^ {2}([a-z_]+)\s+[A-Za-z]/gm)].map((c) => c[1]);
    tables.set(m[1], columns);
  }
  return tables;
}

describe("sync spec", () => {
  const local = columnsByTable(schema);

  it("lists every replicated table of schema.sql, with all its columns", () => {
    const names = [...local.keys()].filter((t) => !LOCAL_ONLY.includes(t));
    expect(SYNC_TABLES.map((t) => t.name).sort()).toEqual(names.sort());
    for (const t of SYNC_TABLES) {
      const synced = local.get(t.name)!.filter((c) => !LOCAL_COLUMNS[t.name]?.includes(c));
      expect(Object.keys(t.columns).sort(), t.name).toEqual(synced.sort());
      for (const k of t.key) expect(t.columns[k], `${t.name}.${k}`).toBeDefined();
      if (t.version) expect(t.columns[t.version], t.name).toBe("timestamp");
    }
  });

  it("queues changes of every replicated table in the outbox", () => {
    for (const t of SYNC_TABLES) {
      expect(schema, t.name).toContain(`CREATE TRIGGER sync_${t.name}_insert`);
      if (t.version) expect(schema, t.name).toContain(`CREATE TRIGGER sync_${t.name}_update`);
    }
  });
});
