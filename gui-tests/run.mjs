#!/usr/bin/env node
// GUI stress suite runner: `npm run test:gui [-- options]`. Not part of `npm test`; CI runs its smoke tests.
//
// Each test runs through `playwright-cli run-code` in one of several parallel browser sessions,
// in a fresh browser context (its own database). The app is a bundled build (`vite build` with
// NODE_ENV=development, so `window.kubus` and React's warnings stay; rebuilt only when app/
// changed) served by `vite preview` for the run: a page loads ~40% faster than from the dev server,
// which serves hundreds of modules one by one. Results: gui-tests/report/index.html (with
// screenshots), results.json beside it. Exit code 1 when anything failed.
//
// Options:
//   --grep <regex>     only tests whose "suite › name" matches
//   --suite <regex>    only suites whose file name matches
//   --workers <n>      parallel browser sessions (default 3; each is a Chrome)
//   --shot-all         a screenshot for every checkpoint (default: audits, snaps and failures)
//   --skip <rules>     comma-separated audit rules to leave out everywhere
//   --dev              test the dev server (port 1420; reused when running) instead of a build
//   --port <n>         port for serving the build (default 1430)
//   --base-url <url>   test an app that is already running there (no build, no server)
//   --list             list the tests and exit
//   --retries <n>      re-run a test that errored or failed up to n times (default 1); one that
//                      failed and then passed is "flaky" in the report, and counts as a failure
//   --repeat <n>       run each selected test n times (names get " #k"), to measure how flaky it is
//   --browser <name>   webkit / firefox / chrome / msedge instead of the default (playwright-cli open
//                      --browser); WebKit needs `playwright install webkit` for playwright-cli's own
//                      Playwright (and no PLAYWRIGHT_MCP_CONFIG naming another browser)
//   --smoke            only the tests marked { smoke: true } (~25: a quick check; the full run before larger pushes)
//   --changed [ref]    only the suites covering the files changed since ref (default origin/main), committed
//                      or not (areas.mjs maps paths to suites); with --smoke their smoke tests
//   --update-baselines store the screenshot baselines (t.baseline) taken by this run in
//                      gui-tests/baselines/ instead of comparing with them
//   --recycle <n>      restart each browser after n tests (default 8), to drop what it accumulated
//   --min-free <gb>    wait before starting a test while less memory is free (default 1.5)
//   --name <name>      name of this run's browser sessions, build and report folders (default: none), so
//                      a second run (another --port) can go alongside without ending the first's
//   --coverage         collect the app's JS coverage (V8, Chromium, the build with source maps) into
//                      coverage/gui-v8[-name]/, one file per test; tests/coverage.mjs maps it to app/src
//                      and merges it into the report (npm run coverage:report)
//   --perf             only the perf tests ({ perf: true }, left out of other runs): each once, one
//                      browser (--workers); per-phase timings in perf-summary.json beside the report
//   --perf-compare <file>  with --perf: compare with an earlier perf-summary.json (change per test)
//
// Memory: each session is a Chrome (browser, GPU and network processes) plus a test's renderers
// (the app with its SQLite worker, one per sandboxed HTML frame): up to about 1.7 GB on ordinary
// tests, and several GB on the `heavy` ones (1000 rows, sweeps, scale). So the default number of
// browsers follows the free memory, heavy tests run last and alone in one browser, browsers are
// restarted every few tests, and a test only starts while enough memory is free. Browsers left
// over by a run that was killed (their daemons survive it) are found by name and ended at the
// start of the next run.

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { freemem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { gzipSync } from "node:zlib";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { suitesFor } from "./areas.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const devMode = flag("dev");
const externalUrl = opt("base-url");
const previewPort = Number(opt("port", 1430));
const baseUrl = externalUrl || (devMode ? "http://localhost:1420" : `http://localhost:${previewPort}`);
const buildDir = join(here, opt("name") ? `.build-${opt("name")}` : ".build");
const GB = 1024 ** 3;
const minFree = Number(opt("min-free", 1.5)) * GB;
// Measured: a browser peaks at about 1.7 GB on ordinary tests (app, SQLite worker, a renderer per
// sandboxed HTML frame); keep `minFree` for everything else; at most 3.
const autoWorkers = Math.max(1, Math.min(3, Math.floor((freemem() - minFree) / (1.7 * GB))));
const perfMode = flag("perf");
const coverage = flag("coverage");
if (coverage && (devMode || externalUrl)) {
  console.error("--coverage needs the build (its source maps), not --dev or --base-url");
  process.exit(1);
}
// Perf runs measure: one browser by default, so tests don't slow each other down.
const workers = Math.max(1, Number(opt("workers", perfMode ? 1 : autoWorkers)));
const recycleEvery = Math.max(1, Number(opt("recycle", 8)));
const grep = opt("grep") ? new RegExp(opt("grep"), "i") : null;
const suiteFilter = opt("suite");
const retries = Number(opt("retries", 1));
// Perf runs measure each test once (a change is judged against an earlier run, --perf-compare).
const repeat = perfMode ? 1 : Math.max(1, Number(opt("repeat", 1)));
const coverageDir = join(root, "coverage", opt("name") ? `gui-v8-${opt("name")}` : "gui-v8");
const baselineDir = join(here, "baselines");
const updateBaselines = flag("update-baselines");
/** A pixel differs when pixelmatch's colour distance is over this (0…1); a baseline fails when more than BASELINE_SHARE of its pixels differ. */
const BASELINE_THRESHOLD = 0.1;
const BASELINE_SHARE = 0.001;
const skipRules = (opt("skip", "") || "").split(",").filter(Boolean);
const runName = opt("name", "");
const reportDir = join(here, runName ? `report-${runName}` : "report");
const shotDir = join(reportDir, "shots");
const tmpDir = join(reportDir, "tmp");
// Console messages that are not the app's fault (none known yet; regex sources).
// "Failed to load resource" is the browser logging a failed request (a model list from a made-up
// address); broken images are caught by the audit's broken-image rule instead.
const IGNORE_CONSOLE = ["Download the React DevTools", "\\[vite\\]", "Failed to load resource"];

const lib = ["harness.js", "data.js", "audit.js", "design.js"].map((f) => readFileSync(join(here, "lib", f), "utf8")).join("\n\n");
const suiteFiles = readdirSync(join(here, "suites")).filter((f) => f.endsWith(".js") && (!suiteFilter || new RegExp(suiteFilter, "i").test(f))).sort();

// ---- discover tests (the suites register them at load; nothing runs) ----------------------
/** The pass/fail criteria (CRITERIA in lib/audit.js), for the report. */
let criteria = {};
function listTests(file) {
  const src = readFileSync(join(here, "suites", file), "utf8");
  const sandbox = { __OPTS: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(`${lib}\n${src}\n;globalThis.__list = __tests.map((t) => ({ name: t.name, opts: t.opts })); globalThis.__criteria = CRITERIA;`, sandbox, { filename: file });
  criteria = sandbox.__criteria;
  return sandbox.__list.map((t) => ({ ...t, suite: file.replace(/\.js$/, ""), file, src }));
}
let tests = suiteFiles.flatMap(listTests);
if (grep) tests = tests.filter((t) => grep.test(`${t.suite} › ${t.name}`));
if (flag("smoke")) tests = tests.filter((t) => t.opts.smoke);
if (flag("changed")) {
  const next = args[args.indexOf("--changed") + 1];
  const ref = next && !next.startsWith("--") ? next : "origin/main";
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  let files;
  try {
    files = [...new Set([...git("diff", "--name-only", `${ref}...HEAD`), ...git("diff", "--name-only", "HEAD"), ...git("ls-files", "--others", "--exclude-standard")])];
  } catch {
    console.error(`--changed: git can't compare with ${ref} (fetch it, or name another: --changed <ref>)`);
    process.exit(1);
  }
  const covered = suitesFor(files);
  if (covered !== "all") tests = tests.filter((t) => covered.includes(Number(t.suite.slice(0, 2))));
  console.log(`--changed: ${files.length} files changed since ${ref}; suites: ${covered === "all" ? "all" : covered.join(", ") || "none"}`);
  if (tests.length === 0 && !flag("list")) {
    console.log("Nothing the GUI shows changed: no tests to run.");
    process.exit(0);
  }
}
// Perf tests only run in a perf run.
tests = tests.filter((t) => !!t.opts.perf === perfMode);
// Each test `repeat` times: the same test (looked up by `name`), reported as "name #k".
if (repeat > 1) {
  const runs = (t, k) => ({ ...t, label: `${t.label || t.name} #${k + 1}` });
  tests = tests.flatMap((t) => Array.from({ length: repeat }, (_, k) => runs(t, k)));
}
if (flag("list")) {
  for (const t of tests) console.log(`${t.suite} › ${t.label || t.name}`);
  console.log(`${tests.length} tests`);
  process.exit(0);
}
if (tests.length === 0) {
  console.error("No tests match.");
  process.exit(1);
}

// ---- helpers ----------------------------------------------------------------------------------
function run(cmd, cmdArgs, { timeout = 0 } = {}) {
  return new Promise((done) => {
    // Windows runs the .cmd shims through a shell: one command line, arguments quoted.
    const win = process.platform === "win32";
    const quote = (a) => (/^[\w\-=./:\\]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);
    const child = win ? spawn([cmd, ...cmdArgs].map(quote).join(" "), { cwd: root, shell: true, windowsHide: true }) : spawn(cmd, cmdArgs, { cwd: root, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    // On Windows the child is a shell: end its whole tree, or the real process keeps going.
    const timer = timeout ? setTimeout(() => killTree(child.pid), timeout) : null;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      done({ code, out, err });
    });
    child.on("error", (e) => done({ code: -1, out, err: String(e) }));
  });
}
/** A test that takes longer has hung (the slowest take about 6 minutes). */
const TEST_TIMEOUT = 15 * 60 * 1000;
const cli = (session, ...rest) => run("playwright-cli", [`-s=${session}`, ...rest], { timeout: rest.includes("run-code") ? TEST_TIMEOUT : 120000 });

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone already */
    }
  }
}

