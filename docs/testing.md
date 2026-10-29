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
| `app` | the app's own logic outside the UI: the AI service and backfill, the item cache, the workspace layout, block registry and item actions, remote paging, platform adapters, and the hooks and browser-facing helpers (`ui/`), run without a DOM | `app/src/{app,platform,ui,views,pages,workspace,test}/*.test.ts(x)` | nothing |
| `connectors` | the remote-source connectors, against the real services wherever one runs locally: Postgres, MySQL 8, MariaDB, InfluxDB 2, n8n and Actual Budget (with actual-http-api) in containers; CSV, JSON, NDJSON and ICS from real files over real local HTTP servers; D1 on a real SQLite behind a stand-in of Cloudflare's API (D1 itself doesn't run locally); the shared contract (`contract.ts`) asked of each; the unit tests of their query languages and the memory connector | `server/test/connectors/*.test.ts` | the server's packages; per service the variable below (its tests are skipped without it) |
| `server` | the server itself: its modules in-process (so coverage counts them: sync, schema, migrations and wipe in `sync.test.ts` and `database.test.ts`; `tokens`, `files` against Postgres; `sources` with stand-in connectors; `ai` against a stand-in provider; `events`; `headless`), its settings, the MCP protocol and its tools (`mcp.test.ts`, with a fake API), every HTTP endpoint of the real server process (`serve.ts`: `http.test.ts` the working paths, `endpoints.test.ts` the 400 / 401 / 403 / 404 / 405 / 413 ones), and devices syncing through it end to end | `server/test/*.test.ts` | the server's packages, Postgres, `npm run build:headless` for `/api/v1` |

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

The connectors' other real services are in `tests/services.yml` under the compose profile `connectors`
(`tests/setup-env.sh --connectors` starts them all; or `docker compose -f tests/services.yml --profile connectors up -d --wait influxdb`
for one); `tests/env.sh` sets a variable for each that answers, and a test file without its variable is skipped:

| Service (pinned image) | Variable | Files | Seeded through | Start / test time (4 busy CPUs) | CI |
|---|---|---|---|---|---|
| InfluxDB 2.7.12 | `KUBUS_TEST_INFLUX` (`_ORG`, `_TOKEN`: the image's setup) | `influx.real.test.ts` | its HTTP API: a bucket, line protocol, a read-only token (`influxSeed.ts`) | 4 s / 35 s | yes |
| n8n 2.45.5 | `KUBUS_TEST_N8N` | `n8n.real.test.ts` | owner setup and API keys (`/rest`), data tables (`/api/v1/data-tables`) (`n8nSeed.ts`) | 1 to 2 min / 17 s | yes |
| Actual Budget server 26.10.0 + actual-http-api 26.10.1 | `KUBUS_TEST_ACTUAL` (`_KEY`) | `actual.real.test.ts` | actual-http-api's write routes; the empty budget is made by `actualSeed.cjs` when the `actual-api` service starts | 45 s / 25 s | no: two services and a mounted script (a job's service containers can have neither) |

A CI job that has the service sets the variable and a missing one is an error there. Docker Hub rate-limits
anonymous pulls: `mirror.gcr.io/<image>` has the same images (`docker tag` them to the pinned names).

What the connector tests ask, for every connector that can answer it:

- `contract.ts` (the shared contract, `shared/sources.ts`): a fixture says what a service holds (the dataset's people,
  `dataset.ts`, loaded through the service's own API) and `contractCases` derives every filter operator of each column's
  type, every sort, a search, every page, every grouping and order, trees of and / or, a row by its key and the requests
  that must be refused; each answer must equal memory.ts's `queryRows` (the app's own meaning, `applyQuery`) on the rows
  the service holds. Where a source differs by its documented limits (docs/sync.md "Known limits": text order, a tie's
  order) the fixture says how (`text`, `looseTies`), not the case.
