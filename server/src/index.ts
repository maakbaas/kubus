import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { createPool } from "./db.ts";
import { broadcast, handleEvents } from "./events.ts";
import { handleSync } from "./sync.ts";
import { wipe } from "./wipe.ts";
import type { SyncRequest } from "../../shared/sync.ts";

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
const MAX_BODY = 100 * 1024 * 1024;

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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

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
  const url = req.url ?? "/";
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  try {
    if (req.method === "OPTIONS") return send(res, 204, "");
    if (url === "/api/health") return send(res, 200, '{"ok":true}');
    if (url.startsWith("/api/")) {
      if (!authorized(req)) return send(res, 401, '{"error":"Wrong token"}');
      if (url === "/api/events" && req.method === "GET") return handleEvents(req, res);
      if (url === "/api/wipe" && req.method === "POST") {
        // Asked for in so many words, so no stray request can do it.
        if ((JSON.parse(await readBody(req)) as { confirm?: string }).confirm !== "wipe") return send(res, 400, '{"error":"Not confirmed"}');
        await wipe(pool, schemaSql);
        schemaError = null;
        send(res, 200, '{"ok":true}');
        broadcast(0);
        return;
      }
      if (schemaError) return send(res, 500, JSON.stringify({ error: schemaError }));
      if (url === "/api/sync" && req.method === "POST") {
        const result = await handleSync(pool, JSON.parse(await readBody(req)) as SyncRequest);
        if ("mismatch" in result) return send(res, 409, JSON.stringify(result.mismatch));
        const { wrote, ...response } = result;
        send(res, 200, JSON.stringify(response));
        if (wrote) broadcast(response.cursor);
        return;
      }
      return send(res, 404, '{"error":"Not found"}');
    }
    if (req.method === "GET") return await serveStatic(url, res);
    send(res, 405, "Method not allowed", "text/plain");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
}).listen(Number(process.env.PORT ?? 8080), () => console.log(`Kubus server on :${process.env.PORT ?? 8080}`));