const SESSION_PREFIX = runName ? `kubus-gui-${runName}-` : "kubus-gui-";
/**
 * Ends what this suite left running after a run that was killed: its browser daemons (with their
 * Chromes), which `playwright-cli close` no longer reaches, found by the session name on the
 * daemon's command line (`cliDaemon.js kubus-gui-N`); and the server of its build (`vite preview`
 * of gui-tests/.build), which would hold the port. Returns how many browser daemons it ended.
 */
function killStrays() {
  const find = (regex) => {
    try {
      if (process.platform === "win32") {
        const ps = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match '${regex}' } | ForEach-Object { $_.ProcessId }`;
        return execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8", windowsHide: true }).split(/\s+/).filter(Boolean).map(Number);
      }
      return execFileSync("pgrep", ["-f", regex], { encoding: "utf8" }).split(/\s+/).filter(Boolean).map(Number);
    } catch {
      return []; // none found (pgrep exits 1) or no way to list processes
    }
  };
  const daemons = find(`cliDaemon\\.js ${SESSION_PREFIX}[0-9]+`);
  // None with --base-url: this run serves nothing, and the port may be another run's (whose server it ended).
  const previews = externalUrl ? [] : find(`vite.*preview.*gui-tests.\\.build.*--port ${previewPort}`).filter((pid) => pid !== server?.pid);
  for (const pid of [...daemons, ...previews]) killTree(pid);
  return daemons.length;
}

const browserName = opt("browser");
async function openSession(s) {
  await cli(s, "close");
  const r = await cli(s, "open", ...(browserName ? [`--browser=${browserName}`] : []));
  if (r.code !== 0) throw new Error(`Could not open browser session ${s}: ${r.out}${r.err}`);
}

/** Waits (up to 2 minutes) until at least `minFree` memory is free, so a test doesn't push the machine over. */
async function waitForMemory(label) {
  let warned = false;
  for (let i = 0; i < 120 && freemem() < minFree; i++) {
    if (!warned) console.log(`  waiting for free memory before ${label} (${(freemem() / GB).toFixed(1)} GB free)`);
    warned = true;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function up() {
  try {
    const r = await fetch(baseUrl, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Starts `npx vite <args>` in the repository (Windows: through a shell, one quoted command line). */
function npxVite(viteArgs, options = {}) {
  const win = process.platform === "win32";
  const line = ["npx", "vite", ...viteArgs].map((a) => (/^[\w\-=./:]+$/.test(a) ? a : `"${a}"`)).join(" ");
  return win ? spawn(line, { cwd: root, shell: true, windowsHide: true, ...options }) : spawn("npx", ["vite", ...viteArgs], { cwd: root, detached: true, ...options });
}

/** The newest modification time of what the build is made from. */
function sourceStamp() {
  let newest = 0;
  const walk = (p) => {
    const s = statSync(p);
    if (s.isDirectory()) {
      for (const name of readdirSync(p)) if (name !== "dist" && name !== "node_modules" && !name.startsWith(".")) walk(join(p, name));
    } else newest = Math.max(newest, s.mtimeMs);
  };
  walk(join(root, "app"));
  walk(join(root, "shared"));
  walk(join(root, "package-lock.json"));
  return newest;
}

/** Builds the app for the tests into gui-tests/.build, unless that build is newer than every source file. */
async function buildApp() {
  const stampFile = join(buildDir, "stamp.json");
  const stamp = sourceStamp();
  try {
    const built = JSON.parse(readFileSync(stampFile, "utf8"));
    if (built.stamp === stamp && (!coverage || built.sourcemap) && existsSync(join(buildDir, "index.html"))) return console.log("Using the build of the current sources");
  } catch {
    /* no build yet */
  }
  console.log("Building the app (development mode)…");
  const t0 = Date.now();
  // NODE_ENV=development: import.meta.env.DEV stays on (window.kubus for seeding) and React logs
  // its warnings, which the tests count as console errors, exactly as with the dev server.
  const child = npxVite(["build", "--config", "app/vite.config.ts", "--mode", "development", "--outDir", buildDir, "--emptyOutDir", ...(coverage ? ["--sourcemap"] : [])], { env: { ...process.env, NODE_ENV: "development" } });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const code = await new Promise((done) => child.on("close", done));
  if (code !== 0) throw new Error(`The build failed:\n${log.split("\n").slice(-30).join("\n")}`);
  writeFileSync(stampFile, JSON.stringify({ stamp, sourcemap: coverage }));
  console.log(`Built in ${Math.round((Date.now() - t0) / 1000)}s`);
}

let server = null;
async function ensureServer() {
  if (externalUrl) {
    if (await up()) return console.log(`Testing the app at ${baseUrl}`);
    throw new Error(`Nothing answers at ${baseUrl}`);
  }
  if (devMode) {
    if (await up()) return console.log(`Using the dev server at ${baseUrl}`);
    console.log("Starting the dev server (vite)…");
    server = npxVite(["--config", "app/vite.config.ts"], { stdio: "ignore" });
  } else {
    await buildApp();
    if (await up()) throw new Error(`Port ${previewPort} is taken; pass another with --port`);
    server = npxVite(["preview", "--config", "app/vite.config.ts", "--outDir", buildDir, "--port", String(previewPort), "--strictPort"], { stdio: "ignore" });
  }
  for (let i = 0; i < 120; i++) {
    if (await up()) return console.log(`Serving ${devMode ? "the dev server" : "the build"} at ${baseUrl}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`The ${devMode ? "dev server" : "build's server"} did not start at ${baseUrl}`);
}
function stopServer() {
  if (!server) return;
  killTree(server.pid);
  server = null;
}

// ---- run --------------------------------------------------------------------------------------
async function runTest(session, t, n) {
  const opts = { browser: browserName || "chromium", test: t.name, baseUrl, shotDir: shotDir.replace(/\\/g, "/"), skip: skipRules, shotAll: flag("shot-all"), ignoreConsole: IGNORE_CONSOLE, shotPrefix: t.label ? `r${n}-` : "", coverage };
  const code = `async page => {\nconst __OPTS = ${JSON.stringify(opts)};\n${lib}\n${t.src}\nreturn await __main(page);\n}`;
  const file = join(tmpDir, `t${n}.js`);
  writeFileSync(file, code);
  const r = await cli(session, "--raw", "run-code", `--filename=${file}`);
  let result;
  try {
    let v = JSON.parse(r.out.trim());
    if (typeof v === "string") v = JSON.parse(v);
    result = v;
  } catch {
    const msg = (r.out + r.err).trim().slice(0, 2000) || `exit code ${r.code}`;
    result = { name: t.name, status: "error", error: msg, checkpoints: [] };
  }
  // The test's V8 coverage goes to its own file (a retry replaces the attempt before it), not into the report.
  if (coverage && result.coverage) writeFileSync(join(coverageDir, `t${n}.json.gz`), gzipSync(JSON.stringify(result.coverage)));
  delete result.coverage;
  for (const c of result.checkpoints || []) if (c.kind === "baseline") compareBaseline(c);
  if (result.status === "pass" && (result.checkpoints || []).some((c) => !c.pass)) result.status = "fail";
  return { ...result, name: t.label || result.name, test: t.name, suite: t.suite, viewport: result.viewport || t.opts.viewport || "desktop", dark: !!t.opts.dark };
}

/**
 * A baseline checkpoint (t.baseline): its screenshot is stored as the baseline (--update-baselines),
 * or compared with the stored one: it fails when the sizes differ or more than BASELINE_SHARE of
 * the pixels differ; the difference image goes into the report beside it.
 */
function compareBaseline(c) {
  const shot = join(shotDir, c.screenshot);
  const stored = join(baselineDir, c.baseline);
  if (!existsSync(shot)) return Object.assign(c, { pass: false, detail: "no screenshot was taken" });
  if (updateBaselines) {
    mkdirSync(baselineDir, { recursive: true });
    copyFileSync(shot, stored);
    return Object.assign(c, { detail: "stored as the baseline" });
  }
  if (!existsSync(stored)) return Object.assign(c, { pass: false, detail: `no baseline yet: run with --update-baselines to store gui-tests/baselines/${c.baseline}` });
  const a = PNG.sync.read(readFileSync(stored));
  const b = PNG.sync.read(readFileSync(shot));
  if (a.width !== b.width || a.height !== b.height) return Object.assign(c, { pass: false, detail: `size ${b.width}x${b.height}, baseline ${a.width}x${a.height}` });
  const diff = new PNG({ width: a.width, height: a.height });
  const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: BASELINE_THRESHOLD });
  const share = n / (a.width * a.height);
  if (share <= BASELINE_SHARE) return Object.assign(c, { detail: `${n} pixels differ (${(share * 100).toFixed(3)}%)` });
  const diffFile = c.screenshot.replace(/\.png$/, "--diff.png");
  writeFileSync(join(shotDir, diffFile), PNG.sync.write(diff));
  return Object.assign(c, { pass: false, detail: `${n} pixels differ (${(share * 100).toFixed(2)}% > ${BASELINE_SHARE * 100}%); the differences are red in ${diffFile}`, diff: diffFile });
}

