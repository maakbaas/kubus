# Schema changes and migrations

From the first release on, a schema change never costs data: a device's database, the server's
database all carry on, and a device or server that is not yet updated is told so and loses nothing. Three
mechanisms, each with a test that fails when a change skips it:

| Where | What | Code | Test |
|---|---|---|---|
| A device (SQLite) | numbered migrations from the first release's schema | `app/src/data/migrations.ts`, `sqlite/engine.ts` | `data/migrations.test.ts` (also: `fixture-v1.sql` migrated keeps every row), `sqlite/engine.test.ts` |
| The server (Postgres) | added tables / columns by themselves; anything else a numbered migration | `server/src/schema.ts`, `server/src/migrations.ts` | `server/test/database.test.ts` (with `KUBUS_TEST_POSTGRES`: `docs/testing.md`) |
| Between versions (sync) | the strict `SYNC_VERSION` gate: only equal versions sync | `shared/sync.ts`, `server/src/sync.ts` (`refusal`), `SyncEngine` | `data/sync/spec.test.ts`, `versions.test.ts`, `outbox.test.ts`, `server/test/sync.test.ts` |

There was no ready-made way: SQLite has only `PRAGMA user_version`, and a migration library for
Postgres (node-pg-migrate and the like) would cover only the server and not keep the device and the
server in step. So the mechanism is our own and small, and the same on both sides: numbered,
append-only migrations in one transaction, the version stored in the database.

## A device's database

- `PRAGMA user_version` is the schema's version. Version 1 is the first release's schema, frozen in
  `app/src/data/schema-v1.sql` (never edited). `MIGRATIONS` (2, 3, …) bring a database one version
  further each. A new database is made from `schema.sql` at the newest version and runs none.
- `ensureSchema` (engine.ts), when the worker opens the database, before anything reads it:
  the migrations after its version run in **one transaction** with foreign keys off (so a table can
  be rebuilt), the outbox triggers are made afresh from `shared/sync.ts`, and a migration that
  breaks references between rows fails it. Any failure rolls everything back: the database stays as
  it was and the app shows the error instead of opening.
- A database of a **newer** version (an older app opened it, a cached PWA, say) is not touched:
  opening fails with "update the app".
- Databases made before versions were counted have a hash of their schema in `user_version`: they
  start afresh, as pre-release versions did.
