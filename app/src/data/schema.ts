// The local database's schema: schema.sql, and the outbox triggers of the synced tables, which
// follow from their list (shared/sync.ts) so they can't miss a table.

import tables from "./schema.sql?raw";
import { filesUsedBy } from "../../../shared/files";
import { SYNC_TABLES, type SyncTable } from "../../../shared/sync";

/** SQL function file_ids(value_file, value_text): the files a value uses, as a JSON array (file_uses' triggers call it). */
export const fileIds = (file: unknown, text: unknown) => JSON.stringify(filesUsedBy([{ value_file: file, value_text: text }]));

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

export const schema = tables + SYNC_TABLES.flatMap(outboxTriggers).join("");
