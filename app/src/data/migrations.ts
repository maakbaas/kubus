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

export const MIGRATIONS: Migration[] = [
  {
    version: 2,
    description: "A collection's title field (collections.title_field; null: the first text field with a value, as before)",
    up: "ALTER TABLE collections ADD COLUMN title_field TEXT",
  },
];
