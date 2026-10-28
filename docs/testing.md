# Testing

Three kinds of tests, each split by the part of the app it covers, so that a change runs the
tests of what it touched and CI stays a few minutes.

| Kind | Where | Run | CI (`.github/workflows/`) |
|---|---|---|---|
| Unit and integration (vitest, seconds) | next to the code in `app/src`; the server's in `server/test` | `npm test` (all), `npm test -- --project <name>`, `npm run test:changed` | `test.yml` (unit job, Linux, with Postgres) and `build.yml` (Windows: the app's projects) |
| GUI (playwright-cli, minutes to an hour) | `gui-tests/suites/NN-*.js` | `npm run test:gui:smoke`, `npm run test:gui -- --changed [--smoke]`, `--suite NN` | `test.yml` (gui job): the smoke tests of the suites the branch's changes reach; all smoke tests on main |
| Rust | `desktop/` | `cargo test` (with clippy, fmt) | `build.yml` |

The full GUI suite (~275 tests, about an hour) is not in CI: run it before larger changes and
before calling the GUI stable (`gui-tests/README.md`).

## The vitest projects

`vitest.config.ts` defines them. `npm test -- --project sync --project api` runs several;
`npm run test:changed` runs the tests that import a file changed since origin/main (vitest follows
the imports).

| Project | Covers | Files | Needs |
|---|---|---|---|
| `domain` | the storage-agnostic model: query, views, fields, components, AI prompts, links, tags | `app/src/domain/*.test.ts` | nothing |
| `storage` | the device's database: schema and migrations (`fixture-v1.sql` migrated keeps every row), the engine, the Repository contract (`repository*.test.ts`: refusals, soft deletes, files and their clean-up), the worker (`worker.test.ts`, with the SAH-pool VFS faked: it is installed only once the lock is held and the files are free) and its lock rules (`dbLock.test.ts`), the main thread's side of the worker protocol (`client.test.ts`) | `app/src/data/*.test.ts`, `app/src/data/sqlite/*.test.ts` | nothing |
| `sync` | the device's side of sync (outbox, merge of two devices' edits, files, first connection, versions, the engine's timing and error states, the server's change signal) against `FakeServer` (`app/src/test/fakeServer.ts`); the client of the server's remote sources; the router and helpers of `shared/` (their tests live in `app/src`: `shared/` is copied whole into the server's image and typechecked without vitest) | `app/src/data/sync/*.test.ts`, `app/src/data/remote/*.test.ts` | nothing |
| `api` | the HTTP API (`/api/v1`, the headless device): every route and its errors (`apiRoutes.test.ts`, checked against `help/api.md`), values by kind, the component compiler, webhooks and the device's 503s, against `FakeServer` | `app/src/headless/*.test.ts` | nothing |
| `app` | the app's own logic outside the UI (AI client and backfill, platform) | `app/src/{app,platform,ui,views,pages,workspace}/*.test.ts(x)` | nothing |
| `connectors` | the remote-source connectors: their query languages run for real (SQLite for D1, the memory connector) or against a stand-in of the service (n8n, InfluxDB, Cloudflare D1's API), Postgres, MySQL and MariaDB against real ones | `server/test/connectors/*.test.ts` | the server's packages; Postgres for `postgres.test.ts`, MySQL 8 and MariaDB for `mysql.test.ts` |
| `server` | the server itself: its database (migrations, sync, wipe), its settings, the MCP protocol and its tools (`mcp.test.ts`, with a fake API), every HTTP endpoint of the real server process (`serve.ts`), and devices syncing through it end to end | `server/test/*.test.ts` | the server's packages, Postgres, `npm run build:headless` for `/api/v1` |

The `connectors` and `server` projects test `server/` code: they need its packages
(`npm ci --prefix server`), and are left out (with a note) without them. Tests that need Postgres
get it from `KUBUS_TEST_POSTGRES`, a superuser's connection string; each test file makes its own
database and drops it again (`server/test/postgres.ts`):

```bash
docker run -d --name kubus-test-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
export KUBUS_TEST_POSTGRES=postgres://postgres:postgres@localhost:5432/postgres
npm ci --prefix server && npm run build:headless
npm test -- --project server --project connectors
```

The MySQL / MariaDB connector's tests (`mysql.test.ts`) get their servers likewise from `KUBUS_TEST_MYSQL`
(MySQL 8) and `KUBUS_TEST_MARIADB`, an account that can create databases and users (`server/test/mysql.ts`);
each server's tests run when its variable is set:

```bash
docker run -d --name kubus-test-mysql -e MYSQL_ROOT_PASSWORD=mysql -p 3306:3306 mysql:8.4
docker run -d --name kubus-test-mariadb -e MARIADB_ROOT_PASSWORD=mariadb -p 3307:3306 mariadb:11.4
export KUBUS_TEST_MYSQL=mysql://root:mysql@127.0.0.1:3306 KUBUS_TEST_MARIADB=mysql://root:mariadb@127.0.0.1:3307
npm test -- --project connectors
```

Without `KUBUS_TEST_POSTGRES` (or those two) they are skipped locally; in CI (`CI` set) that is an error, as is a
missing headless build: nothing is skipped there without anyone noticing.

`FakeServer` stands in for the server in the device's sync and API tests (fast, no Postgres).
`server/test/devices.test.ts` runs the same kind of devices against the real server, so the two
can't drift apart unnoticed: a change to the sync protocol changes both and runs both.

## What to run for a change

| You changed | vitest | GUI suites (`--changed` picks them: `gui-tests/areas.mjs`) |
|---|---|---|
| `app/src/domain/` | `domain` (and what imports it: `test:changed`) | by area: query and views 05, 06, 10, 22; components 07, 19, 22; AI 15 |
| `app/src/data/schema.sql`, `migrations.ts`, `sqlite/` | `storage`, `sync`, `api` | all (every page reads the database) |
| `app/src/data/sync/`, `shared/sync.ts` | `sync`, `server` | 13, 18 |
| `app/src/headless/`, `app/src/help/api.md` | `api`, `server` | none |
| `server/src/connectors/`, `shared/sources.ts` | `connectors` | none |
| `server/src/` | `server` (and `connectors` for `sources.ts`) | none |
| `app/src/views/` | `domain` | 05, 06, 10, 12, 22 |
| `app/src/pages/ItemPage.tsx`, `ui/FieldInput.tsx` and the editors | – | 04, 12, 19 (Markdown 08) |
| `app/src/styles.css`, `ui/PageHeader.tsx`, anything every page uses | – | all |

Before pushing: `npm run typecheck` (and `npm run typecheck --prefix server`, `npm run typecheck:test --prefix server` for server code),
the vitest projects above, and `npm run test:gui -- --changed --smoke` for a change the GUI shows.

## Writing tests

- A test goes in the project of the code it tests, beside it (`app/src`) or in `server/test`
  (`connectors/` for a connector). A new kind of test that fits no project gets one in
  `vitest.config.ts` and a row above.
- A connector's test answers as its service does (a stand-in like `influx.test.ts`, or the real
  engine like `d1.test.ts` on SQLite), and checks that it only reads.
- `fixture-v1.sql` (with `schema-v1.sql`) is frozen: a migration must keep its rows, and the app
  must read them as they were. A later release whose data takes new shapes gets a fixture of
  its own version, made with that release's app.
- A GUI suite's new area goes in `gui-tests/areas.mjs`, so `--changed` finds it.
