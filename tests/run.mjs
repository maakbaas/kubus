#!/usr/bin/env node
// One entry point for every test suite: `npm run suite -- <name…> [--budget <min>] [-- <extra args>]`.
//   npm run suite -- list                      the suites, what each runs and its time budget
//   npm run suite -- unit server               several, one after the other
//   npm run suite -- gui-02 -- --name ur --port 1449   what follows the second `--` goes to the suite's last command
//   npm run suite -- 'gui:^(02|04)-'           the GUI suites whose file name matches a regex
//   npm run suite -- critical                  what CI's critical jobs run (test.yml)
//   npm run suite -- full                      everything (full.yml shards the GUI part over jobs)
//   node tests/run.mjs shards                  the GUI shards as JSON (the matrix of full.yml)
// A suite delegates to vitest or gui-tests/run.mjs (this file only names, times and bounds them), prints
// a summary, and fails when it exceeds its budget (10 minutes unless it says otherwise, --budget <min>
// for all named): it is interrupted then, so a hang can't eat the whole job. docs/testing.md is the catalog.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BUDGET = 10; // minutes

// ---- the suites -------------------------------------------------------------------------------------
/** @type {Map<string, {about: string, budget: number, steps?: string[][], members?: string[], needs?: string[], total?: number}>} */
const suites = new Map();
const add = (name, about, rest) => suites.set(name, { about, budget: DEFAULT_BUDGET, ...rest });

const vitest = (...projects) => ["npx", "vitest", "run", ...projects.flatMap((p) => ["--project", p])];
// A `*.real.test.ts` needs its service and, in CI, fails without it: they run in connectors-real only
// (vitest.config.ts leaves them out of the connectors project unless "real.test" is on the command line).

add("typecheck", "tsc of the app, the server and the server's tests", {
  steps: [["npm", "run", "typecheck"], ["npm", "run", "typecheck", "--prefix", "server"], ["npm", "run", "typecheck:test", "--prefix", "server"]],
});
add("unit", "vitest: domain, storage, sync, api, app (no services)", { steps: [vitest("domain", "storage", "sync", "api", "app")] });
add("nodesqlite", "vitest: the storage contract (storage, sync, api) again on node:sqlite files, the server's engine", { steps: [vitest("nodesqlite")] });
add("connectors", "vitest: the connectors, real services excluded (Postgres, MySQL, MariaDB; build:headless first)", { steps: [vitest("connectors")], needs: ["KUBUS_TEST_POSTGRES", "KUBUS_TEST_MYSQL", "KUBUS_TEST_MARIADB"] });
add("server", "vitest: the sync server and its HTTP API (Postgres; build:headless first)", { steps: [vitest("server")], needs: ["KUBUS_TEST_POSTGRES"] });
add("connectors-real", "vitest: the connectors against InfluxDB, n8n and Actual (tests/setup-env.sh --connectors)", {
  steps: [[...vitest("connectors"), "real.test"]],
  needs: ["KUBUS_TEST_INFLUX", "KUBUS_TEST_N8N", "KUBUS_TEST_ACTUAL"],
});
add("image", "the server image end to end: docker build of server/Dockerfile, docker-compose.yml with a throwaway Postgres, HTTP checks (Docker)", {
  steps: [["node", "tests/image-smoke.mjs"]],
});

// The GUI suites come from gui-tests/suites/NN-*.js: a new file is a new suite here. The runner
// (gui-tests/run.mjs) does the work; `--suite` picks files by name.
const gui = (...args) => ["node", "gui-tests/run.mjs", ...args];
const suiteDir = join(root, "gui-tests", "suites");
const guiFiles = readdirSync(suiteDir).filter((f) => /^\d\d-.*\.js$/.test(f)).sort();
const firstComment = (file) => {
  const line = readFileSync(join(suiteDir, file), "utf8").split("\n")[0].replace(/^\/\/\s*/, "");
  return line.length > 90 ? `${line.slice(0, 87).replace(/\s\S*$/, "")}…` : line;
};
for (const file of guiFiles) {
  const n = file.slice(0, 2);
  add(`gui-${n}`, `GUI ${file.slice(0, -3)}: ${firstComment(file)}`, { steps: [gui("--suite", `^${n}-`)] });
}
const guiNumbers = guiFiles.map((f) => f.slice(0, 2));


// Shards for CI (full.yml): each generic sweep alone (1 to 5 minutes of serial test time each), the flows together (about
// 8 minutes: one or two short tests per area). A new flow suite needs nothing here; a new sweep goes in GUI_SWEEPS.
const GUI_SWEEPS = ["01", "02", "03", "09", "10", "11", "14", "20", "35", "36", "40", "41"];
const shards = [...guiNumbers.filter((n) => GUI_SWEEPS.includes(n)).map((n) => [n]), guiNumbers.filter((n) => !GUI_SWEEPS.includes(n))];
shards.forEach((g, i) => {
  add(`gui-shard-${i + 1}`, `GUI suites ${g.join(", ")} (one job of full.yml)`, { steps: [gui("--suite", `^(${g.join("|")})-`)] });
});
add("gui-all", "every GUI suite in one run (browsers in parallel; CI shards it instead)", { budget: 20, steps: [gui()] });
add("gui-smoke", "the GUI smoke tests (one main path per area, plus the generic sweeps' quickest)", { steps: [gui("--smoke")] });

