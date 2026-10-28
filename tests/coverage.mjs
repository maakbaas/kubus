#!/usr/bin/env node
// One coverage report for everything: `npm run coverage:report` merges what exists of
//   coverage/unit/coverage-final.json   `npm run test:coverage` (vitest)
//   coverage/server-v8/                 the same run: the real server the HTTP tests start as a child
//                                       process dumps its own V8 coverage there (server/test/serve.ts)
//   coverage/gui-v8*/                   `npm run test:gui -- --coverage`: V8 coverage per GUI test, in
//                                       the bundled build's terms; mapped here through its source maps
// into coverage/index.html (+ coverage-summary.json, coverage-final.json) and a table per directory.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import v8 from "@bcoe/v8-coverage";
import { convert } from "ast-v8-to-istanbul";
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";
import { parseAstAsync } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "coverage");
const rel = (file) => relative(root, file).replaceAll("\\", "/");

/** The files the report is about (vitest.config.ts has the same for the unit tests). */
const counted = (file) => /^(app\/src|server\/src|shared)\//.test(rel(file)) && !/\.test\.tsx?$|^app\/src\/test\/|\.(css|md|sql)$|\.d\.ts$/.test(rel(file));

// ---- merge ------------------------------------------------------------------------------------------
// The two kinds map the same sources, but through different transforms, so a file's statements,
// functions and branches are not numbered alike: istanbul's own merge (by number) would mix them up.
// Entries are matched by their place in the source instead; one only a side saw is added.
const place = (r) => `${r.start.line}:${r.start.column}`;
function mergeFile(a, b) {
  const into = structuredClone(a.toJSON());
  const other = b.toJSON();
  /** [key, id] of each entry; the key is its place, counted when several share one. */
  const keyed = (entries, keyOf) => {
    const seen = new Map();
    return Object.entries(entries).map(([id, entry]) => {
      const key = keyOf(entry);
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      return [`${key}#${n}`, id];
    });
  };
  const add = (mapKey, counts, keyOf, plus) => {
    const index = new Map(keyed(into[mapKey], keyOf));
    for (const [key, id] of keyed(other[mapKey], keyOf)) {
      const at = index.get(key);
      if (at !== undefined) into[counts][at] = plus(into[counts][at], other[counts][id]);
      else {
        const fresh = String(Object.keys(into[mapKey]).length);
        into[mapKey][fresh] = other[mapKey][id];
        into[counts][fresh] = other[counts][id];
      }
    }
  };
  add("statementMap", "s", place, (x, y) => x + y);
  add("fnMap", "f", (fn) => place(fn.loc), (x, y) => x + y);
  add("branchMap", "b", (br) => `${br.type} ${br.locations.length} ${place(br.loc)}`, (x, y) => x.map((n, i) => n + y[i]));
  return libCoverage.createFileCoverage(into);
}

/** The coverage maps as one. */
function union(list) {
  const merged = libCoverage.createCoverageMap({});
  for (const file of new Set(list.flatMap((m) => m.files()))) {
    merged.addFileCoverage(list.filter((m) => m.data[file]).map((m) => m.fileCoverageFor(file)).reduce(mergeFile));
  }
  return merged;
}

// ---- unit tests: istanbul json from vitest -------------------------------------------------------
const maps = {};
const unitFile = join(out, "unit", "coverage-final.json");
if (existsSync(unitFile)) maps.unit = libCoverage.createCoverageMap(JSON.parse(readFileSync(unitFile, "utf8")));

// ---- the server's child processes: raw V8 dumps of node running server/src/*.ts ----------------------
// Node strips the types by blanking them, so the offsets of the executed code are the source's.
const dumps = join(out, "server-v8");
if (existsSync(dumps)) {
  const merged = v8.mergeProcessCovs(readdirSync(dumps).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dumps, f), "utf8"))));
  const files = [];
  for (const script of merged.result.filter((s) => s.url.startsWith("file:") && counted(fileURLToPath(s.url)))) {
    const code = stripTypeScriptTypes(readFileSync(fileURLToPath(script.url), "utf8"));
    const data = await convert({ code, ast: parseAstAsync(code), coverage: script });
    files.push(libCoverage.createCoverageMap(data));
  }
  maps.server = union(files);
}

