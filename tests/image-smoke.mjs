#!/usr/bin/env node
// Smoke test of the deliverable server image (server/Dockerfile, run by docker-compose.yml, published by
// .github/workflows/image.yml): builds it, starts the repo's own docker-compose.yml with its own throwaway
// Postgres (compose project `kubus-image-smoke`, container names and ports overridden, the image local), and
// checks over HTTP what a user of the image relies on:
//   health, the token refusal, a sync round trip (shared/sync.ts), /api/v1 (the bundled headless device, not 503),
//   the web app's files, and a stop / start of the whole stack that keeps the data.
// Everything is torn down at the end, also on failure. `node tests/image-smoke.mjs [--keep] [--no-build]`.
// Needs Docker (compose v2.24+); the first build downloads the base images (a few minutes), then it is cached.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SYNC_COMPATIBLE, SYNC_VERSION } from "../shared/sync.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE = "kubus-server:test";
const PROJECT = "kubus-image-smoke";
const TOKEN = "change-me"; // docker-compose.yml's own
const keep = process.argv.includes("--keep");

const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", stdio: opts.show ? "inherit" : "pipe", maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.status !== 0 && !opts.soft) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})\n${r.stdout ?? ""}${r.stderr ?? ""}`);
  return (r.stdout ?? "").trim();
};
const started = Date.now();
const log = (m) => console.log(`[image-smoke ${((Date.now() - started) / 1000).toFixed(0)}s] ${m}`);

// The repo's compose file, with the image local and nothing fixed that could collide with a running stack.
const dir = mkdtempSync(join(tmpdir(), "kubus-image-smoke-"));
const override = join(dir, "override.yml");
writeFileSync(override, `services:
  db:
    container_name: !reset null
  server:
    container_name: !reset null
    image: ${IMAGE}
    pull_policy: never
    ports: !override
      - "8080"
`);
const composeArgs = ["compose", "-p", PROJECT, "-f", "docker-compose.yml", "-f", override];
const compose = (...args) => sh("docker", [...composeArgs, ...args]);

const checks = [];
const check = async (name, fn) => {
  try {
    await fn();
    checks.push([name, true]);
    log(`ok   ${name}`);
  } catch (e) {
    checks.push([name, false]);
    log(`FAIL ${name}: ${e.message}`);
  }
};
const assert = (cond, message) => { if (!cond) throw new Error(message); };