const CRITICAL = ["typecheck", "unit", "nodesqlite", "connectors", "server", "gui-smoke"];
add("critical", "what CI's critical jobs run (test.yml); in CI each is a job of its own", { members: CRITICAL });
// Everything, held to 30 minutes in all: over that there are too many tests, and the least meaningful go (docs/testing.md).
add("full", "typecheck, every vitest project, the real services, the image, the whole GUI suite: 30 minutes at most", {
  budget: 0,
  total: 30,
  members: ["typecheck", "unit", "nodesqlite", "connectors", "server", "connectors-real", "image", "gui-all"],
});

// ---- running ------------------------------------------------------------------------------------------
const [own, ...rest] = splitAt(process.argv.slice(2), "--");
const extra = rest.flat();
function splitAt(list, sep) {
  const i = list.indexOf(sep);
  return i < 0 ? [list] : [list.slice(0, i), list.slice(i + 1)];
}
let budgetOverride;
const names = [];
for (let i = 0; i < own.length; i++) {
  if (own[i] === "--budget") budgetOverride = Number(own[++i]);
  else names.push(own[i]);
}

/** Names to suites: groups expand, `gui:<regex>` is the GUI suites matching it. */
function resolveSuite(name) {
  if (name.startsWith("gui:")) {
    const re = new RegExp(name.slice(4), "i");
    if (!guiFiles.some((f) => re.test(f))) die(`no GUI suite matches ${re}`);
    return [{ name, about: `GUI suites matching ${re}`, budget: DEFAULT_BUDGET, steps: [gui("--suite", name.slice(4))] }];
  }
  const suite = suites.get(name);
  if (!suite) die(`unknown suite "${name}" (npm run suite -- list)`);
  return suite.members ? suite.members.flatMap(resolveSuite) : [{ name, ...suite }];
}
function die(message) {
  console.error(message);
  process.exit(2);
}

if (!names.length || names[0] === "list") {
  const w = Math.max(...[...suites.keys()].map((n) => n.length));
  for (const [name, s] of suites) console.log(`${name.padEnd(w)}  ${String(s.budget || "-").padStart(3)} min  ${s.about}`);
  console.log("\nAlso gui:<regex> (GUI suite files matching it). npm run suite -- <name…> [--budget <min>] [-- extra args]; docs/testing.md");
  process.exit(0);
}
if (names[0] === "shards") {
  // For a CI matrix: [{ name, suite, regex, suites }]
  console.log(JSON.stringify(shards.map((g, i) => ({ name: `shard-${i + 1}`, suite: `gui-shard-${i + 1}`, suites: g.join(" ") }))));
  process.exit(0);
}

const queue = names.flatMap(resolveSuite);
/** Groups held to a total time (minutes), like full. */
const totals = names.map((n) => suites.get(n)).filter((g) => g?.total);

/** Runs one command; resolves with its exit code, or "timeout" after interrupting it. */
function run(cmd, timeoutMs) {
  return new Promise((done) => {
    const child = spawn(cmd[0], cmd.slice(1), { cwd: root, stdio: "inherit", detached: true, shell: process.platform === "win32" });
    let timedOut = false;
    const timer = timeoutMs > 0 && setTimeout(() => {
      timedOut = true;
      for (const sig of ["SIGINT", "SIGTERM"]) setTimeout(() => { try { process.kill(-child.pid, sig); } catch { /* gone */ } }, sig === "SIGINT" ? 0 : 15_000);
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      done(timedOut ? "timeout" : code ?? (signal ? 1 : 0));
    });
    child.on("error", () => done(1));
  });
}

const fmt = (ms) => `${Math.floor(ms / 60_000)}:${String(Math.round(ms / 1000) % 60).padStart(2, "0")}`;
const results = [];
for (const suite of queue) {
  const budget = budgetOverride ?? suite.budget;
  const missing = (suite.needs ?? []).filter((v) => !process.env[v]);
  console.log(`\n=== ${suite.name}: ${suite.about} (budget ${budget || "none"} min) ===`);
  if (missing.length && (suite.name === "connectors-real" || process.env.CI)) {
    console.error(`${suite.name} needs ${missing.join(", ")}: source tests/env.sh (tests/setup-env.sh${suite.name === "connectors-real" ? " --connectors" : ""} starts the services)`);
    results.push({ name: suite.name, status: "MISSING ENV", ms: 0 });
    continue;
  }
  const started = Date.now();
  let status = "ok";
  const steps = suite.steps;
  for (let i = 0; i < steps.length; i++) {
    const cmd = i === steps.length - 1 ? [...steps[i], ...extra] : steps[i];
    const left = budget ? budget * 60_000 - (Date.now() - started) : 0;
    const code = await run(cmd, budget ? Math.max(left, 1) : 0);
    if (code === "timeout") { status = "OVER BUDGET"; break; }
    if (code !== 0) { status = "FAILED"; break; }
  }
  const ms = Date.now() - started;
  results.push({ name: suite.name, status, ms, budget });
}

console.log("\nSuite                 Time    Budget  Result");
for (const r of results) console.log(`${r.name.padEnd(20)}  ${fmt(r.ms).padStart(6)}  ${r.budget ? `${r.budget} min`.padStart(6) : "     -"}  ${r.status}`);
const totalMs = results.reduce((t, r) => t + r.ms, 0);
for (const g of totals) if (totalMs > g.total * 60_000) results.push({ name: "total", status: `OVER ${g.total} MIN`, ms: totalMs, budget: g.total });
const bad = results.filter((r) => r.status !== "ok");
console.log(bad.length ? `\n${bad.length} of ${results.length} failed: ${bad.map((r) => r.name).join(", ")}` : `\nAll ${results.length} green, ${fmt(totalMs)} in total`);
process.exitCode = bad.length ? 1 : 0;