- **Migrations don't sync.** The outbox triggers are off while they run: each side converts its own
  copy (the server's rows by a server migration).
- `migrations.test.ts` makes a database from `schema-v1.sql`, migrates it and compares it with a
  new one, table by table (columns, types, NOT NULL, defaults, keys, foreign keys, CHECKs), indexes
  and triggers. Changing `schema.sql` without a migration, or the other way round, fails it.

### The migrations so far

| Version | What | SYNC |
|---|---|---|
| 2 | `item_links` (which items each value links to, for backlinks; docs/data-model.md "Item links"): the table, its index and the two triggers on `field_values`, the rows of the values already there (`link_targets`, defined by the engine before it migrates), queued for the server as a migration queues nothing by itself | `SYNC_VERSION` 2. The server makes the table by itself. |
| 3 | `dashboards` and `dashboard_views` (a dashboard's tabs, per space) with its index; `bookmarks` rebuilt (a CHECK and a NOT NULL change): `kind` may be `dashboard`, `collection_id` nullable, `dashboard_id` added last. Its rows are copied as they are; nothing is queued | `SYNC_VERSION` 3. The server makes the tables and the column by itself (its tables have no CHECKs, and no NOT NULL but keys). |

A block listing several collections keeps `collectionIds` and `merges` in its JSON (a view's config, an item view's layout): no schema change, no
migration, no sync version. An older device parses blocks leniently (`parseBlock`, `parseLayout` leave what they don't know) and shows such a block
as its first collection only; saving a view there drops the two keys. Since dashboards (version 3) a block of several collections is made only
on a dashboard; one made before in a view or item view is kept as it is (no migration: it keeps showing them, and can only lose some, or be
moved to a dashboard), so no data is lost.

## The server's database

- The synced tables follow `SYNC_TABLES` (`server/src/schema.ts`): `CREATE TABLE IF NOT EXISTS`
  and `ADD COLUMN IF NOT EXISTS` for every column, so **an added synced table or column needs
  nothing on the server**. Their types are checked at start: a column of another type stops sync
  with the error (a type change is a migration).
- Everything else is a numbered migration in `server/src/migrations.ts` (SQL, or code with the
  `pg` client): a rename, a type change, converted values, a change to the server's own tables
  (`server/schema.sql`). At every start (and after a wipe), in **one transaction** under an advisory
  lock: the migrations not yet in `schema_migrations` run in order, then the schema, then the check.
  A new database only records them (the schema is already the newest).
- A database migrated by a **newer** server (a migration this one doesn't know) is not touched: the
  server starts but sync answers with the error until it is updated (or the database wiped).

## Devices and server of different versions: the strict gate

Only a device and a server with the **same** `SYNC_VERSION` sync, in both directions. There is no
compatibility range and no code for talking to an older or newer side: every release with a sync
change is rolled out together, the server first, then every device. The web and home-screen app come
from the server, so they match it once reloaded; the desktop app is reinstalled.

- `SYNC_VERSION` (`shared/sync.ts`) is the version of the synced data's shape: the list of tables and
  columns and what their values may hold. `spec.test.ts` records the list of the current version
  and fails when it changes until the version is raised and recorded again. **Every release that changes
  the list or what a synced value may hold raises it** (an added column or table, a new field kind, a changed
  JSON format: all of them).
- Every sync request carries the device's version. The server answers **426** (`SyncOutdated`) and writes
  nothing when it differs: `update: "app"` when the device is older ("update this device"),
  `update: "server"` when it is newer ("update the server"). Every sync answer and `/api/health` carry the
  server's version, and the device refuses a response of another one too (and "Test connection" says so before
  connecting). The server's own headless device (the API) is the same build and so always equal: the server
  checks the bundle's `syncVersion` before starting it, and a stale `server/headless` (built before an update)
  says to run `npm run build:headless`.
- **A refused device loses nothing.** It keeps working fully offline; its outbox is untouched (nothing is
  dropped or marked as sent, and a first connection that was refused made no change); the status button and
  Settings → Sync say "Update Kubus to keep syncing" (the device is older) or "The server needs updating"
  (the server is older), not a generic error, with "Reload to update" in a browser. It asks again at every
  sync (reload, every 30 s, a change signal): once the versions match, a sync sends what was queued. A new
  build opens the old build's database as always (its migrations run first), so after updating, the queued
  changes sync normally. A device that never updates only stops syncing.
- The web app picks a new build up on reload: its service worker (`app/sw.js`) is stamped per build, takes over
  at once (`skipWaiting`, `clients.claim`) and serves pages network first.
- A row written before a column existed has it NULL on the server; a NOT NULL column added after the
  first release needs a value for that (`SyncTable.defaults`: the server's column default and what
  a device stores for such a NULL). `spec.test.ts` checks every such column has one.
- Rows are still written in the columns they have, on both sides (`server/src/sync.ts`, `applyStatement`),
  but that is robustness, not a way to sync across versions.

## Making a change

1. Change `app/src/data/schema.sql` (the newest schema, what a new database gets).
2. Add the migration to `MIGRATIONS` in `app/src/data/migrations.ts` (the next number) that turns
   the previous version into it, data included. SQLite can add, rename and drop columns; anything
   else (a CHECK, a type, NOT NULL) rebuilds the table: create the new one, copy, drop, rename, and
   create its indexes and triggers again. `npm test` compares the result with `schema.sql`.
3. A synced table or column, or anything a synced value may newly hold (a new field kind, a new key in a
   JSON column, another format): change `SYNC_TABLES` in `shared/sync.ts` if the list changes, **raise
   `SYNC_VERSION`** and record the new fingerprint in `spec.test.ts`. A NOT NULL column added to an existing
   table gets `defaults` (a new table's rows are always written whole). A table derived from other rows (as
   `item_links` is) is written by every device together with its values, and rebuilt (`healLinks`) only on a
   first connection to a server that holds values without rows, or by `Repository.rebuildLinks`.
4. Nothing to write for older versions: the gate refuses them. Say in the release notes that the server is
   updated first and then every device (README, "Sync server"); devices that are not updated yet keep their
   changes queued.
5. On the server: nothing for an added synced table or column. A rename, a type change, converted
   values, a dropped column or a change to `server/schema.sql`: a migration in
   `server/src/migrations.ts` doing to the server's rows what the device's migration does to its own. The
   gate makes that safe: no older device writes the old format to the converted server.
6. Never edit or remove a released migration (or `schema-v1.sql`); fix one with the next.
7. Run `npm test` (with `KUBUS_TEST_POSTGRES` for the server's migrations) and write a test for a
   migration that converts data: a database of the previous version with rows, migrated.
