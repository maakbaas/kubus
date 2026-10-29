// The local database's schema: schema.sql, and the outbox triggers of the synced tables, which
// follow from their list (shared/sync.ts) so they can't miss a table.

import tables from "./schema.sql?raw";
import { filesUsedBy } from "../../../shared/files";
import { linkTargets } from "../domain/backlinks";
import { SYNC_TABLES, type SyncTable } from "../../../shared/sync";

/** SQL function file_ids(value_file, value_text): the files a value uses, as a JSON array (file_uses' triggers call it). */
export const fileIds = (file: unknown, text: unknown) => JSON.stringify(filesUsedBy([{ value_file: file, value_text: text }]));

/**
 * SQL function link_targets(kind, target_collection_id, value_text, value_ref, value_json): the items a value links to, as
 * `item_links.targets` holds them (item_links' triggers and the heal call it; domain/backlinks.ts).
 */
export const linkTargetsFn = linkTargets;

/**
 * Makes `item_links` agree with the field values, row by row: a value's row that is missing or older than the value is
 * written (updated_at = the value's own, so it is the same row on every device). `keys` limits it to
 * these (item id, field id) pairs (a sync's applied values; null = all of them). `rebuild` also rewrites a row of
 * the same stamp that holds other targets (links recognized differently by this version): not done after a
 * sync, where an equal stamp is the same value. Queued for sync by the table's outbox trigger (not while sync_applying is set).
 */
export function healLinks(keys: [string, string][] | null, rebuild = false): { sql: string; bind: string[] } {
  return {
    sql: `INSERT INTO item_links (id, source_item_id, source_field_id, targets, updated_at, deleted_at)
          SELECT w.id, w.item_id, w.field_id, w.targets, w.updated_at, CASE WHEN w.targets = '[]' THEN w.updated_at END
            FROM (SELECT fv.item_id || '/' || fv.field_id AS id, fv.item_id AS item_id, fv.field_id AS field_id, fv.updated_at AS updated_at,
                         link_targets(f.kind, f.target_collection_id, fv.value_text, fv.value_ref, fv.value_json) AS targets
                    FROM field_values fv JOIN fields f ON f.id = fv.field_id
                   WHERE f.kind IN ('item', 'item_list', 'markdown', 'html', 'ai')
                     ${keys ? "AND (fv.item_id, fv.field_id) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?1))" : ""}) w
            LEFT JOIN item_links l ON l.id = w.id
           WHERE (l.id IS NULL OR l.updated_at < w.updated_at${rebuild ? " OR (l.updated_at = w.updated_at AND l.targets IS NOT w.targets)" : ""})
             AND (w.targets <> '[]' OR (l.id IS NOT NULL AND l.deleted_at IS NULL))
          ON CONFLICT (id) DO UPDATE SET targets = excluded.targets, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at`,
    bind: keys ? [JSON.stringify(keys)] : [],
  };
}

const applied = "WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'sync_applying')";

/** Queues the row's key on an insert (and an update, unless the table is insert only). */
function outboxTriggers(t: SyncTable): string[] {
  const key = t.key.length > 1 ? `json_array(${t.key.map((k) => `NEW.${k}`).join(", ")})` : `NEW.${t.key[0]}`;
  return (t.version ? ["insert", "update"] : ["insert"]).map(
    (op) =>
      `CREATE TRIGGER sync_${t.name}_${op} AFTER ${op.toUpperCase()} ON ${t.name} ${applied}\n` +
      `BEGIN INSERT INTO sync_outbox (tbl, pk) VALUES ('${t.name}', ${key}); END;\n`,
  );
}

/** The outbox triggers alone: made afresh after every migration (engine.ts), so they follow the list. */
export const outboxTriggerSql = SYNC_TABLES.flatMap(outboxTriggers).join("");

/** The whole schema of a new database. */
export const schema = tables + outboxTriggerSql;
