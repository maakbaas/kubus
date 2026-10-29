# Tests: the catalog

Every suite in one place: what it covers, what it needs, its time budget, how to run it and which CI job runs it.
`docs/testing.md` is the how-to-write side (conventions, what to run for a change, coverage).

Every suite has a name and one entry point, `tests/run.mjs`: it delegates to vitest or `gui-tests/run.mjs`, times the
suite, prints a summary and **fails a suite that exceeds its budget** (10 minutes unless the table says otherwise;
`--budget <min>`; it is interrupted at the limit, so a hang can't eat a CI job). The list is derived from the files
(GUI suites from `gui-tests/suites/NN-*.js`: a new file is a new suite).

```bash
npm run suite -- list                              # the names, budgets and what each runs
npm run suite -- unit server connectors            # several, one after the other, with a summary
npm run suite -- gui-02 -- --name b --port 1449    # after the second `--`: arguments for the suite's command
npm run suite -- 'gui:^(02|04)-'                   # GUI suite files matching a regex
npm run suite -- critical                          # what CI's critical jobs run
npm run suite -- nightly                           # everything (hours; CI spreads the GUI part over jobs)
```

Environment: `tests/setup-env.sh` (packages, headless build, Postgres / MySQL / MariaDB, optionally `--connectors`:
the real services, `services.yml`) then `source tests/env.sh`. The GUI suites need `playwright-cli` and Chrome (`gui-tests/README.md`).

## Vitest (`vitest.config.ts` projects; what each covers: `docs/testing.md`)

| Suite | Covers | Needs | Budget (typical) | Run | CI |
|---|---|---|---|---|---|
| `typecheck` | tsc of the app, the server, the server's tests | both `npm ci` | 10 min (1 min) | `npm run suite -- typecheck` | `test.yml` job `typecheck` |
| `unit` | projects `domain`, `storage`, `sync`, `api`, `app` | nothing | 10 min (1.5 min) | `npm run suite -- unit` (one project: `npm test -- --project sync`) | `test.yml` job `unit`; `build.yml` (Windows) |
| `connectors` | project `connectors` without the `*.real.test.ts`: every connector's unit tests, the shared contract against Postgres, MySQL, MariaDB, SQLite (D1), real local HTTP servers | server packages, `build:headless`, Postgres, MySQL, MariaDB | 10 min (20 s) | `npm run suite -- connectors` | `test.yml` job `server` |
| `server` | project `server`: modules, settings, MCP, every HTTP endpoint of the real server process, devices syncing through it | server packages, `build:headless`, Postgres | 10 min (30 s) | `npm run suite -- server` | `test.yml` job `server` |
| `connectors-real` | the `*.real.test.ts` of `connectors`: InfluxDB 2 (35 s), n8n (17 s; 1 to 2 min to start), Actual Budget with actual-http-api (25 s; 45 s to start) | `tests/setup-env.sh --connectors`, then `source tests/env.sh` sets `KUBUS_TEST_INFLUX`, `_N8N`, `_ACTUAL`; missing ones fail the suite | 10 min (~3 min with start) | `npm run suite -- connectors-real` | `nightly.yml` job `connectors-real` (compose profile `connectors`) |
| `image` | the deliverable server image (`server/Dockerfile`, as `docker-compose.yml` runs it and `image.yml` publishes it): `docker build`, the compose file with its own throwaway Postgres (project `kubus-image-smoke`, free ports, nothing of a running stack touched), then over HTTP: health, token refusal, a sync round trip (`shared/sync.ts`), `/api/v1` answered by the bundled headless device (not 503), the web app's files, a stop / start that keeps the data; torn down at the end. `KUBUS_IMAGE_CA=<bundle>` for a TLS-intercepting proxy; `--keep`, `--no-build` | Docker with compose v2.24+ | 10 min (~2.5 min with a cold build, ~30 s cached) | `npm run suite -- image` | `nightly.yml` job `image`; `image.yml` before it publishes |
| `coverage` | the vitest projects with V8 coverage, then `npm run coverage:report` (merges the GUI's coverage if `gui-… -- --coverage` ran) | as `connectors` + `server` | 20 min | `npm run suite -- coverage` | `nightly.yml` job `coverage` |

`npm test` is still every project in one run (with the `*.real.test.ts`, skipped without their variables, an error in CI).

## GUI (playwright-cli through `gui-tests/run.mjs`; what each suite does: its first comment; areas: `gui-tests/areas.mjs`)

| Suite | Covers | Needs | Budget | Run | CI |
|---|---|---|---|---|---|
| `gui-smoke` | the tests marked `{ smoke: true }` (about 25) of the suites the changed files reach (`--changed`, `areas.mjs`); all of them on main; not suite 21 | Chrome, `playwright-cli` | 10 min (all ~23 tests: ~10 on a busy machine; fewer when only some suites are reached) | `npm run suite -- gui-smoke` (`GUI_ALL=1` for all) | `test.yml` job `gui-smoke` |
| `gui-NN` | one suite file: 01 and 35-39 pages × sizes (by content style), 02 shell, 03 and 40 click everything (desktop, phone), 41 and 42 hover icon buttons (desktop, phone), 04 item editing, 05 table, 06 views and blocks, 07 forms, 08 Markdown, 09 sweeps and scale, 10 popovers, 11 keyboard and dialogs, 12 combinations, 13 live changes, 14 dark layers, 15 AI, 16 media, 17 reorder, 18 sync, 19 editing, 20 mobile keyboard, 22 components and filters, 24 charts, 25 map and options, 26 query, 27 field kinds, 28 settings, 43 filter bar … | as above | 10 min each, except below | `npm run suite -- gui-04` | via the shards |
| `gui-shard-N` | groups of suites, each about 8 minutes (packed from measured durations: rebalance `SHARDS` in `tests/run.mjs` from `gui-tests/report/results.json` after a full run; the runner warns when a suite's last measured time is over its budget); suites in no group land in the last shard | as above | 10 min | `npm run suite -- gui-shard-3`; `node tests/run.mjs shards` prints them | `nightly.yml` matrix `gui` |
| `gui-21` | screenshot baselines (pixels depend on the machine's Chrome and fonts: run where they were made; `--update-baselines` after a deliberate change) | the baselines' machine | 10 min | `npm run suite -- gui-21` | none |
| `gui-23` | perf: hot paths measured, each once, `perf-summary.json` (`--perf-compare`) | one quiet machine | 10 min | `npm run suite -- gui-23` | none |
| `gui-all` | every suite but 21 and 23 in one run (an hour or more) | as above | 120 min | `npm run suite -- gui-all` | none (sharded instead) |

Coverage of the GUI: `npm run suite -- gui-shard-N -- --coverage` writes `coverage/gui-v8/`.

## Groups

| Name | Runs | Wall time | CI |
|---|---|---|---|
| `critical` | `typecheck`, `unit`, `connectors`, `server`, `gui-smoke` | a few minutes of vitest plus the smoke tests; in CI four parallel jobs, the longest is `gui-smoke` | `test.yml`, on every push |
| `nightly` | `critical`'s vitest and typecheck, `connectors-real`, every `gui-shard-N` | hours in sequence; ≈ 10 minutes in CI (12 parallel jobs) | `nightly.yml`: every night and by hand; also uploads the merged coverage report |

Rust (`cargo test`, clippy, fmt) is not a suite here: `desktop/` is tested by `build.yml`.

## CI at a glance

| Workflow | Jobs | Budget |
|---|---|---|
| `test.yml` (every push) | `typecheck`, `unit`, `server` (Postgres, MySQL, MariaDB services), `gui-smoke`, in parallel | each ≤ 10 min, so the whole ≤ 10 |
| `nightly.yml` (schedule, by hand) | `connectors-real`, `image`, `gui` (matrix of shards), `coverage` (unit coverage + the shards' GUI coverage, merged: artifact `coverage-report`) | each ≤ 20 min job limit, the suites ≤ 10 |
| `build.yml` (every push) | the Windows installer, macOS / Linux packages, the Docker image; on Windows `unit` only: the one place tests run on another platform (paths, line endings); the rest is platform-independent and stays in `test.yml` | |

A new suite file in `gui-tests/suites/` needs a line in `gui-tests/areas.mjs` (so `--changed` finds it); it is picked up by the
shards automatically (the last shard takes suites no group names).