// ---- GUI tests: V8 coverage of the build, through its source maps --------------------------------
/** The merged V8 coverage of every GUI test of a run folder, by script url. */
function mergeGuiRun(dir) {
  let merged = null;
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json.gz"))) {
    const takes = JSON.parse(gunzipSync(readFileSync(join(dir, name))));
    const test = v8.mergeProcessCovs(takes.map((result) => ({ result: result.map((script, i) => ({ scriptId: String(i), ...script })) })));
    merged = merged ? v8.mergeProcessCovs([merged, test]) : test;
  }
  return merged;
}

async function guiMap(dir) {
  const { buildDir, baseUrl } = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  const merged = mergeGuiRun(dir);
  const maps = [];
  for (const script of merged?.result ?? []) {
    const file = join(buildDir, new URL(script.url).pathname.slice(new URL(baseUrl).pathname.length));
    if (!existsSync(`${file}.map`)) continue;
    const sourceMap = JSON.parse(readFileSync(`${file}.map`, "utf8"));
    sourceMap.sources = sourceMap.sources.map((s) => resolve(dirname(file), s));
    if (!sourceMap.sources.some(counted)) continue; // a vendor chunk
    const code = readFileSync(file, "utf8");
    const data = await convert({ code, sourceMap, ast: parseAstAsync(code), coverage: { url: pathToFileURL(file).href, functions: script.functions } });
    maps.push(libCoverage.createCoverageMap(Object.fromEntries(Object.entries(data).filter(([path]) => counted(path)))));
  }
  return union(maps);
}

// A run's folder per --name (gui-v8, gui-v8-b): their tests together.
const guiDirs = existsSync(out) ? readdirSync(out).filter((d) => d.startsWith("gui-v8") && existsSync(join(out, d, "meta.json"))) : [];
if (guiDirs.length) maps.gui = union(await Promise.all(guiDirs.map((dir) => guiMap(join(out, dir)))));

if (!Object.keys(maps).length) {
  console.error("No coverage to report: run `npm run test:coverage` and/or `npm run test:gui -- --coverage` first.");
  process.exit(1);
}

const merged = union(Object.values(maps));

// ---- report -----------------------------------------------------------------------------------------
const context = libReport.createContext({ dir: out, coverageMap: merged, defaultSummarizer: "nested" });
for (const name of ["html", "json-summary", "json"]) reports.create(name).execute(context);
writeFileSync(join(out, "coverage-final.json"), JSON.stringify(merged));

/** app/src/<dir> for the app, else the file's own directory (server/src, server/src/connectors, shared). */
const group = (file) => {
  const dir = dirname(rel(file));
  return dir.startsWith("app/src/") ? dir.split("/").slice(0, 3).join("/") : dir;
};
const total = (map, files) => libCoverage.createCoverageMap(Object.fromEntries(files.filter((f) => map.data[f]).map((f) => [f, map.data[f]]))).getCoverageSummary();
const pct = (summary, key) => (summary[key].total === 0 ? "-" : summary[key].pct.toFixed(1));
const groups = {};
for (const file of merged.files()) (groups[group(file)] ??= []).push(file);
const rows = Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
const sources = Object.keys(maps).filter((k) => maps[k]);
const header = ["", "files", "stmts", "branch", "funcs", "lines", ...sources.map((k) => `${k} stmts`)];
const table = [header, ...[["all", merged.files()], ...rows].map(([name, files]) => {
  const s = total(merged, files);
  return [name, String(files.length), pct(s, "statements"), pct(s, "branches"), pct(s, "functions"), pct(s, "lines"), ...sources.map((k) => pct(total(maps[k], files), "statements"))];
})];
const widths = header.map((_, c) => Math.max(...table.map((r) => r[c].length)));
for (const row of table) console.log(row.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]) : cell.padStart(widths[c]))).join("  "));
console.log(`\n${rel(join(out, "index.html"))}  (merged: ${sources.join(" + ")})`);
