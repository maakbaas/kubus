#!/usr/bin/env node
// One coverage report for everything: `npm run coverage:report` merges what exists of
//   coverage/unit/coverage-final.json   `npm run test:coverage` (vitest)
//   coverage/server-v8/                 the same run: the real server the HTTP tests start as a child
//                                       process dumps its own V8 coverage there (server/test/serve.ts)
//   coverage/gui-v8*/                   `npm run test:gui -- --coverage`: V8 coverage per GUI test, in
//                                       the bundled build's terms; mapped here through its source maps
// (KUBUS_COVERAGE_DIR and KUBUS_ROOT: the folder and the checkout to report on, when not these.)
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

const root = process.env.KUBUS_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.env.KUBUS_COVERAGE_DIR ?? join(root, "coverage");
const rel = (file) => relative(root, file).replaceAll("\\", "/");

/** The files the report is about (vitest.config.ts has the same for the unit tests). */
const counted = (file) => /^(app\/src|server\/src|shared)\//.test(rel(file)) && !/\.test\.tsx?$|^app\/src\/test\/|\.(css|md|sql)$|\.d\.ts$/.test(rel(file));

// ---- merge ------------------------------------------------------------------------------------------
// The sources map the same files, but through different transforms (vitest's, the bundler's, node's), so a
// file's statements, functions and branches are neither numbered nor cut alike (a declaration here, its
// declarator there, a tree-shaken statement gone). istanbul's own merge (by number) would mix them up, and
// a merge that adds every entry no other side has would grow the denominator with duplicates of one
// statement, putting the merged percentage below its inputs'.
// So a file's richest map (most statements) is the base and the others are folded into it: an entry is
// matched by its place (line:column, else the nearest on the same line) and its count added. One that finds
// no match is added only when it ran, so that what any source executed counts, and what only one side
// knows but never ran does not.
/** A matcher over the base's entries: the id of the one at `r`'s place, else the nearest on its line. */
function matcher(entries, locOf, same = () => true) {
  const exact = new Map();
  const lines = new Map();
  for (const [id, entry] of Object.entries(entries)) {
    const at = locOf(entry).start;
    const key = `${at.line}:${at.column}`;
    if (!exact.has(key)) exact.set(key, []);
    exact.get(key).push({ id, entry });
    if (!lines.has(at.line)) lines.set(at.line, []);
    lines.get(at.line).push({ id, entry, column: at.column ?? 0 });
  }
  const used = new Set();
  return (other) => {
    const at = locOf(other).start;
    const fit = (list) => list?.filter((c) => same(c.entry, other));
    // An exact place no other entry has taken yet, else any exact one; then the nearest on the line.
    const exacts = fit(exact.get(`${at.line}:${at.column}`));
    const found = exacts?.find((c) => !used.has(c.id)) ?? exacts?.[0];
    if (found) {
      used.add(found.id);
      return found.id;
    }
    const near = fit(lines.get(at.line))?.sort((x, y) => Math.abs(x.column - (at.column ?? 0)) - Math.abs(y.column - (at.column ?? 0)));
    const pick = near?.find((c) => !used.has(c.id)) ?? near?.[0];
    if (pick) used.add(pick.id);
    return pick?.id;
  };
}

/** The coverage of one file by several sources, as one (see above). */
function mergeFile(list) {
  const [first, ...rest] = [...list].sort((a, b) => Object.keys(b.statementMap).length - Object.keys(a.statementMap).length);
  const into = structuredClone(first.toJSON());
  for (const file of rest) {
    const other = file.toJSON();
    const fold = (mapKey, counts, locOf, plus, ran, same) => {
      const find = matcher(into[mapKey], locOf, same);
      for (const [id, entry] of Object.entries(other[mapKey])) {
        const at = find(entry);
        if (at !== undefined) into[counts][at] = plus(into[counts][at], other[counts][id]);
        else if (ran(other[counts][id])) {
          const fresh = String(Math.max(-1, ...Object.keys(into[mapKey]).map(Number)) + 1);
          into[mapKey][fresh] = entry;
          into[counts][fresh] = other[counts][id];
        }
      }
    };
    fold("statementMap", "s", (r) => r, (x, y) => x + y, (n) => n > 0);
    fold("fnMap", "f", (fn) => fn.loc, (x, y) => x + y, (n) => n > 0);
    fold("branchMap", "b", (br) => br.loc, (x, y) => x.map((n, i) => n + (y[i] ?? 0)), (n) => n.some((c) => c > 0), (a, b) => a.type === b.type && a.locations.length === b.locations.length);
  }
  return libCoverage.createFileCoverage(into);
}

