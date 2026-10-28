import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { createPool } from "./db.ts";
import { broadcast, handleEvents, latestCursor } from "./events.ts";
import { aiInfo, aiProxy, setAiSettings } from "./ai.ts";
import { deleteFile, getFile, hasFile, putFile } from "./files.ts";
import { HeadlessHost } from "./headless.ts";
import { FILE_ID } from "../../shared/files.ts";
import { applySchema } from "./migrations.ts";
import { handleMcp, type Access } from "./mcp.ts";
import { loadSchema } from "./schema.ts";
import { Sources } from "./sources.ts";
import { applyUpdate, loadSettings, NO_SETTINGS, saveSettings, secretKey, secretWarnings, sourceConfigs, usable, viewOf, type Stored } from "./settings.ts";
import type { ServerSettingsUpdate } from "../../shared/settings.ts";
import { currentCursor, handleSync } from "./sync.ts";
import { wipe } from "./wipe.ts";
import { MAX_FILE_BYTES, type SyncRequest } from "../../shared/sync.ts";
import { HttpError, json, readJson, Router, type ApiRequest, type ApiResponse } from "../../shared/router.ts";

// Kubus server: the sync API (/api), the HTTP API for other tools (/api/v1, answered by the
// headless device: server/src/headless.ts; for assistants also over MCP: server/src/mcp.ts) and, from the same origin, the web app (so a phone can
// install it as a home-screen app). Configuration is environment only:
//   DATABASE_URL  Postgres connection string        KUBUS_TOKEN  shared secret of the devices and the API
//   PORT          default 8080                      STATIC_DIR   built web app, default ../../app/dist
//   KUBUS_WEBHOOK_URL     URL(s), comma-separated, called with every change (docs/sync.md)
//   KUBUS_WEBHOOK_SECRET  signs each webhook request (X-Kubus-Signature)
//   KUBUS_SECRET_KEY      encrypts the secrets of its settings in the database (else plain text)
// The rest (the language model it offers, the sources it reads) is set in the app, Settings →
// Server, and stored in its database (server/src/settings.ts).

const databaseUrl = process.env.DATABASE_URL;
const token = process.env.KUBUS_TOKEN;
if (!databaseUrl || !token) {
  console.error("DATABASE_URL and KUBUS_TOKEN must be set");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 8080);
const settingsKey = secretKey(process.env.KUBUS_SECRET_KEY);
const staticDir = process.env.STATIC_DIR ?? join(import.meta.dirname, "../../app/dist");
/** A sync request's largest body (a first upload sends every row at once). */
const MAX_SYNC_BODY = 100 * 1024 * 1024;

const pool = createPool(databaseUrl);
const schemaSql = await loadSchema();
// Migrations, then the schema (server/src/migrations.ts). A database that can't be brought to it
// (migrated by a newer server, columns that don't fit) doesn't stop the server: sync answers with
// the error, and wiping the database (which doesn't depend on its tables) can still fix it.
let schemaError: string | null = null;
try {
  await applySchema(pool, schemaSql);
  broadcast(await currentCursor(pool)); // nobody listens yet: what the stored data is up to
} catch (e) {
  schemaError = `The server's database doesn't fit its schema: ${e instanceof Error ? e.message : String(e)}`;
  console.error(schemaError);
}

const digest = (s: string) => createHash("sha256").update(s).digest();
const expected = digest(token);
const authorized = (req: IncomingMessage) =>
  timingSafeEqual(digest((req.headers.authorization ?? "").replace(/^Bearer /, "")), expected);
/** What a request's token may do through the API (null: nothing). */
const accessOf = (req: IncomingMessage): Access | null => (authorized(req) ? "all" : null);

function send(res: ServerResponse, status: number, body: string, type = "application/json") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const fileId = (params: Record<string, string>) => {
  if (!FILE_ID.test(params.id)) throw new HttpError(404, "Not found");
  return params.id;
};