async function main() {
  rmSync(reportDir, { recursive: true, force: true });
  mkdirSync(shotDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  if (coverage) {
    rmSync(coverageDir, { recursive: true, force: true });
    mkdirSync(coverageDir, { recursive: true });
    writeFileSync(join(coverageDir, "meta.json"), JSON.stringify({ buildDir, baseUrl }));
  }
  const strays = killStrays();
  if (strays) console.log(`Ended ${strays} browser session(s) left over by an earlier run`);
  await ensureServer();

  const sessions = Array.from({ length: Math.min(workers, tests.length) }, (_, i) => `${SESSION_PREFIX}${i + 1}`);
  console.log(`${tests.length} tests in ${sessions.length} ${browserName || "chromium"} browser(s) (${(freemem() / GB).toFixed(1)} GB free)`);
  activeSessions = sessions;
  await Promise.all(sessions.map(openSession));

  const started = Date.now();
  const results = new Array(tests.length);
  let done = 0;
  const width = String(tests.length).length;
  /** Runs `queue` (shared) in the given browsers, each taking the next test when it is free. */
  const runQueue = (queue, browsers) =>
    Promise.all(browsers.map(async (session) => {
      let ran = 0;
      while (queue.length) {
        const { t, i } = queue.shift();
        // A fresh browser every few tests: what a long-lived one accumulates is let go.
        if (ran > 0 && ran % recycleEvery === 0) await openSession(session);
        ran++;
        await waitForMemory(t.name);
        let r = await runTest(session, t, i);
        // What failed first: a test that fails and then passes is flaky (an error that then passes
        // was the browser: a crash, a hang).
        let failedFirst = null;
        for (let k = 0; k < retries && r.status !== "pass"; k++) {
          if (r.status === "fail" && !failedFirst) failedFirst = r;
          // A browser session can die (crash, hang): reopen it before retrying.
          if (r.status === "error") await openSession(session);
          await waitForMemory(t.name);
          r = await runTest(session, t, i);
        }
        if (failedFirst && r.status === "pass") r = { ...r, status: "flaky", firstAttempt: failedFirst.checkpoints.filter((c) => !c.pass).map((c) => `${c.label}: ${c.detail || (c.violations || []).map((v) => `${v.rule} ${v.message}`).join("; ")}`.slice(0, 400)) };
        // After an error the browser may still hold the test's page (a timeout, a crash): start over.
        if (r.status === "error") await openSession(session);
        results[i] = r;
        done++;
        writeReport(started, results.filter(Boolean), true);
        const failed = r.checkpoints.filter((c) => !c.pass).length;
        const mark = r.status === "pass" ? "\x1b[32m✓\x1b[0m" : r.status === "fail" ? "\x1b[31m✗\x1b[0m" : r.status === "flaky" ? "\x1b[35m~\x1b[0m" : "\x1b[33m!\x1b[0m";
        const extra = r.status === "pass" ? "" : r.status === "fail" ? ` — ${failed} failed checkpoint${failed === 1 ? "" : "s"}` : r.status === "flaky" ? ` — flaky: failed first (${r.firstAttempt.length} checkpoint${r.firstAttempt.length === 1 ? "" : "s"}), passed on the retry` : ` — ${String(r.error).split("\n")[0].slice(0, 120)}`;
        console.log(`${String(done).padStart(width)}/${tests.length} ${mark} ${t.suite} › ${t.label || t.name} (${((r.ms || 0) / 1000).toFixed(1)}s)${extra}`);
      }
    }));
  const all = tests.map((t, i) => ({ t, i }));
  const light = all.filter((q) => !q.t.opts.heavy);
  const heavy = all.filter((q) => q.t.opts.heavy);
  await runQueue(light, sessions);
  // Heavy tests (big data, sweeps; several GB in one browser) last, alone, in one fresh browser.
  if (heavy.length) {
    await Promise.all(sessions.slice(1).map((s) => cli(s, "close")));
    activeSessions = sessions.slice(0, 1);
    console.log(`Heavy tests, one at a time (${(freemem() / GB).toFixed(1)} GB free):`);
    await openSession(sessions[0]);
    await runQueue(heavy, sessions.slice(0, 1));
  }
  await Promise.all(activeSessions.map((s) => cli(s, "close")));
  activeSessions = [];
  killStrays();
  stopServer();
  rmSync(tmpDir, { recursive: true, force: true });

  const { summary, byRule } = writeReport(started, results, false);
  if (perfMode) perfSummary(results);
  console.log("");
  for (const [rule, list] of Object.entries(byRule).sort((a, b) => b[1].length - a[1].length)) console.log(`  ${rule.padEnd(22)} ${list.length}`);
  // What failed, readable from a CI log without the report: the first failed checkpoints with their detail.
  const failedChecks = results.flatMap((r) => r.checkpoints.filter((c) => !c.pass).map((c) => `${r.suite} › ${r.name} › ${c.label}${c.detail ? `: ${c.detail}` : ""}`));
  for (const line of failedChecks.slice(0, 20)) console.log(`  ✗ ${line.length > 400 ? `${line.slice(0, 400)}…` : line}`);
  if (failedChecks.length > 20) console.log(`  … and ${failedChecks.length - 20} more (the report has them all)`);
  for (const f of summary.flakyTests) console.log(`  flaky: ${f}`);
  console.log(`\n${summary.passed} passed, ${summary.failed} failed, ${summary.flaky} flaky, ${summary.errored} errored of ${summary.tests} tests; ${summary.failedCheckpoints} of ${summary.checkpoints} checkpoints failed (${summary.seconds}s)`);
  console.log(`Report: ${join(reportDir, "index.html")}`);
  process.exitCode = summary.failed + summary.errored + summary.flakyTests.length > 0 ? 1 : 0;
}

// ---- perf summary ---------------------------------------------------------------------------
const median = (xs) => {
  const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const SUITE_TIMES = ["boot", "seed", "load", "settle", "audit", "screenshot"];

/**
 * perf-summary.json: per perf test, from its one run: the
 * app's time (the phases' `ms`, summed: what a person waits for), each phase's measures, and the
 * suite's own time (seeding, loads, settling, audits, screenshots: the test's time minus the
 * phases'). Printed as a table, compared with an earlier summary when --perf-compare names one.
 */
function perfSummary(results) {
  const byKey = new Map();
  for (const r of results) {
    if (!r.perf) continue;
    const key = r.test;
    byKey.set(key, [...(byKey.get(key) || []), r]);
  }
  const tests = {};
  for (const [key, runs] of byKey) {
    const ok = runs.filter((r) => r.status === "pass" || r.status === "flaky");
    const use = ok.length ? ok : runs;
    const appMs = use.map((r) => r.perf.phases.reduce((a, p) => a + p.ms, 0));
    const doneMs = use.map((r) => r.perf.phases.reduce((a, p) => a + p.doneMs, 0));
    const names = [...new Set(use.flatMap((r) => r.perf.phases.map((p) => p.name)))];
    const phases = Object.fromEntries(names.map((name) => {
      const ps = use.map((r) => r.perf.phases.find((p) => p.name === name)).filter(Boolean);
      return [name, Object.fromEntries(["ms", "doneMs", "cpuMs", "scriptMs", "layoutMs", "longTasks", "longMs", "nodes", "heapMB"].map((k) => [k, median(ps.map((p) => p[k]))]))];
    }));
    const suite = Object.fromEntries(SUITE_TIMES.map((k) => [k, median(use.map((r) => r.timing?.[k] || 0))]));
    tests[key] = {
      runs: runs.length,
      failed: runs.length - ok.length,
      appMs: median(appMs),
      appMsAll: appMs,
      doneMs: median(doneMs),
      cpuMs: median(use.map((r) => r.perf.phases.reduce((a, p) => a + p.cpuMs, 0))),
      longTasks: median(use.map((r) => r.perf.phases.reduce((a, p) => a + p.longTasks, 0))),
      longMs: median(use.map((r) => r.perf.phases.reduce((a, p) => a + p.longMs, 0))),
      maxNodes: median(use.map((r) => Math.max(0, ...r.perf.phases.map((p) => p.nodes)))),
      heapMB: median(use.map((r) => r.perf.heapMB)),
      testMs: median(use.map((r) => r.ms)),
      suiteMs: median(use.map((r) => r.ms - r.perf.phases.reduce((a, p) => a + p.doneMs, 0))),
      suite,
      phases,
    };
  }
  const summary = { started: new Date().toISOString(), tests };
  writeFileSync(join(reportDir, "perf-summary.json"), JSON.stringify(summary, null, 1));
  let before = null;
  if (opt("perf-compare")) {
    try {
      before = JSON.parse(readFileSync(resolve(opt("perf-compare")), "utf8")).tests;
    } catch (e) {
      console.log(`Could not read ${opt("perf-compare")}: ${e.message}`);
    }
  }
  const pct = (a, b) => (a == null || !b ? "" : `${a <= b ? "" : "+"}${(((a - b) / b) * 100).toFixed(1)}%`);
  const rows = Object.entries(tests).map(([key, x]) => ({
    test: key.length > 58 ? key.slice(0, 57) + "…" : key,
    "app ms": Math.round(x.appMs),
    ...(before ? { "vs before": pct(x.appMs, before[key]?.appMs) } : {}),
    "done ms": Math.round(x.doneMs),
    "cpu ms": Math.round(x.cpuMs),
    "long tasks": `${x.longTasks} / ${Math.round(x.longMs)}ms`,
    nodes: x.maxNodes,
    "heap MB": x.heapMB,
    "suite s": (x.suiteMs / 1000).toFixed(1),
    ...(before ? { "suite vs": pct(x.suiteMs, before[key]?.suiteMs) } : {}),
    ...(x.failed ? { failed: x.failed } : {}),
  }));
  console.log("\nPerf (medians; app ms = the phases' time to their end state, suite s = the test's other time):");
  console.table(rows);
  console.log(`Perf summary: ${join(reportDir, "perf-summary.json")}`);
}

/** Tests that passed only on a retry, and repeated tests (--repeat) that passed in some runs only. */
function flakyList(results) {
  const out = results.filter((r) => r.status === "flaky").map((r) => `${r.suite} › ${r.name}`);
  const runs = new Map();
  for (const r of results) {
    const m = /^(.*) #\d+$/.exec(r.name);
    if (!m || repeat < 2) continue;
    const key = `${r.suite} › ${m[1]}`;
    runs.set(key, [...(runs.get(key) || []), r.status === "pass"]);
  }
  for (const [key, passes] of runs) {
    const failed = passes.filter((p) => !p).length;
    if (failed && failed < passes.length) out.push(`${key} (${failed} of ${passes.length} runs failed)`);
  }
  return out;
}

/** Writes results.json and index.html; also after every test, so a run that dies still leaves a report. */
function writeReport(started, results, partial) {
  const summary = {
    partial: partial ? `${results.length} of ${tests.length} tests so far` : null,
    started: new Date(started).toISOString(),
    seconds: Math.round((Date.now() - started) / 1000),
    tests: results.length,
    passed: results.filter((r) => r.status === "pass").length,
    failed: results.filter((r) => r.status === "fail").length,
    errored: results.filter((r) => r.status === "error").length,
    flaky: results.filter((r) => r.status === "flaky").length,
    // Flaky: passed on a retry, or (with --repeat) passed in some runs and not in others.
    flakyTests: flakyList(results),
    checkpoints: results.reduce((a, r) => a + r.checkpoints.length, 0),
    failedCheckpoints: results.reduce((a, r) => a + r.checkpoints.filter((c) => !c.pass).length, 0),
  };
  const byRule = {};
  for (const r of results) for (const c of r.checkpoints) {
    if (c.pass) continue;
    const rules = c.violations && c.violations.length ? [...new Set(c.violations.map((v) => v.rule))] : [c.kind === "baseline" ? "baseline" : c.kind === "console" ? "console-error" : c.kind === "error" ? "test-error" : /layout shift/.test(c.label) ? "layout-shift" : /other hosts/.test(c.label) ? "external-asset" : "assertion"];
    for (const rule of rules) (byRule[rule] ||= []).push(`${r.suite} › ${r.name} › ${c.label}`);
  }
  writeFileSync(join(reportDir, "results.json"), JSON.stringify({ summary, byRule, results }, null, 1));
  writeFileSync(join(reportDir, "index.html"), renderReport(summary, byRule, results));
  return { summary, byRule };
}

// ---- HTML report ------------------------------------------------------------------------------
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function renderReport(summary, byRule, results) {
  const suites = [...new Set(results.map((r) => r.suite))];
  const ruleRows = Object.entries(byRule).sort((a, b) => b[1].length - a[1].length)
    .map(([rule, list]) => `<tr><td><button class="rule" data-rule="${esc(rule)}">${esc(rule)}</button></td><td>${list.length}</td><td class="muted">${esc(criteria[rule] || "")}</td></tr>`).join("");
  const criteriaRows = Object.entries(criteria).map(([rule, text]) => `<tr><td><code>${esc(rule)}</code></td><td>${byRule[rule] ? `<b style="color:var(--bad)">FAIL ×${byRule[rule].length}</b>` : `<span style="color:var(--ok)">pass</span>`}</td><td>${esc(text)}</td></tr>`).join("");
  const cp = (c) => {
    const rules = c.violations ? [...new Set(c.violations.map((v) => v.rule))].join(" ") : c.kind === "baseline" ? "baseline" : c.kind === "console" ? "console-error" : c.kind === "error" ? "test-error" : /layout shift/.test(c.label) ? "layout-shift" : /other hosts/.test(c.label) ? "external-asset" : "assertion";
    const viol = c.violations && c.violations.length
      ? `<table class="viol"><tr><th>#</th><th>rule</th><th>element</th><th>problem</th></tr>${c.violations.map((v, i) => `<tr><td>${i + 1}</td><td>${esc(v.rule)}</td><td><code>${esc(v.target)}</code></td><td>${esc(v.message)}</td></tr>`).join("")}</table>`
      : "";
    const counts = c.counts && Object.keys(c.counts).length ? `<div class="muted">totals: ${Object.entries(c.counts).map(([k, v]) => `${esc(k)} ${v}`).join(", ")}</div>` : "";
    const detail = c.detail ? `<pre>${esc(c.detail)}</pre>` : "";
    const shot = (c.screenshot ? `<a href="shots/${esc(c.screenshot)}" target="_blank"><img loading="lazy" src="shots/${esc(c.screenshot)}" alt="${esc(c.label)}"></a>` : "") + (c.diff ? `<a href="shots/${esc(c.diff)}" target="_blank"><img loading="lazy" src="shots/${esc(c.diff)}" alt="differences"></a>` : "");
    return `<div class="cp ${c.pass ? "ok" : "bad"}" data-rules="${c.pass ? "" : esc(rules)}"><div class="cp-head"><span class="badge">${c.pass ? "PASS" : "FAIL"}</span> <span class="kind">${esc(c.kind)}</span> ${esc(c.label)}</div><div class="cp-body"><div class="cp-text">${viol}${counts}${detail}</div>${shot}</div></div>`;
  };
  const testHtml = (r) => {
    const failed = r.checkpoints.filter((c) => !c.pass).length;
    const first = r.firstAttempt ? `<pre class="err">Failed on the first attempt, passed on the retry:\n${esc(r.firstAttempt.join("\n"))}</pre>` : "";
    return `<details class="test ${r.status}"><summary><span class="badge">${r.status.toUpperCase()}</span> ${esc(r.name)} <span class="muted">${esc(r.viewport)}${r.dark ? " · dark" : ""} · ${r.checkpoints.length} checkpoints${failed ? `, ${failed} failed` : ""} · ${((r.ms || 0) / 1000).toFixed(1)}s</span></summary>${first}${r.error ? `<pre class="err">${esc(r.error)}</pre>` : ""}${r.checkpoints.map(cp).join("")}</details>`;
  };
  const suiteHtml = suites.map((s) => {
    const rs = results.filter((r) => r.suite === s);
    const bad = rs.filter((r) => r.status !== "pass").length;
    return `<section class="suite"><h2>${esc(s)} <span class="muted">${rs.length - bad}/${rs.length} passed</span></h2>${rs.map(testHtml).join("")}</section>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kubus GUI report</title>
<style>
:root{--bg:#fff;--fg:#161616;--muted:#6f6f6f;--line:#e0e0e0;--ok:#24a148;--bad:#da1e28;--warn:#b28600;--card:#f4f4f4}
@media (prefers-color-scheme: dark){:root{--bg:#161616;--fg:#f4f4f4;--muted:#a8a8a8;--line:#393939;--card:#262626}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
h1{font-size:24px;margin:0 0 8px}h2{font-size:18px;margin:24px 0 8px}
.muted{color:var(--muted);font-weight:normal}
.stats{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}.stat{background:var(--card);padding:8px 12px}.stat b{display:block;font-size:20px}
.controls{position:sticky;top:0;background:var(--bg);padding:8px 0;border-bottom:1px solid var(--line);z-index:2;display:flex;gap:8px;flex-wrap:wrap}
button{font:inherit;padding:4px 10px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}button.on{outline:2px solid #0f62fe}
.rules td{padding:2px 12px 2px 0}
details.test{border:1px solid var(--line);margin:6px 0;background:var(--bg)}details.test>summary{padding:6px 10px;cursor:pointer}
.badge{display:inline-block;font-size:11px;font-weight:600;padding:1px 6px;color:#fff;background:var(--ok)}
.fail>summary .badge,.cp.bad .badge{background:var(--bad)}.error>summary .badge{background:var(--warn)}.flaky>summary .badge{background:#8a3ffc}
.cp{border-top:1px solid var(--line);padding:8px 10px}.cp-head{margin-bottom:6px}.kind{color:var(--muted);font-size:12px}
.cp-body{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}.cp-text{flex:1 1 420px;min-width:0}
.cp img{max-width:480px;width:100%;border:1px solid var(--line)}
table.viol{border-collapse:collapse;width:100%;font-size:12px}table.viol td,table.viol th{border-bottom:1px solid var(--line);padding:3px 6px;text-align:left;vertical-align:top}
code{font-size:11px;word-break:break-all}pre{white-space:pre-wrap;word-break:break-word;font-size:12px;background:var(--card);padding:6px;margin:4px 0}
body.only-failed details.test.pass{display:none}body.only-failed .cp.ok{display:none}
body.filtered .cp{display:none}body.filtered .cp.match{display:block}body.filtered details.test:not(.has-match){display:none}
</style></head><body>
<h1>Kubus GUI report</h1>
<div class="muted">${esc(summary.started)} · ${summary.seconds}s${summary.partial ? ` · <b>incomplete: ${esc(summary.partial)}</b>` : ""}</div>
<div class="stats"><div class="stat"><b>${summary.tests}</b>tests</div><div class="stat"><b style="color:var(--ok)">${summary.passed}</b>passed</div><div class="stat"><b style="color:var(--bad)">${summary.failed}</b>failed</div><div class="stat"><b style="color:#8a3ffc">${summary.flaky}</b>flaky</div><div class="stat"><b style="color:var(--warn)">${summary.errored}</b>errored</div><div class="stat"><b>${summary.failedCheckpoints}/${summary.checkpoints}</b>checkpoints failed</div></div>
${summary.flakyTests.length ? `<h2>Flaky</h2><ul>${summary.flakyTests.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}<h2>Failures by criterion</h2>${ruleRows ? `<table class="rules">${ruleRows}</table>` : "<p>None.</p>"}
<details><summary>All pass/fail criteria (${Object.keys(criteria).length})</summary><table class="rules">${criteriaRows}</table></details>
<div class="controls"><button id="failed">Only failures</button><button id="expand">Expand all</button><button id="collapse">Collapse all</button><button id="clear">Clear criterion filter</button></div>
${suiteHtml}
<script>
const b=document.body;
document.getElementById('failed').onclick=e=>{b.classList.toggle('only-failed');e.target.classList.toggle('on')};
document.getElementById('expand').onclick=()=>document.querySelectorAll('details.test').forEach(d=>d.open=true);
document.getElementById('collapse').onclick=()=>document.querySelectorAll('details.test').forEach(d=>d.open=false);
document.getElementById('clear').onclick=()=>{b.classList.remove('filtered');document.querySelectorAll('.match,.has-match').forEach(e=>e.classList.remove('match','has-match'));document.querySelectorAll('button.rule').forEach(x=>x.classList.remove('on'))};
document.querySelectorAll('button.rule').forEach(btn=>btn.onclick=()=>{document.getElementById('clear').onclick();btn.classList.add('on');b.classList.add('filtered');const r=btn.dataset.rule;document.querySelectorAll('.cp').forEach(c=>{if((' '+c.dataset.rules+' ').includes(' '+r+' ')){c.classList.add('match');const d=c.closest('details');d.classList.add('has-match');d.open=true}})});
</script></body></html>`;
}

// Ctrl+C, a closed terminal or a crash: don't leave browsers behind (a hard kill can't be caught;
// the next run ends those).
let activeSessions = [];
let cleaning = false;
function cleanUp(code) {
  if (cleaning) return;
  cleaning = true;
  if (activeSessions.length) console.log("\nClosing the browsers…");
  killStrays();
  stopServer();
  process.exit(code);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(sig, () => cleanUp(130));

main().catch((e) => {
  console.error(e);
  cleanUp(1);
});