/** The coverage maps as one. */
function union(list) {
  const merged = libCoverage.createCoverageMap({});
  for (const file of new Set(list.flatMap((m) => m.files()))) {
    const files = list.filter((m) => m.data[file]).map((m) => m.fileCoverageFor(file));
    merged.addFileCoverage(files.length === 1 ? files[0] : mergeFile(files));
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

// The bundler's statements are not the source's: converting the bundle (ast-v8-to-istanbul) gives a
// statement map that lacks what the source map cannot place (a third of a file's `useEffect` bodies, say) and
// cuts the rest differently from vitest's. So the statements and functions of a source file that the unit
// run knows (all of them: its coverage includes every file) are counted from the V8 ranges instead:
// where the source map puts the statement's start in the bundle, the count of the innermost range there.
// The branches, and any statement the conversion has that the unit run's map has no place for, still come
// from the conversion (matched by place when merged).
const B64 = new Map([..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].map((c, i) => [c, i]));
/** A source map's segments as [source, line, column, generated offset], the lines 0-based. */
function segments(mappings, code) {
  const starts = [0];
  for (let i = code.indexOf("\n"); i >= 0; i = code.indexOf("\n", i + 1)) starts.push(i + 1);
  const out = [];
  let source = 0;
  let line = 0;
  let column = 0;
  mappings.split(";").forEach((generated, row) => {
    let at = 0;
    for (const segment of generated.split(",")) {
      if (!segment) continue;
      const fields = [];
      for (let i = 0, shift = 0, value = 0; i < segment.length; i++) {
        const digit = B64.get(segment[i]);
        value += (digit & 31) << shift;
        if (digit & 32) shift += 5;
        else {
          fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
          shift = 0;
          value = 0;
        }
      }
      at += fields[0];
      if (fields.length < 4) continue;
      source += fields[1];
      line += fields[2];
      column += fields[3];
      out.push([source, line, column, starts[row] + at]);
    }
  });
  return out;
}

/** The execution counts at the (ascending) offsets of a script: those of the innermost V8 range holding each. */
function countsAt(functions, offsets) {
  const ranges = functions.flatMap((fn) => fn.ranges).sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  const stack = [];
  let next = 0;
  return offsets.map((offset) => {
    while (stack.length && stack.at(-1).endOffset <= offset) stack.pop();
    for (; next < ranges.length && ranges[next].startOffset <= offset; next++) if (ranges[next].endOffset > offset) stack.push(ranges[next]);
    return stack.at(-1)?.count ?? 0;
  });
}

async function guiMap(dir, known) {
  const { buildDir, baseUrl } = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  const merged = mergeGuiRun(dir);
  const converted = [];
  const projected = {}; // file -> { s, f }: the unit run's statements and functions, counted from the ranges
  for (const script of merged?.result ?? []) {
    const file = join(buildDir, new URL(script.url).pathname.slice(new URL(baseUrl).pathname.length));
    if (!existsSync(`${file}.map`)) continue;
    const sourceMap = JSON.parse(readFileSync(`${file}.map`, "utf8"));
    sourceMap.sources = sourceMap.sources.map((s) => resolve(dirname(file), s));
    if (!sourceMap.sources.some(counted)) continue; // a vendor chunk
    const code = readFileSync(file, "utf8");
    const data = await convert({ code, sourceMap, ast: parseAstAsync(code), coverage: { url: pathToFileURL(file).href, functions: script.functions } });
    const own = Object.fromEntries(Object.entries(data).filter(([path]) => counted(path)));
    converted.push(libCoverage.createCoverageMap(own));

    // The source's statements and functions: the first segment at or after the start (before the end line).
    const lines = sourceMap.sources.map(() => new Map());
    for (const [source, line, column, offset] of segments(sourceMap.mappings, code)) {
      if (!lines[source].has(line)) lines[source].set(line, []);
      lines[source].get(line).push([column, offset]);
    }
    for (const list of lines) for (const line of list.values()) line.sort((a, b) => a[0] - b[0]);
    const queries = []; // [offset, file, map key, id]
    sourceMap.sources.forEach((path, source) => {
      if (!known.data[path] || !lines[source].size) return;
      const first = (loc, endLine) => {
        for (let line = loc.start.line - 1; line < Math.max(endLine, loc.start.line); line++) {
          const found = lines[source].get(line)?.find(([column]) => line > loc.start.line - 1 || column >= loc.start.column);
          if (found) return found[1];
        }
      };
      const { statementMap, fnMap } = known.data[path].toJSON();
      for (const [id, loc] of Object.entries(statementMap)) queries.push([first(loc, loc.end.line), path, "s", id]);
      for (const [id, fn] of Object.entries(fnMap)) queries.push([first(fn.loc, fn.loc.end.line), path, "f", id]);
    });
    const placed = queries.filter((q) => q[0] !== undefined).sort((a, b) => a[0] - b[0]);
    const counts = countsAt(script.functions, placed.map((q) => q[0]));
    placed.forEach(([, path, kind, id], i) => {
      const into = (projected[path] ??= { s: {}, f: {} })[kind];
      into[id] = (into[id] ?? 0) + counts[i];
    });
  }
  // A file the bundle holds: the unit run's statements and functions with these counts (and the conversion's, merged).
  const files = Object.entries(projected).map(([path, { s, f }]) => {
    const { statementMap, fnMap } = known.data[path].toJSON();
    const zero = (map, counts) => Object.fromEntries(Object.keys(map).map((id) => [id, counts[id] ?? 0]));
    return libCoverage.createCoverageMap({ [path]: { path, statementMap, fnMap, branchMap: {}, s: zero(statementMap, s), f: zero(fnMap, f), b: {} } });
  });
  return union([...converted, ...files]);
}

// A run's folder per --name (gui-v8, gui-v8-b): their tests together.
const guiDirs = existsSync(out) ? readdirSync(out).filter((d) => d.startsWith("gui-v8") && existsSync(join(out, d, "meta.json"))) : [];
if (guiDirs.length) maps.gui = union(await Promise.all(guiDirs.map((dir) => guiMap(join(out, dir), maps.unit ?? libCoverage.createCoverageMap({})))));

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
