import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { createPool } from "./db.ts";
import { broadcast, handleEvents } from "./events.ts";
import { getFile, hasFile, putFile } from "./files.ts";
import { FILE_ID } from "../../shared/files.ts";
import { handleSync } from "./sync.ts";
import { wipe } from "./wipe.ts";
import { MAX_FILE_BYTES, type SyncRequest } from "../../shared/sync.ts";
import { HttpError, json, Router, type ApiRequest, type ApiResponse } from "../../shared/router.ts";

// Kubus server: the sync API (/api) and, from the same origin, the web app (so a phone can
// install it as a home-screen app). Configuration is environment only:
//   DATABASE_URL  Postgres connection string        KUBUS_TOKEN  shared secret of the devices
//   PORT          default 8080                      STATIC_DIR   built web app, default ../../app/dist

const databaseUrl = process.env.DATABASE_URL;
const token = process.env.KUBUS_TOKEN;
if (!databaseUrl || !token) {
  console.error("DATABASE_URL and KUBUS_TOKEN must be set");
  process.exit(1);
}
const staticDir = process.env.STATIC_DIR ?? join(import.meta.dirname, "../../app/dist");
/** A sync request's largest body (an app from before /api/files sends files' bytes in it). */
const MAX_SYNC_BODY = 100 * 1024 * 1024;

const pool = createPool(databaseUrl);
const schemaSql = await readFile(join(import.meta.dirname, "../schema.sql"), "utf8");
// A database whose tables don't fit the schema doesn't stop the server: sync answers with the
// error, and wiping the database (which doesn't depend on its tables) can still fix it.
let schemaError: string | null = null;
try {
  await pool.query(schemaSql);
} catch (e) {
  schemaError = `The server's database doesn't fit its schema: ${e instanceof Error ? e.message : String(e)}`;
  console.error(schemaError);
}

const digest = (s: string) => createHash("sha256").update(s).digest();
const expected = digest(token);
const authorized = (req: IncomingMessage) =>
  timingSafeEqual(digest((req.headers.authorization ?? "").replace(/^Bearer /, "")), expected);

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

const readJson = async (req: ApiRequest, limit = 1024 * 1024): Promise<unknown> => {
  try {
    return JSON.parse(Buffer.from(await req.body(limit)).toString("utf8"));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "The body isn't valid JSON");
  }
};

const fileId = (params: Record<string, string>) => {
  if (!FILE_ID.test(params.id)) throw new HttpError(404, "Not found");
  return params.id;
};

/** Refuses a request while the database doesn't fit the schema (only wiping can fix that). */
const fitting = () => {
  if (schemaError) throw new HttpError(500, schemaError);
};

// The devices' endpoints (the token is checked before these run).
const routes = new Router()
  .add("POST", "/api/wipe", async (req) => {
    // Asked for in so many words, so no stray request can do it.
    if ((await readJson(req) as { confirm?: string }).confirm !== "wipe") return json(400, { error: "Not confirmed" });
    await wipe(pool, schemaSql);
    schemaError = null;
    broadcast(0);
    return json(200, { ok: true });
  })
  .add("POST", "/api/sync", async (req) => {
    fitting();
    const result = await handleSync(pool, (await readJson(req, MAX_SYNC_BODY)) as SyncRequest);
    if ("mismatch" in result) return json(409, result.mismatch);
    const { wrote, ...response } = result;
    if (wrote) broadcast(response.cursor);
    return json(200, response);
  })
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
  });

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
    if (url.pathname.startsWith("/api/")) {
      if (!authorized(req)) return send(res, 401, '{"error":"Wrong token"}');
      if (url.pathname === "/api/events" && req.method === "GET") return handleEvents(req, res);
      return reply(res, await routes.handle(toApiRequest(req, url)), req.method === "HEAD");
    }
    if (req.method === "GET") return await serveStatic(req.url ?? "/", res);
    send(res, 405, "Method not allowed", "text/plain");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
}).listen(Number(process.env.PORT ?? 8080), () => console.log(`Kubus server on :${process.env.PORT ?? 8080}`));