/** Refuses a request while the database doesn't fit the schema (only wiping can fix that). */
const fitting = () => {
  if (schemaError) throw new HttpError(500, schemaError);
};

const sources = new Sources();
// The server's own settings, applied at start and whenever a device changes them.
let settings: Stored = NO_SETTINGS;
async function applySettings(next: Stored) {
  settings = next;
  setAiSettings({ ...next.ai, key: usable(next.ai.key) });
  await sources.replace(sourceConfigs(next), (message) => console.log(message));
}
const settingsView = () => viewOf(settings, (name) => sources.status(name));

// The devices' endpoints (the token is checked before these run).
const routes = sources.routes(new Router())
  .add("POST", "/api/wipe", async (req) => {
    // Asked for in so many words, so no stray request can do it.
    if ((await readJson(req, 1024) as { confirm?: string } | undefined)?.confirm !== "wipe") return json(400, { error: "Not confirmed" });
    await wipe(pool, schemaSql);
    schemaError = null;
    broadcast(0);
    return json(200, { ok: true });
  })
  .add("POST", "/api/sync", async (req) => {
    fitting();
    const request = await readJson(req, MAX_SYNC_BODY);
    if (!request || typeof request !== "object") throw new HttpError(400, "Send a sync request");
    const result = await handleSync(pool, request as SyncRequest);
    if ("mismatch" in result) return json(409, result.mismatch);
    if ("outdated" in result) return json(426, result.outdated);
    const { wrote, ...response } = result;
    if (wrote) broadcast(response.cursor);
    return json(200, response);
  })
  .add("GET", "/api/settings", async () => {
    fitting();
    return json(200, settingsView());
  })
  .add("PUT", "/api/settings", async (req) => {
    fitting();
    const next = applyUpdate(settings, (await readJson(req, 256 * 1024)) as ServerSettingsUpdate);
    await saveSettings(pool, next, settingsKey);
    await applySettings(next);
    return json(200, settingsView());
  })
  .add("GET", "/api/ai", aiInfo)
  .add("GET", "/api/ai/models", (req) => aiProxy(req, "/models"))
  .add("POST", "/api/ai/chat/completions", (req) => aiProxy(req, "/chat/completions"))
  .add("HEAD", "/api/files/{id}", async (_req, params) => {
    fitting();
    return { status: (await hasFile(pool, fileId(params))) ? 200 : 404 };
  })
  .add("GET", "/api/files/{id}", async (_req, params) => {
    fitting();
    const file = await getFile(pool, fileId(params));
    if (!file) return json(404, { error: "No such file" });
    // Content-addressed: the bytes behind an id never change.
    return { status: 200, bytes: file.data, headers: { "Content-Type": file.mime, "Cache-Control": "private, max-age=31536000, immutable" } };
  })
  .add("PUT", "/api/files/{id}", async (req, params) => {
    fitting();
    const id = fileId(params);
    const mime = req.headers["content-type"] || "application/octet-stream";
    const data = Buffer.from(await req.body(MAX_FILE_BYTES));
    if (!(await putFile(pool, id, mime, data))) return json(400, { error: "The bytes don't match the file's id (SHA-256)" });
    return json(200, { ok: true });
  })
  .add("DELETE", "/api/files/{id}", async (_req, params) => {
    fitting();
    await deleteFile(pool, fileId(params));
    return json(200, { ok: true });
  });

const headless = new HeadlessHost();

// The HTTP API. A file's bytes come straight from here; everything else from the headless device.
const api = new Router()
  .add("GET", "/api/v1/files/{id}", (req, params) => routes.handle({ ...req, path: `/api/files/${params.id}` }))
  .add("HEAD", "/api/v1/files/{id}", (req, params) => routes.handle({ ...req, path: `/api/files/${params.id}` }));

/** The MCP endpoint: tools for an assistant, each a request to the HTTP API (server/src/mcp.ts). */
const MCP_PATH = "/api/v1/mcp";

