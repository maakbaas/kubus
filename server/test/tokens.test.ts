// @vitest-environment node
// API tokens (src/tokens.ts) against a real database (KUBUS_TEST_POSTGRES: ./postgres.ts).
import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "../../shared/router.ts";
import type { ApiTokenInfo, ApiTokenMade } from "../../shared/tokens.ts";
import { createPool } from "../src/db.ts";
import { loadSchema } from "../src/schema.ts";
import { allows, ApiTokens, READ_ONLY, TOKEN_PREFIX } from "../src/tokens.ts";
import { ADMIN, createDatabase, dropDatabase } from "./postgres.ts";
import { apiRequest } from "./request.ts";

const DB = "kubus_tokens_test";
const DEVICE = "device-token";

describe.skipIf(!ADMIN)("API tokens", () => {
  let pool: pg.Pool;
  let tokens: ApiTokens;
  let router: Router;

  beforeAll(async () => {
    pool = createPool(await createDatabase(DB));
    await pool.query(await loadSchema());
  });
  afterAll(async () => {
    await pool?.end();
    await dropDatabase(DB);
  });
  beforeEach(async () => {
    await pool.query("DELETE FROM api_tokens");
    tokens = new ApiTokens(pool, DEVICE);
    router = tokens.routes(new Router());
  });

  const bearer = (token: string) => `Bearer ${token}`;
  const lastUsed = async (id: string) => (await pool.query<{ at: string | null }>("SELECT last_used_at AS at FROM api_tokens WHERE id = $1", [id])).rows[0].at;
  const call = async (method: string, path: string, body?: unknown) => {
    const answer = await router.handle(apiRequest(method, path, body));
    return { status: answer.status, body: answer.json as never };
  };

  it("lets a read token only read, a write token anything", () => {
    expect(allows("read", "GET")).toBe(true);
    expect(allows("read", "HEAD")).toBe(true);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(allows("read", method)).toBe(false);
    for (const method of ["GET", "POST", "DELETE"]) expect(allows("write", method)).toBe(true);
    expect(allows("all", "DELETE")).toBe(true);
    expect(READ_ONLY).toMatch(/only read/);
  });

  it("knows the device's token as everything, and nothing else without a token", async () => {
    expect(await tokens.check(bearer(DEVICE))).toEqual({ access: "all" });
    expect(await tokens.check(undefined)).toBeNull();
    expect(await tokens.check("")).toBeNull();
    expect(await tokens.check("Bearer ")).toBeNull();
    expect(await tokens.check(bearer(`${DEVICE}x`))).toBeNull();
    expect(await tokens.check(bearer(DEVICE.slice(1)))).toBeNull();
    expect(await tokens.check(DEVICE)).toEqual({ access: "all" }); // the scheme is optional
  });

  it("makes a token, shown once, stored only as its SHA-256", async () => {
    const made = await tokens.make({ name: "  Scripts ", access: "write" });
    expect(made).toMatchObject({ name: "Scripts", access: "write", lastUsedAt: null });
    expect(made.token).toMatch(new RegExp(`^${TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`));
    const stored = (await pool.query("SELECT * FROM api_tokens")).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0].token_sha256).toBe(createHash("sha256").update(made.token).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(made.token);
    expect(new Date(made.createdAt).toISOString()).toBe(made.createdAt);
    expect((await tokens.make({ name: "Scripts", access: "write" })).token).not.toBe(made.token);
  });

  it("refuses a token without a usable name or access", async () => {
    const bad = [
      { name: "", access: "read" }, { name: "   ", access: "read" }, { name: "x".repeat(101), access: "read" },
      { name: 5, access: "read" }, { name: "A", access: "all" }, { name: "A", access: undefined }, { name: "A", access: "admin" },
    ];
    for (const request of bad) await expect(tokens.make(request as never)).rejects.toMatchObject({ status: 400 });
    expect((await tokens.make({ name: "x".repeat(100), access: "read" })).name).toHaveLength(100);
  });

  it("knows the tokens it made by their access, and no other kubus_ token", async () => {
    const read = await tokens.make({ name: "R", access: "read" });
    const write = await tokens.make({ name: "W", access: "write" });
    expect(await tokens.check(bearer(read.token))).toEqual({ access: "read" });
    expect(await tokens.check(bearer(write.token))).toEqual({ access: "write" });
    expect(await tokens.check(bearer(`${read.token}0`))).toBeNull();
    expect(await tokens.check(bearer(`${TOKEN_PREFIX}nothing`))).toBeNull();
    // Only the hash is looked up: the hash itself is no token.
    expect(await tokens.check(bearer(createHash("sha256").update(read.token).digest("hex")))).toBeNull();
  });

  it("notes a token's use, at most once a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const made = await tokens.make({ name: "R", access: "read" });
      await tokens.check(bearer(made.token));
      await vi.waitFor(async () => expect(await lastUsed(made.id)).not.toBeNull());
      await pool.query("UPDATE api_tokens SET last_used_at = NULL");
      vi.advanceTimersByTime(30_000);
      await tokens.check(bearer(made.token));
      await new Promise((r) => setTimeout(r, 50));
      expect(await lastUsed(made.id)).toBeNull(); // within the minute: not written again
      vi.advanceTimersByTime(31_000);
      await tokens.check(bearer(made.token));
      await vi.waitFor(async () => expect(await lastUsed(made.id)).not.toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists tokens oldest first, without the token", async () => {
    const a = await tokens.make({ name: "A", access: "read" });
    const b = await tokens.make({ name: "B", access: "write" });
    const listed = await tokens.list();
    expect(listed.map((t) => t.id)).toEqual([a.id, b.id]);
    expect(listed.every((t) => !("token" in t))).toBe(true);
  });

  it("revokes a token at once, and says when there was none", async () => {
    const made = await tokens.make({ name: "A", access: "write" });
    expect(await tokens.check(bearer(made.token))).toEqual({ access: "write" });
    expect(await tokens.revoke(made.id)).toBe(true);
    expect(await tokens.check(bearer(made.token))).toBeNull();
    expect(await tokens.revoke(made.id)).toBe(false);
  });

  it("is refused, not an error, while the database can't be read", async () => {
    const broken = new ApiTokens(new pg.Pool({ connectionString: "postgres://nobody:wrong@127.0.0.1:1/none" }), DEVICE);
    expect(await broken.check(bearer(`${TOKEN_PREFIX}anything`))).toBeNull();
    expect(await broken.check(bearer(DEVICE))).toEqual({ access: "all" });
  });

  it("serves the devices' endpoints", async () => {
    const made = await call("POST", "/api/tokens", { name: "Scripts", access: "read" });
    expect(made.status).toBe(201);
    const token = made.body as ApiTokenMade;
    expect(token.token).toMatch(/^kubus_/);

    const listed = await call("GET", "/api/tokens");
    expect(listed).toMatchObject({ status: 200 });
    expect((listed.body as ApiTokenInfo[]).map((t) => t.name)).toEqual(["Scripts"]);

    expect((await call("POST", "/api/tokens", { name: "", access: "read" })).status).toBe(400);
    expect((await call("POST", "/api/tokens")).status).toBe(400); // no body
    expect((await call("POST", "/api/tokens", "{not json")).status).toBe(400);
    expect((await call("POST", "/api/tokens", new Uint8Array(5000))).status).toBe(413);

    expect(await call("DELETE", `/api/tokens/${token.id}`)).toEqual({ status: 200, body: { ok: true } });
    expect((await call("DELETE", `/api/tokens/${token.id}`)).status).toBe(404);
    expect((await call("GET", "/api/tokens")).body).toEqual([]);
    expect((await call("PUT", "/api/tokens")).status).toBe(405);
  });
});
