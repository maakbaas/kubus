# Schema changes and migrations

From the first release on, a schema change never costs data: a device's database, the server's
database and devices of different app versions syncing through one server all carry on. Three
mechanisms, each with a test that fails when a change skips it:

| Where | What | Code | Test |
|---|---|---|---|
| A device (SQLite) | numbered migrations from the first release's schema | `app/src/data/migrations.ts`, `sqlite/engine.ts` | `data/migrations.test.ts` (also: `fixture-v1.sql` migrated keeps every row), `sqlite/engine.test.ts` |
| The server (Postgres) | added tables / columns by themselves; anything else a numbered migration | `server/src/schema.ts`, `server/src/migrations.ts` | `server/test/database.test.ts` (with `KUBUS_TEST_POSTGRES`: `docs/testing.md`) |
| Between versions (sync) | `SYNC_VERSION` / `SYNC_COMPATIBLE`; rows written in the columns they have | `shared/sync.ts`, `server/src/sync.ts`, `SyncEngine.applyStatement` | `data/sync/spec.test.ts`, `versions.test.ts`, `outbox.test.ts` |

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
| 2 | `item_links` (which items each value links to, for backlinks; docs/data-model.md "Item links"): the table, its index and the two triggers on `field_values`, the rows of the values already there (`link_targets`, defined by the engine before it migrates), queued for the server as a migration queues nothing by itself | `SYNC_VERSION` 2, `SYNC_COMPATIBLE` stays 1: an added table, older devices leave it alone and their values get rows from the devices that know it. The server makes the table by itself. |

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

## Devices and server of different versions

The web app and the iOS home-screen app come from the server, so they match it; the desktop app and
a device that hasn't reloaded yet can be older or newer.

- `SYNC_VERSION` (`shared/sync.ts`) is the version of the synced data's shape: the list of tables and
  columns and what their values may hold. `spec.test.ts` records the list of the current version
  and fails when it changes until the version is raised and recorded again.
- `SYNC_COMPATIBLE` is the oldest version that still reads and writes the data correctly.
- Every sync request carries the device's two numbers. The server answers **426** (`SyncOutdated`)
  and writes nothing when the device is older than its `SYNC_COMPATIBLE` ("update the app"), or its
  `SYNC_COMPATIBLE` is newer than the server's `SYNC_VERSION`, or it sends a table or column the
  server doesn't have ("update the server"). The device shows the message and keeps its outbox: once
  one side is updated, everything goes.
- Rows are written **in the columns they have**, on both sides: an older device's row leaves the
  columns it doesn't know as they are on the server (`server/src/sync.ts`), a row from the server
  leaves a device's column the server doesn't send (an older server's) as it is, and a column a
  device doesn't know is left out (`applyStatement`).
- A row written before a column existed has it NULL on the server; a NOT NULL column added after the
  first release needs a value for that (`SyncTable.defaults`: the server's column default and what
  a device stores for such a NULL). `spec.test.ts` checks every such column has one.

## Making a change

1. Change `app/src/data/schema.sql` (the newest schema, what a new database gets).
2. Add the migration to `MIGRATIONS` in `app/src/data/migrations.ts` (the next number) that turns
   the previous version into it, data included. SQLite can add, rename and drop columns; anything
   else (a CHECK, a type, NOT NULL) rebuilds the table: create the new one, copy, drop, rename, and
   create its indexes and triggers again. `npm test` compares the result with `schema.sql`.
3. A synced table or column: change `SYNC_TABLES` in `shared/sync.ts` too, raise `SYNC_VERSION` and
   record the new fingerprint in `spec.test.ts`. A NOT NULL column added to an existing table gets `defaults` (a new table's
  rows are always written whole). A table derived from other rows (as `item_links` is) must also say who writes its rows for
  values an older device wrote without them, and who rebuilds them (`healLinks` after a sync).
4. Decide `SYNC_COMPATIBLE`. **Unchanged** for an added table or column (and a new optional value):
   older devices leave it alone. (A new optional key in a JSON column, like a view's `filterBar` in its
   config, is such a value: an older device ignores it, and drops it only if it saves that view itself; a
   display preference lost that way is not worth locking older devices out.) **Raised to `SYNC_VERSION`** when older devices would get the data
   wrong: a value's meaning or format changes (a view's config JSON, say), a value an older device's
   CHECK refuses (a new field kind), a renamed or dropped column. The server then turns older devices
   away until they are updated, so update the server first.
5. On the server: nothing for an added synced table or column. A rename, a type change, converted
   values, a dropped column or a change to `server/schema.sql`: a migration in
   `server/src/migrations.ts` doing to the server's rows what the device's migration does to its own.
6. Never edit or remove a released migration (or `schema-v1.sql`); fix one with the next.
7. Run `npm test` (with `KUBUS_TEST_POSTGRES` for the server's migrations) and write a test for a
   migration that converts data: a database of the previous version with rows, migrated.