- Each service's own: listing, types of every column, errors (a wrong key or password, an unreachable host, a missing
  table, a key without the scope, the time limit) and that it only reads (the data is the same after, the key can't write).
- `http.transport.test.ts`: the HTTP connectors with real files: 20,000 rows, the row and size limits, encodings (a BOM,
  declared charsets, UTF-16), malformed content, redirects (the password stays on its origin), statuses, slow and cut-off
  bodies, the password in each place, pages, revalidation.

Without `KUBUS_TEST_POSTGRES` (or those two) they are skipped locally; in CI (`CI` set) that is an error, as is a
missing headless build: nothing is skipped there without anyone noticing.

`FakeServer` stands in for the server in the device's sync and API tests (fast, no Postgres).
`renderHook` (`app/src/test/hooks.ts`) runs a React hook in node, without a DOM or renderer (state, effects, external stores); a test mocks `../app/store` for `useStore`. Pure logic of a hook is better extracted and tested on its own (`views/itemActions.ts`, `views/remotePages.ts`); browser APIs (viewport, selection, canvas) are stubbed per test with `vi.stubGlobal`.
`server/test/devices.test.ts` runs the same kind of devices against the real server, so the two
can't drift apart unnoticed: a change to the sync protocol changes both and runs both.

## What to run for a change

| You changed | vitest | GUI suites (`--changed` picks them: `gui-tests/areas.mjs`) |
|---|---|---|
| `app/src/domain/` | `domain` (and what imports it: `test:changed`) | by area: query and views 05, 06, 10, 22; components 07, 19, 22; AI 15 |
| `app/src/data/schema.sql`, `migrations.ts`, `sqlite/` | `storage`, `sync`, `api` | all (every page reads the database) |
| `app/src/data/sync/`, `shared/sync.ts` | `sync`, `server` | 13, 18 |
| `app/src/headless/`, `app/src/help/api.md` | `api`, `server` | none |
| `app/src/pages/SettingsPage.tsx`, `ui/*Settings.tsx`, `ServerConnection`, `ApiTokens` | `sync` (`SyncEngine`) | 28 (and 13, 18 for sync) |
| `server/src/connectors/`, `shared/sources.ts` | `connectors` | none |
| `server/src/` | `server` (and `connectors` for `sources.ts`) | none |
| `app/src/views/` | `domain` | 05, 06, 10, 12, 22 |
| `app/src/pages/ItemPage.tsx`, `ui/FieldInput.tsx` and the editors | – | 04, 12, 19, 27 (Markdown 08) |
| `pages/CollectionsPage.tsx`, `RemotesPage.tsx`, `CollectionEditorPage.tsx`, `SearchPage.tsx`, `ui/SearchBar.tsx`, `app/NavTree.tsx` | – | 29 (editor also 07, 17, 27) |
| `app/src/styles.css`, `ui/PageHeader.tsx`, anything every page uses | – | all |

Before pushing: `npm run typecheck` (and `npm run typecheck --prefix server`, `npm run typecheck:test --prefix server` for server code),
the vitest projects above, and `npm run test:gui -- --changed --smoke` for a change the GUI shows.

## Coverage

One command gives one report of everything the tests run (`coverage/`, git-ignored):

```bash
npm run test:coverage                         # the vitest projects with V8 coverage (needs what `npm test` needs)
npm run test:gui -- --coverage [--suite NN]   # optional: the GUI tests' coverage of app/src (below)
npm run coverage:report                       # merges what exists: coverage/index.html and a table per directory
```

- **Unit**: `vitest.config.ts` (`coverage`: `app/src`, `server/src`, `shared`, without tests, `app/src/test`, CSS and Markdown) writes
  `coverage/unit/coverage-final.json`. Pass `--coverage.include='<glob>'` and `--coverage.reporter=text-summary` to look at one area.
  Coverage slows tests down, so under `--coverage` a test may take 20 s instead of 5.
- **Server child process**: the HTTP and device tests run the real server as a child process (`server/test/serve.ts`), invisible to vitest.
  Under coverage `vitest.config.ts` sets `KUBUS_V8_DIR`; `serve.ts` then gives the child `NODE_V8_COVERAGE` of that folder (and
  `exitOnTerm.mjs`, because V8 writes a process's coverage when it exits, and `stop()` would kill it). `coverage/server-v8/` holds the dumps.
- **GUI**: `--coverage` makes `run.mjs` build with source maps and each test collect V8 precise coverage over CDP (Chromium; the app's main
  thread, not its workers), into `coverage/gui-v8/`, one file per test (`gui-tests/README.md`).
- **The merge** (`tests/coverage.mjs`) converts the V8 data with `ast-v8-to-istanbul` (the GUI's through the build's source maps, the server's
  through node's type stripping, which keeps offsets) and joins the three maps per file by the place of each statement, function and branch
  in the source, since the transforms behind them number those differently. The table lists per directory the merged percentages and the
  statements each kind reached alone. A kind with no data is left out, so the report is always of what was run.

## Writing tests

- A test goes in the project of the code it tests, beside it (`app/src`) or in `server/test`
  (`connectors/` for a connector). A new kind of test that fits no project gets one in
  `vitest.config.ts` and a row above.
- A connector's test answers as its service does: the real service where one runs locally (`*.real.test.ts`,
  `contract.*.test.ts`), else a stand-in that follows the service's documented answers (`d1Api.ts` for Cloudflare's API,
  `influx.test.ts` and the others' unit tests), and checks that it only reads. A new connector gets a fixture for the
  contract (`contract.ts`) first.
- `fixture-v1.sql` (with `schema-v1.sql`) is frozen: a migration must keep its rows, and the app
  must read them as they were. A later release whose data takes new shapes gets a fixture of
  its own version, made with that release's app.
- A GUI suite's new area goes in `gui-tests/areas.mjs`, so `--changed` finds it.
