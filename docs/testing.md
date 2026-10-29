# Testing

## What the tests are for

The suite is kept lean on purpose: a change should cost little test work, and a red test should mean a real problem.
Two hard limits:

- **At most 10 minutes of test rework per change.** When keeping a test in step with a change would take longer, the
  test was pinning details: delete it (and say so in the commit), unless it guards data, sync or migrations.
- **The whole suite in at most 30 minutes** (`npm run suite -- full`: every vitest project, the real services, the
  server image and the whole GUI suite on one machine; it fails when over). Over that there are too many tests: drop
  the least meaningful ones (a duplicate window size, a page another sweep already covers), not the data tests.

- **Guarded closely**: what is expensive to get wrong and hard to see by hand. That means data (schema, migrations,
  storage, backups), sync and the server, the HTTP API, and domain logic with real edge cases (query, date periods,
  charts, links, merged collections). Also the GUI's consistency rules (layout, spacing, nothing moving under the
  pointer, keyboard and focus, the iOS keyboard), which the generic GUI suites check on every page and control.
- **Not tested**: wording, constants, registry contents, class names, and the step-by-step behaviour of a feature's UI.
  These change with the app, and a test that only restates them costs more than it finds.

When you change the app:

- **New logic** in `domain/`, `data/`, sync, `headless/` or `server/` gets a unit test beside it.
- **A fixed bug** gets a regression test where one is cheap (a unit test if the cause can be reached there).
- **A UI feature** needs no new GUI test. The generic suites (the pages matrix, click everything, hover, keyboard, dark
  layers, popovers in use) reach new pages and controls by themselves. A new area of the app with no flow test yet
  may get one main-path test on desktop in a suite of its own; no more.
- **A test that breaks because behaviour changed on purpose**: change it when the edit is small. If it pinned the old
  details, delete it. Never weaken a data, sync or migration test to make it pass.
- The test part of a change should be small next to the change itself.

Before pushing:

- `npm run typecheck`, plus `npm run typecheck --prefix server` and `npm run typecheck:test --prefix server` for server code.
- `npm run test:changed`: the vitest tests that import what changed.
- `npm run test:gui:smoke` when the change shows in the GUI.

## The suites

`npm run suite -- <name…>` runs any suite by name (`tests/run.mjs`), times it and fails it when it takes more than its
budget (10 minutes unless `list` says otherwise; `--budget <min>`). `npm run suite -- list` shows them all.

