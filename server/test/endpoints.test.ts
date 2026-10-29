// @vitest-environment node
// The error paths of the server's HTTP endpoints (src/index.ts): what a device or tool gets for a
// request that is wrong, too big, not allowed or for something that isn't there. The real server
// (./serve.ts) in a child process on a database of its own; ./http.test.ts has the working paths.
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_FILE_BYTES, SYNC_VERSION } from "../../shared/sync.ts";
import type { ApiTokenMade } from "../../shared/tokens.ts";
import { ADMIN, createDatabase, dropDatabase } from "./postgres.ts";
import { request, startServer, TOKEN, type RunningServer } from "./serve.ts";

const DB = "kubus_endpoints_test";
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

describe.skipIf(!ADMIN)("the server's HTTP error paths", () => {
  let server: RunningServer;
  let read: string;
  let write: string;

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const sync = (json: unknown) => request(server, "/api/sync", { method: "POST", json });
  const body = async (response: Response) => (await response.json()) as { error?: string };

  /** A request as sent, path and all (fetch would tidy a malformed one). */
  const raw = (path: string, method = "GET") =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = httpRequest(`${server.url}${path}`, { method, headers: as(TOKEN) }, (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.on("error", reject);
      req.end();
    });

  beforeAll(async () => {
    const staticDir = mkdtempSync(join(tmpdir(), "kubus-static-"));
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Kubus</title>");
    server = await startServer(await createDatabase(DB), { STATIC_DIR: staticDir });
    const made = async (access: string) => ((await (await request(server, "/api/tokens", { method: "POST", json: { name: access, access } })).json()) as ApiTokenMade).token;
    read = await made("read");
    write = await made("write");
  }, 30_000);
  afterAll(async () => {
    await server?.stop();
    await dropDatabase(DB);
  });

  describe("401, 403, 404 and 405", () => {
    it("answers 401 to every /api path and method without a right token", async () => {
      for (const [method, path] of [["GET", "/api/settings"], ["PUT", "/api/settings"], ["POST", "/api/sync"], ["POST", "/api/wipe"], ["GET", "/api/tokens"], ["HEAD", "/api/files/" + "a".repeat(64)],
        ["GET", "/api/ai"], ["POST", "/api/ai/chat/completions"], ["GET", "/api/sources"], ["GET", "/api/events"], ["GET", "/api/nothing"], ["POST", "/api/v1/mcp"], ["GET", "/api/v1/collections"]]) {
        for (const headers of [{} as Record<string, string>, { Authorization: "Bearer nope" }, { Authorization: "Basic abc" }, { Authorization: `Bearer ${TOKEN.toUpperCase()}` }]) {
          const response = await fetch(`${server.url}${path}`, { method, headers });
          expect([method, path, response.status]).toEqual([method, path, 401]);
        }
      }
      expect(await body(await fetch(`${server.url}/api/settings`))).toEqual({ error: "Wrong token" });
    });

    it("lets an API token reach only /api/v1, and says so with 403", async () => {
      for (const token of [read, write]) {
        for (const [method, path] of [["GET", "/api/settings"], ["POST", "/api/sync"], ["GET", "/api/events"], ["GET", "/api/tokens"], ["POST", "/api/tokens"], ["POST", "/api/wipe"], ["GET", "/api/ai"], ["GET", "/api/sources"], ["PUT", `/api/files/${"a".repeat(64)}`]]) {
          const response = await fetch(`${server.url}${path}`, { method, headers: as(token) });
          expect([token === read ? "read" : "write", method, path, response.status]).toEqual([token === read ? "read" : "write", method, path, 403]);
        }
      }
      expect((await body(await fetch(`${server.url}/api/settings`, { headers: as(write) }))).error).toMatch(/only the API/);
    });

    it("refuses a read token's writes with 403, before the endpoint sees them", async () => {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const response = await fetch(`${server.url}/api/v1/collections`, { method, headers: as(read) });
        expect([method, response.status]).toEqual([method, 403]);
      }
      const put = await fetch(`${server.url}/api/v1/files/${"a".repeat(64)}`, { method: "PUT", headers: as(read), body: "x" });
      expect(put.status).toBe(403);
      expect((await body(put)).error).toMatch(/only read/);
    });

    it("answers 404 for an unknown path under /api and 405 for a known one with another method", async () => {
      expect((await request(server, "/api/nothing")).status).toBe(404);
      expect((await request(server, "/api/sync/more", { method: "POST" })).status).toBe(404);
      expect(await body(await request(server, "/api/nothing"))).toEqual({ error: "Not found" });
      for (const [method, path] of [["GET", "/api/sync"], ["DELETE", "/api/settings"], ["GET", "/api/wipe"], ["POST", "/api/tokens/x"], ["POST", "/api/ai"], ["PUT", "/api/ai/models"],
        ["GET", "/api/ai/chat/completions"], ["POST", "/api/sources"], ["PATCH", `/api/files/${"a".repeat(64)}`]]) {
        const response = await request(server, path, { method });
        expect([method, path, response.status]).toEqual([method, path, 405]);
      }
    });

    it("lets a write token do what the API allows, but not write a file through it", async () => {
      expect((await fetch(`${server.url}/api/v1/files/${"a".repeat(64)}`, { method: "PUT", headers: as(write), body: "x" })).status).toBe(405);
      expect((await fetch(`${server.url}/api/v1/files/${"a".repeat(64)}`, { headers: as(read) })).status).toBe(404);
      expect((await fetch(`${server.url}/api/v1/files/${"a".repeat(64)}`, { method: "HEAD", headers: as(read) })).status).toBe(404);
    });

    it("answers a HEAD without a body", async () => {
      const response = await request(server, "/api/settings", { method: "HEAD" });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
    });

    it("answers CORS preflights to any path, without a token", async () => {
      for (const path of ["/api/files/x", "/api/v1/items", "/anything"]) {
        const response = await fetch(`${server.url}${path}`, { method: "OPTIONS" });
        expect([path, response.status]).toEqual([path, 204]);
        expect(response.headers.get("access-control-max-age")).toBe("7200");
        expect(response.headers.get("access-control-allow-methods")).toMatch(/DELETE/);
      }
      // And every answer carries the origin header, errors too.
      expect((await fetch(`${server.url}/api/settings`)).headers.get("access-control-allow-origin")).toBe("*");
    });

    it("answers its health check to any method, and nothing else without the token", async () => {
      expect((await fetch(`${server.url}/api/health`, { method: "POST" })).status).toBe(200);
      expect((await fetch(`${server.url}/api/healthy`)).status).toBe(401);
    });
  });

  describe("400 and 413", () => {
    it("refuses a sync request that isn't one", async () => {
      for (const bad of ["null", "5", '"text"', ""]) {
        const response = await request(server, "/api/sync", { method: "POST", body: bad, headers: { "Content-Type": "application/json" } });
        expect([bad, response.status]).toEqual([bad, 400]);
      }
      const invalid = await request(server, "/api/sync", { method: "POST", body: "{oops", headers: { "Content-Type": "application/json" } });
      expect(await body(invalid)).toEqual({ error: "The body isn't valid JSON" });
    });

    it("takes a sync request with no changes or cursor as an empty one", async () => {
      const response = await sync({ version: SYNC_VERSION, compatible: SYNC_VERSION });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ changes: {} });
    });

    it("answers 426 to a request without a version, and to a table it doesn't know", async () => {
      expect((await sync({ since: 0, changes: {} })).status).toBe(426);
      const unknown = await sync({ since: 0, version: SYNC_VERSION, compatible: SYNC_VERSION, changes: { nothing: [{ id: "x" }] } });
      expect(unknown.status).toBe(426);
      expect((await unknown.json()).update).toBe("server");
    });

    it("refuses a wipe that isn't confirmed in so many words", async () => {
      for (const bad of [{}, { confirm: "yes" }, { confirm: true }, { confirm: "WIPE" }, []]) {
        const response = await request(server, "/api/wipe", { method: "POST", json: bad });
        expect([JSON.stringify(bad), response.status]).toEqual([JSON.stringify(bad), 400]);
      }
      expect((await request(server, "/api/wipe", { method: "POST", body: "" })).status).toBe(400);
      expect((await request(server, "/api/wipe", { method: "POST", body: "{nope" })).status).toBe(400);
      expect((await request(server, "/api/wipe", { method: "POST", body: JSON.stringify({ confirm: "wipe", pad: "x".repeat(2000) }) })).status).toBe(413);
      // Nothing of that wiped it.
      expect((await (await sync({ since: 0, changes: {}, version: SYNC_VERSION, compatible: SYNC_VERSION })).json()).database.id).toBeTruthy();
    });

    it("refuses settings that aren't the settings as a whole", async () => {
      for (const bad of [undefined, {}, { ai: {} }, { sources: [] }, { ai: { url: "ftp://x" }, sources: [] }, { ai: {}, sources: [{ name: "bad/name", kind: "postgres" }] }, { ai: {}, sources: [{ name: "A", kind: "nothing" }] },
        { ai: {}, sources: [{ name: "A", kind: "postgres" }, { name: "a", kind: "postgres" }] }]) {
        const response = await request(server, "/api/settings", { method: "PUT", ...(bad === undefined ? {} : { json: bad }) });
        expect([JSON.stringify(bad), response.status]).toEqual([JSON.stringify(bad), 400]);
      }
      expect((await request(server, "/api/settings", { method: "PUT", body: "{nope" })).status).toBe(400);
      expect((await request(server, "/api/settings", { method: "PUT", body: " ".repeat(256 * 1024 + 1) })).status).toBe(413);
      expect((await (await request(server, "/api/settings")).json()).sources).toEqual([]);
    });

    it("refuses an API token without a name or access, and one with a body that is too big", async () => {
      expect((await request(server, "/api/tokens", { method: "POST", json: { name: "x" } })).status).toBe(400);
      expect((await request(server, "/api/tokens", { method: "POST", json: { access: "read" } })).status).toBe(400);
      expect((await request(server, "/api/tokens", { method: "POST", body: "x".repeat(5000) })).status).toBe(413);
    });

    it("answers 404 to a model request while it offers none, and 400 to a bad body for a source", async () => {
      expect((await request(server, "/api/ai")).status).toBe(200);
      expect(await (await request(server, "/api/ai")).json()).toEqual({ available: false, fieldModel: "", codeModel: "" });
      for (const [method, path] of [["GET", "/api/ai/models"], ["POST", "/api/ai/chat/completions"]]) {
        expect((await request(server, path, { method, ...(method === "POST" ? { json: {} } : {}) })).status).toBe(404);
      }
      expect((await request(server, "/api/sources")).status).toBe(200);
      expect((await request(server, "/api/sources/Nope/tables")).status).toBe(404);
      expect((await request(server, "/api/sources/Nope/query", { method: "POST", json: {} })).status).toBe(400);
    });
  });

  describe("files", () => {
    const id = (text: string) => sha256(new TextEncoder().encode(text));

    it("answers 404 for an id that isn't a SHA-256, for every method", async () => {
      for (const bad of ["x", "A".repeat(64), "a".repeat(63), "a".repeat(65), `${"a".repeat(63)}g`, "..%2f..%2fetc"]) {
        for (const method of ["HEAD", "GET", "PUT", "DELETE"]) {
          const response = await request(server, `/api/files/${bad}`, { method, ...(method === "PUT" ? { body: "x" } : {}) });
          expect([bad, method, response.status]).toEqual([bad, method, 404]);
        }
      }
    });

    it("answers 404 for a file it doesn't have, and lets a delete of it pass", async () => {
      const missing = id("never stored");
      expect(await body(await request(server, `/api/files/${missing}`))).toEqual({ error: "No such file" });
      expect((await request(server, `/api/files/${missing}`, { method: "HEAD" })).status).toBe(404);
      expect((await request(server, `/api/files/${missing}`, { method: "DELETE" })).status).toBe(200);
    });

    it("refuses bytes that don't match their id with 400, empty or cut off ones too, and stores nothing", async () => {
      const whole = "the whole picture";
      for (const bytes of ["", whole.slice(0, -1), `${whole}!`]) {
        const response = await request(server, `/api/files/${id(whole)}`, { method: "PUT", body: bytes });
        expect([bytes, response.status]).toEqual([bytes, 400]);
        expect((await body(response)).error).toMatch(/SHA-256/);
      }
      expect((await request(server, `/api/files/${id(whole)}`, { method: "HEAD" })).status).toBe(404);
    });

    it("stores a file sent without a type as binary", async () => {
      const bytes = "no type";
      const put = await fetch(`${server.url}/api/files/${id(bytes)}`, { method: "PUT", headers: as(TOKEN), body: new Blob([bytes]) });
      expect(put.status).toBe(200);
      expect((await request(server, `/api/files/${id(bytes)}`)).headers.get("content-type")).toMatch(/^(application\/octet-stream|)$/);
    });

    it("refuses a file over the limit with 413, and takes one at it", async () => {
      const big = new Uint8Array(MAX_FILE_BYTES + 1);
      const response = await request(server, `/api/files/${sha256(big)}`, { method: "PUT", body: big, headers: { "Content-Type": "application/octet-stream" } }).catch((e: unknown) => e);
      // The server may close the connection before the client has sent it all.
      if (response instanceof Response) expect(response.status).toBe(413);
      else expect(String((response as Error).cause ?? response)).toMatch(/ECONNRESET|EPIPE|terminated|other side closed/i);
      const exact = new Uint8Array(MAX_FILE_BYTES);
      expect((await request(server, `/api/files/${sha256(exact)}`, { method: "PUT", body: exact })).status).toBe(200);
      expect((await request(server, `/api/files/${sha256(exact)}`, { method: "DELETE" })).status).toBe(200);
    }, 30_000);
  });

  describe("the web app and malformed requests", () => {
    it("answers 404 to OAuth metadata, which an MCP client asks the app for", async () => {
      for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/api/v1/mcp"]) {
        expect((await fetch(`${server.url}${path}`)).status).toBe(404);
      }
    });

    it("answers 404 for a file with an extension it doesn't have, index.html for a path without one", async () => {
      expect((await fetch(`${server.url}/nothing.js`)).status).toBe(404);
      expect((await fetch(`${server.url}/a/b/c`)).status).toBe(200);
      expect((await fetch(`${server.url}/index.html`)).headers.get("content-type")).toBe("text/html; charset=utf-8");
    });

    it("never leaves its directory: a path that climbs is made plain, or refused with 400", async () => {
      // Resolved to /etc/passwd inside the app's directory: no such file, so the app answers.
      for (const path of ["/..%2f..%2fetc/passwd", "/%2e%2e%2f%2e%2e%2fetc/passwd"]) {
        const answer = await raw(path);
        expect([path, answer.status, answer.text]).toEqual([path, 200, "<!doctype html><title>Kubus</title>"]);
      }
      expect((await raw("/..%5c..%5cetc/passwd")).status).toBe(400);
      expect((await raw("/assets/..%5c..%5csecret.txt")).status).toBe(400);
    });

    it("refuses a malformed percent escape with 400, not 500", async () => {
      expect((await raw("/%E0%A4%A")).status).toBe(400);
      expect((await raw("/api/files/%E0%A4%A")).status).toBe(400);
      expect((await raw("/api/sources/%E0%A4%A/tables")).status).toBe(400);
    });

    it("answers other methods on the app's paths with 405", async () => {
      for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD"]) {
        expect([method, (await fetch(`${server.url}/`, { method })).status]).toEqual([method, 405]);
      }
    });

    it("keeps serving after a request that failed", async () => {
      expect((await fetch(`${server.url}/api/health`)).status).toBe(200);
    });
  });
});
