import { describe, expect, it } from "vitest";
import { schema } from "../schema";
import firstRelease from "../schema-v1.sql?raw";
import { SYNC_COMPATIBLE, SYNC_TABLES, SYNC_VERSION } from "../../../../shared/sync";

/**
 * The synced tables of SYNC_VERSION as this test last saw them. When the list changes, raise
 * SYNC_VERSION (and SYNC_COMPATIBLE if older devices would get the new data wrong), write the
 * migrations (docs/migrations.md) and record the new version and fingerprint here.
 */
const RECORDED = { version: 2, fingerprint: "5c16a825" };

/** A short, stable fingerprint of the list (FNV-1a of its JSON). */
function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

const LOCAL_ONLY = ["meta", "sync_outbox", "file_uses"];
/** Columns of synced tables that stay on the device. */
const LOCAL_COLUMNS: Record<string, string[]> = { files: ["data", "unused_since"] };

/** Column names of every CREATE TABLE in an SQL file. */
function columnsByTable(sql: string): Map<string, string[]> {
  return new Map([...definitions(sql)].map(([t, columns]) => [t, [...columns.keys()]]));
}

/** Every CREATE TABLE's columns, with their definitions. */
function definitions(sql: string): Map<string, Map<string, string>> {
  const tables = new Map<string, Map<string, string>>();
  for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+) \(([\s\S]*?)\n\);/g)) {
    tables.set(m[1], new Map([...m[2].matchAll(/^ {2}([a-z_]+)\s+([A-Za-z].*)$/gm)].map((c) => [c[1], c[2]])));
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

  it("has a version for each shape of the list", () => {
    expect(SYNC_COMPATIBLE).toBeLessThanOrEqual(SYNC_VERSION);
    expect({ version: SYNC_VERSION, fingerprint: fingerprint(SYNC_TABLES) }, "SYNC_TABLES changed: see RECORDED in this file").toEqual(RECORDED);
  });

  it("gives a default to every NOT NULL column added since the first release (rows written without it)", () => {
    const first = definitions(firstRelease);
    const now = definitions(schema);
    for (const t of SYNC_TABLES) {
      for (const c of Object.keys(t.columns)) {
        if (first.get(t.name)?.has(c) || !/NOT NULL/.test(now.get(t.name)?.get(c) ?? "")) continue;
        expect(t.defaults?.[c], `${t.name}.${c}: NOT NULL, new since the first release`).toBeDefined();
      }
    }
    for (const t of SYNC_TABLES) for (const c of Object.keys(t.defaults ?? {})) expect(t.columns[c], `default of ${t.name}.${c}`).toBeDefined();
  });

  it("queues changes of every replicated table in the outbox", () => {
    for (const t of SYNC_TABLES) {
      expect(schema, t.name).toContain(`CREATE TRIGGER sync_${t.name}_insert`);
      if (t.version) expect(schema, t.name).toContain(`CREATE TRIGGER sync_${t.name}_update`);
    }
  });
});
