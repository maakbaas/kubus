// The local database's migrations: how a device's database made by an older version of the app
// becomes this version's (schema.sql), keeping its data. Version 1 is the first release's schema
// (schema-v1.sql, frozen); each migration brings it one version further. A new database is made
// from schema.sql at the newest version and runs none. migrations.test.ts checks that version 1
// plus every migration gives exactly schema.sql's tables, columns, indexes and triggers.
//
// Rules (docs/migrations.md):
//  * Never edit or remove a released migration; fix one with the next.
//  * Change schema.sql and add the migration together; a synced table or column also goes in
//    shared/sync.ts (with SYNC_VERSION raised, SYNC_COMPATIBLE too if older devices would get the
//    new data wrong) and, beyond an added table or column, in server/src/migrations.ts.
//  * They run in one transaction with foreign keys off (a table can be rebuilt: SQLite's "12 steps"
//    of ALTER TABLE), before anything else reads the database; a failure leaves it as it was, and
//    the app shows the error. They don't sync: the outbox triggers are off meanwhile (each side
//    converts its own copy; the server's migration converts its rows) and made afresh afterwards.

// The oo1 API's TypeScript overloads are very strict; we only use a small, stable subset.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = any;

export interface Migration {
  /** 2, 3, 4, … in order (1 is schema-v1.sql). */
  version: number;
  /** What it changes, for people. */
  description: string;
  /** SQL, or code for what SQL can't say (converting JSON with the domain's own functions, say). */
  up: string | ((db: Db) => void);
}

/** The body of item_links' two triggers (schema.sql): the same in both. Frozen with migration 2. */
const ITEM_LINKS_TRIGGER = `BEGIN
  INSERT INTO item_links (id, source_item_id, source_field_id, targets, updated_at, deleted_at)
    SELECT NEW.item_id || '/' || NEW.field_id, NEW.item_id, NEW.field_id, x.targets, NEW.updated_at,
           CASE WHEN x.targets = '[]' THEN NEW.updated_at END
      FROM (SELECT link_targets(f.kind, f.target_collection_id, NEW.value_text, NEW.value_ref, NEW.value_json) AS targets
              FROM fields f WHERE f.id = NEW.field_id) x
     WHERE x.targets <> '[]' OR EXISTS (SELECT 1 FROM item_links l WHERE l.id = NEW.item_id || '/' || NEW.field_id AND l.deleted_at IS NULL)
    ON CONFLICT (id) DO UPDATE SET targets = excluded.targets, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at
      WHERE item_links.targets IS NOT excluded.targets OR item_links.updated_at IS NOT excluded.updated_at OR item_links.deleted_at IS NOT excluded.deleted_at;
END;`;

export const MIGRATIONS: Migration[] = [
  {
    version: 2,
    description: "item_links: which items each value links to (backlinks)",
    up(db) {
      db.exec(`
CREATE TABLE item_links (
  id              TEXT PRIMARY KEY,   -- source_item_id || '/' || source_field_id
  source_item_id  TEXT NOT NULL,
  source_field_id TEXT NOT NULL,
  targets         TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);
CREATE INDEX idx_item_links_item ON item_links(source_item_id);
CREATE TRIGGER item_links_insert AFTER INSERT ON field_values WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'sync_applying') ${ITEM_LINKS_TRIGGER}
CREATE TRIGGER item_links_update AFTER UPDATE ON field_values WHEN NOT EXISTS (SELECT 1 FROM meta WHERE key = 'sync_applying') ${ITEM_LINKS_TRIGGER}
`);
      // The rows of the values already there, with the value's own stamp: what every other device makes of
      // the same values (the engine defines link_targets before it migrates). A migration queues nothing by
      // itself and the server has none of them yet, so they are queued here; it keeps equal ones it has.
      db.exec(`
INSERT INTO item_links (id, source_item_id, source_field_id, targets, updated_at, deleted_at)
  SELECT w.id, w.item_id, w.field_id, w.targets, w.updated_at, NULL
    FROM (SELECT fv.item_id || '/' || fv.field_id AS id, fv.item_id AS item_id, fv.field_id AS field_id, fv.updated_at AS updated_at,
                 link_targets(f.kind, f.target_collection_id, fv.value_text, fv.value_ref, fv.value_json) AS targets
            FROM field_values fv JOIN fields f ON f.id = fv.field_id
           WHERE f.kind IN ('item', 'item_list', 'markdown', 'html', 'ai')) w
   WHERE w.targets <> '[]';
INSERT INTO sync_outbox (tbl, pk) SELECT 'item_links', id FROM item_links;
`);
    },
  },
];