let base = "";
const call = async (method, path, { body, token = TOKEN } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, json, headers: res.headers };
};
const until = async (what, fn, ms = 60_000) => {
  const t = Date.now();
  let last;
  while (Date.now() - t < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
};
const waitHealthy = async () => {
  const out = compose("port", "server", "8080"); // 0.0.0.0:49153
  base = `http://127.0.0.1:${out.split(":").pop()}`;
  await until("the server's health", async () => (await call("GET", "/api/health", { token: null })).status === 200);
};

const T = "2026-10-01T00:00:00.000Z";
const SPACE = { id: "11111111-1111-4111-8111-111111111111", name: "Image smoke", icon: null, position: 0, created_at: T, updated_at: T, deleted_at: null };
const syncRequest = (over = {}) => ({ since: 0, changes: {}, version: SYNC_VERSION, compatible: SYNC_COMPATIBLE, ...over });

let failed = false;
try {
  if (!process.argv.includes("--no-build")) {
    log(`building ${IMAGE}`);
    let dockerfile = "server/Dockerfile";
    // Behind a proxy that re-signs TLS (some sandboxes) npm in the build can't verify the registry: with
    // KUBUS_IMAGE_CA=<the proxy's CA bundle> the build trusts it (a copy of the Dockerfile, for local runs only).
    if (process.env.KUBUS_IMAGE_CA) {
      copyFileSync(process.env.KUBUS_IMAGE_CA, join(root, ".image-smoke-ca.crt"));
      dockerfile = ".image-smoke.Dockerfile";
      writeFileSync(join(root, dockerfile), readFileSync(join(root, "server/Dockerfile"), "utf8")
        .replace(/^(FROM .*)$/gm, "$1\nCOPY .image-smoke-ca.crt /ca.crt\nENV NODE_EXTRA_CA_CERTS=/ca.crt npm_config_cafile=/ca.crt"));
    }
    try {
      sh("docker", ["build", "-f", dockerfile, "-t", IMAGE, "."], { env: { ...process.env, DOCKER_BUILDKIT: "1" } });
    } finally {
      for (const f of [".image-smoke-ca.crt", ".image-smoke.Dockerfile"]) rmSync(join(root, f), { force: true });
    }
  }
  log("starting the stack");
  compose("down", "-v", "--remove-orphans");
  compose("up", "-d", "--wait", "--wait-timeout", "120");
  await waitHealthy();

  await check("health answers without a token", async () => {
    const r = await call("GET", "/api/health", { token: null });
    assert(r.status === 200 && r.json?.ok === true, `got ${r.status} ${r.text}`);
  });
  await check("the server refuses a missing or wrong token", async () => {
    for (const [path, method] of [["/api/sync", "POST"], ["/api/settings", "GET"], ["/api/v1/spaces", "GET"]]) {
      for (const token of [null, "wrong-token"]) {
        const r = await call(method, path, { token, body: method === "POST" ? syncRequest() : undefined });
        assert(r.status === 401, `${method} ${path} with ${token ?? "no token"}: ${r.status}`);
      }
    }
  });

  let database;
  await check("a sync round trip: push a row, pull it back as another device", async () => {
    const pushed = await call("POST", "/api/sync", { body: syncRequest({ changes: { spaces: [SPACE] } }) });
    assert(pushed.status === 200 && pushed.json.cursor >= 1, `push: ${pushed.status} ${pushed.text}`);
    database = pushed.json.database;
    assert(database?.id, "no database id");
    const pulled = await call("POST", "/api/sync", { body: syncRequest({ database: database.id }) });
    assert(pulled.status === 200, `pull: ${pulled.status} ${pulled.text}`);
    assert(pulled.json.changes.spaces?.some((r) => r.id === SPACE.id && r.name === SPACE.name), `the space is missing: ${pulled.text}`);
    assert(pulled.json.cursor === pushed.json.cursor, "cursors differ");
  });
  await check("a device with another database id is refused (409)", async () => {
    const other = await call("POST", "/api/sync", { body: syncRequest({ database: "00000000-0000-4000-8000-000000000000" }) });
    assert(other.status === 409, `mismatch: ${other.status}`);
  });

  await check("/api/v1 is answered by the bundled headless device (not 503) and sees the synced row", async () => {
    await until("the headless device to list the synced space", async () => {
      const r = await call("GET", "/api/v1/spaces");
      return r.status === 200 && Array.isArray(r.json) && r.json.some((s) => s.id === SPACE.id);
    });
  });
  await check("a write through /api/v1 reaches the sync endpoint", async () => {
    const made = await call("POST", "/api/v1/spaces", { body: { name: "Via the API" } });
    assert(made.status >= 200 && made.status < 300, `create: ${made.status} ${made.text}`);
    await until("the API's space on the sync endpoint", async () => {
      const r = await call("POST", "/api/sync", { body: syncRequest({ database: database.id }) });
      return r.json?.changes?.spaces?.some((s) => s.name === "Via the API");
    });
  });
  await check("the web app is served: index.html, its assets, the SPA fallback", async () => {
    const index = await call("GET", "/", { token: null });
    assert(index.status === 200 && /text\/html/.test(index.headers.get("content-type")), `index: ${index.status}`);
    const asset = index.text.match(/(?:src|href)="(\/?assets\/[^"]+\.js)"/)?.[1];
    assert(asset, "index.html names no script in /assets");
    const js = await call("GET", asset.startsWith("/") ? asset : `/${asset}`, { token: null });
    assert(js.status === 200 && /javascript/.test(js.headers.get("content-type")), `asset ${asset}: ${js.status}`);
    const route = await call("GET", "/some/app/route", { token: null });
    assert(route.status === 200 && route.text === index.text, `fallback: ${route.status}`);
    assert((await call("GET", "/assets/missing.js", { token: null })).status === 404, "a missing asset should be 404");
  });

  log("stopping and starting the whole stack");
  const stopping = Date.now();
  compose("stop", "server");
  const stopSeconds = (Date.now() - stopping) / 1000;
  compose("stop");
  compose("start");
  await waitHealthy();
  await check("the server stops on SIGTERM instead of waiting to be killed", async () => {
    assert(stopSeconds < 8, `docker stop took ${stopSeconds.toFixed(1)}s (the kill comes after 10)`);
  });
  await check("after a restart the data is still there, same database id", async () => {
    const pulled = await until("a sync after the restart", async () => {
      const r = await call("POST", "/api/sync", { body: syncRequest({ database: database.id }) });
      return r.status === 200 ? r : null;
    });
    assert(pulled.json.database.id === database.id, "the database id changed");
    assert(pulled.json.changes.spaces?.some((r) => r.id === SPACE.id), "the space is gone");
    await until("/api/v1 after the restart", async () => {
      const r = await call("GET", "/api/v1/spaces");
      return r.status === 200 && r.json.some((s) => s.id === SPACE.id);
    });
  });
  await check("the server's log shows both starts and no errors", async () => {
    const logs = compose("logs", "server", "--no-color");
    assert((logs.match(/Kubus server on :8080/g) ?? []).length >= 2, "expected two start lines");
    assert(/API ready at \/api\/v1/.test(logs), "the headless device never reported ready");
    const bad = logs.split("\n").filter((l) => /\b(error|unhandled|ECONNREFUSED)\b/i.test(l));
    assert(!bad.length, bad.slice(0, 3).join("\n"));
  });
  failed = checks.some(([, ok]) => !ok);
} catch (e) {
  failed = true;
  console.error(e.message);
  try { console.error(compose("logs", "--no-color", "--tail", "60")); } catch { /* not up */ }
} finally {
  if (!keep) {
    sh("docker", [...composeArgs, "down", "-v", "--remove-orphans"], { soft: true });
    rmSync(dir, { recursive: true, force: true });
  } else console.log(`kept: docker ${composeArgs.join(" ")} (override ${override})`);
}
log(failed ? `FAILED: ${checks.filter(([, ok]) => !ok).map(([n]) => n).join("; ") || "setup"}` : `all ${checks.length} checks green`);
process.exit(failed ? 1 : 0);