async function handleApi(req: ApiRequest): Promise<ApiResponse> {
  fitting();
  if (api.has(req.path)) return api.handle(req);
  if (!headless.device) return json(503, { error: headless.problem });
  return headless.device.handle(req);
}

/** Writes a router's answer to the node:http response. */
function reply(res: ServerResponse, answer: ApiResponse, head: boolean) {
  const headers: Record<string, string> = { ...answer.headers };
  let body: Uint8Array | string | undefined;
  if (answer.bytes) body = answer.bytes;
  else if (answer.json !== undefined) {
    body = JSON.stringify(answer.json);
    headers["Content-Type"] ??= "application/json";
  }
  res.writeHead(answer.status, headers);
  res.end(head ? undefined : body);
}

const toApiRequest = (req: IncomingMessage, url: URL): ApiRequest => ({
  method: req.method ?? "GET",
  path: url.pathname,
  query: url.searchParams,
  headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v])),
  body: (limit) => readBody(req, limit),
});

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".wasm": "application/wasm", ".map": "application/json", ".woff2": "font/woff2", ".woff": "font/woff",
};

async function serveStatic(url: string, res: ServerResponse) {
  const path = normalize(decodeURIComponent(url.split("?")[0])).replace(/^([/\\])+/, "");
  if (path.includes("..")) return send(res, 400, "Bad request", "text/plain");
  // Not the app's: an MCP client looks for OAuth metadata there, which this server has none of.
  if (path.startsWith(".well-known/")) return send(res, 404, "Not found", "text/plain");
  // Unknown paths without an extension are app routes: the single-page app answers them.
  const file = path === "" || !extname(path) ? "index.html" : path;
  try {
    const data = await readFile(join(staticDir, file));
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      // Hashed build output never changes; everything else (index.html, sw.js, manifest) is revalidated.
      "Cache-Control": file.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    });
    res.end(data);
  } catch {
    send(res, 404, "Not found", "text/plain");
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
  try {
    if (req.method === "OPTIONS") return send(res, 204, "");
    if (url.pathname === "/api/health") return send(res, 200, '{"ok":true}');
    if (url.pathname === MCP_PATH) {
      const access = accessOf(req);
      if (!access) return send(res, 401, '{"error":"Wrong token"}');
      return reply(res, await handleMcp(toApiRequest(req, url), access, handleApi), false);
    }
    if (url.pathname.startsWith("/api/")) {
      if (!authorized(req)) return send(res, 401, '{"error":"Wrong token"}');
      if (url.pathname === "/api/events" && req.method === "GET") return handleEvents(req, res);
      const request = toApiRequest(req, url);
      const answer = url.pathname.startsWith("/api/v1/") ? await handleApi(request) : await routes.handle(request);
      return reply(res, answer, req.method === "HEAD");
    }
    if (req.method === "GET") return await serveStatic(req.url ?? "/", res);
    send(res, 405, "Method not allowed", "text/plain");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
}).listen(port, () => {
  console.log(`Kubus server on :${port}`);
  // Connecting to the sources can take a while: the server answers meanwhile.
  if (!schemaError) {
    loadSettings(pool, settingsKey)
      .then(async ({ stored, plainText }) => {
        for (const warning of secretWarnings(stored, settingsKey)) console.warn(warning);
        // Stored before there was a key: encrypted now.
        if (plainText && settingsKey) {
          await saveSettings(pool, stored, settingsKey).catch((e) => console.error("Encrypting the server's secrets failed", e));
        }
        await applySettings(stored);
      })
      .catch((e) => console.error("Loading the server's settings failed", e));
  }
  void headless.start({
    serverUrl: `http://127.0.0.1:${port}`,
    token,
    cursor: latestCursor,
    webhooks: {
      urls: (process.env.KUBUS_WEBHOOK_URL ?? "").split(",").map((u) => u.trim()).filter(Boolean),
      secret: process.env.KUBUS_WEBHOOK_SECRET || null,
    },
    log: (message) => console.log(`[api] ${message}`),
  });
});