| Suite | What | Needs | CI |
|---|---|---|---|
| `typecheck` | tsc of the app, the server and the server's tests | both `npm ci` | `test.yml` |
| `unit` | vitest projects `domain`, `storage`, `sync`, `api`, `app` (about 30 s) | nothing | `test.yml`; `build.yml` on Windows |
| `nodesqlite` | the `storage`, `sync` and `api` files again on `node:sqlite` (the server's headless device's engine) | Node 22.5+ | `test.yml` job `server` |
| `connectors` | every connector against Postgres, MySQL 8, MariaDB, SQLite (D1) and real local HTTP servers | server packages, `build:headless`, the databases | `test.yml` job `server` |
| `server` | the server's modules, settings, MCP, every HTTP endpoint of the real server process, devices syncing through it | server packages, `build:headless`, Postgres | `test.yml` job `server` |
| `gui-smoke` | the GUI tests marked `smoke` (about 36: one main path per area plus the generic sweeps' quickest) | Chrome, `playwright-cli` | `test.yml` |
| `connectors-real` | the `*.real.test.ts`: InfluxDB 2, n8n and Actual Budget in containers | `tests/setup-env.sh --connectors` | `full.yml` |
| `image` | the server image (`server/Dockerfile`, `docker-compose.yml` with a throwaway Postgres) checked over HTTP (`tests/image-smoke.mjs`) | Docker with compose v2.24+ | `full.yml`; `image.yml` before publishing |
| `gui-NN`, `gui-shard-N`, `gui-all` | one GUI suite file, a shard of them, all of them (about 100 tests, browsers in parallel) | Chrome, `playwright-cli` | `full.yml` (shards) |
| `critical`, `full` | what `test.yml` runs; everything, in 30 minutes at most | as each part | |

CI: `test.yml` runs the critical suites on every push, as parallel jobs of 10 minutes at most. `full.yml` is run by
hand (Actions → Full → Run workflow) before a release or after a large change. `build.yml` builds the desktop packages
and runs `cargo test`.

Environment: `tests/setup-env.sh` installs the packages, the headless build, the databases and playwright-cli pointed
at a local Chromium; then `source tests/env.sh`.

## Vitest projects

`vitest.config.ts` defines them. `npm test -- --project sync --project api` runs several.

| Project | Covers | Files |
|---|---|---|
| `domain` | the storage-agnostic model: query, views, fields, components, AI prompts, links, charts, dashboards | `app/src/domain/*.test.ts` |
| `storage` | schema and migrations (`fixture-v1.sql` migrated keeps every row), the engine, backups, the Repository contract, the worker and its lock rules (the SAH-pool VFS faked) | `app/src/data/*.test.ts`, `app/src/data/sqlite/*.test.ts` |
| `sync` | the device's side of sync (outbox, merge, files, first connection, versions, the engine) against `FakeServer` (`app/src/test/fakeServer.ts`); the remote sources' client; `shared/` | `app/src/data/sync/`, `app/src/data/remote/` |
| `api` | `/api/v1` on the headless device: every route and its errors (checked against `help/api.md`), the component compiler, webhooks, its data directory | `app/src/headless/*.test.ts` |
| `nodesqlite` | `storage`, `sync` and `api` again on `node:sqlite` files (`KUBUS_TEST_ENGINE=node`, `app/src/test/engine.ts`), except the wasm-only worker, client, lock and backup tests | same globs |
| `app` | app logic outside the UI: AI service and backfill, item cache, workspace layout, item actions, remote paging, platform adapters, hooks (`renderHook` in `app/src/test/hooks.ts`, no DOM) | `app/src/{app,platform,ui,views,pages,workspace,test}/` |
| `connectors` | the remote-source connectors: the shared contract (`contract.ts`, each answer compared with `applyQuery`'s on the same rows), each service's own errors, and that it only reads | `server/test/connectors/*.test.ts` |
| `server` | the server in-process and as a real process (`serve.ts`), and devices syncing through it (`devices.test.ts`, so device and server can't drift apart) | `server/test/*.test.ts` |

`connectors` and `server` need the server's packages (`npm ci --prefix server`; left out without them). Postgres,
MySQL and MariaDB come from `KUBUS_TEST_POSTGRES`, `KUBUS_TEST_MYSQL`, `KUBUS_TEST_MARIADB`. Each test file makes
its own database. Without the variable a test is skipped locally; in CI (`CI` set) that is an error.

```bash
docker run -d --name kubus-test-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
export KUBUS_TEST_POSTGRES=postgres://postgres:postgres@localhost:5432/postgres
npm ci --prefix server && npm run build:headless
npm run suite -- server connectors
```

The real services of `connectors-real` (`tests/services.yml`, compose profile `connectors`; `tests/env.sh` sets
`KUBUS_TEST_INFLUX`, `_N8N` and `_ACTUAL` for those that answer):

| Service | Files | Start / test time |
|---|---|---|
| InfluxDB 2.7.12 | `influx.real.test.ts` (seeded by `influxSeed.ts`) | 4 s / 35 s |
| n8n 2.45.5 | `n8n.real.test.ts` (`n8nSeed.ts`) | 1 to 2 min / 17 s |
| Actual Budget 26.10.0 + actual-http-api 26.10.1 | `actual.real.test.ts` (`actualSeed.cjs`) | 45 s / 25 s |

Docker Hub rate-limits anonymous pulls: `mirror.gcr.io/<image>` has the same images.

Notes:
- `fixture-v1.sql` (with `schema-v1.sql`) is frozen: a migration must keep its rows. A release whose data takes new
  shapes gets a fixture of its own version.
- Pure logic of a hook is better extracted and tested on its own (`views/itemActions.ts`, `views/remotePages.ts`).
- `npm run test:coverage` writes a V8 coverage report of the vitest projects to `coverage/` (git-ignored).

## GUI suites

`gui-tests/README.md` covers the runner, the harness and the layout rules. There are two kinds of suite:

- **Generic sweeps**: they know no feature and check every page and control against the rules in `lib/audit.js`
  and `lib/design.js`. These are the pages matrix (01, 35, 36: every page in each content shape, typical content at
  three window sizes, the others at one or two), the shell (02), click everything (03, 40), hover icon buttons (41),
  width and height sweeps and scale
  (09), popovers in use (10), keyboard and dialogs (11), dark layers (14) and the on-screen keyboard (20), each a CI shard
  of its own (`GUI_SWEEPS` in `tests/run.mjs`). New UI is covered by them without new tests. A deliberate exception to
  a rule is exempted in the rule, with its reason.
- **Flows**: one or two main-path tests per area (04–06, 12–18, 22–34, 43–45, 61), each step followed by what was
  stored and shown, all in one CI shard (about 10 minutes). Only these know how a feature is used, so they are the ones
  a UI change may break.
