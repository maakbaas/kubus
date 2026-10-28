import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { HttpError, json, readJson, type Router } from "../../shared/router.ts";
import type { ApiTokenAccess, ApiTokenInfo, ApiTokenMade, ApiTokenRequest } from "../../shared/tokens.ts";

// Who a request is: a device (KUBUS_TOKEN, everything) or an API token (shared/tokens.ts: only
// /api/v1 and the MCP endpoint, reading or also writing). API tokens are random (kubus_ + 32 bytes,
// base64url), stored as their SHA-256 in the server's own table api_tokens (schema.sql) and made,
// listed and revoked by devices at /api/tokens. A wipe drops them, like the server's settings.

/** "all": a device (KUBUS_TOKEN); else an API token's access. */
export type Access = "all" | ApiTokenAccess;

export const TOKEN_PREFIX = "kubus_";
/** Last used is written at most this often per token. */
const LAST_USED_MS = 60_000;
const MAX_NAME = 100;

const sha256 = (s: string) => createHash("sha256").update(s).digest();
const bearer = (header: string | undefined) => (header ?? "").replace(/^Bearer /, "");

/** Whether `access` may make a request with this method (a read token: GET and HEAD only). */
export const allows = (access: Access, method: string) => access !== "read" || method === "GET" || method === "HEAD";

/** The 403 answer's message for a read token's write. */
export const READ_ONLY = "This API token can only read (GET and HEAD): make one with read & write access in Settings → API tokens";

interface Row {
  id: string;
  name: string;
  access: ApiTokenAccess;
  /** ISO strings (server/src/db.ts). */
  created_at: string;
  last_used_at: string | null;
}

const infoOf = (r: Row): ApiTokenInfo => ({ id: r.id, name: r.name, access: r.access, createdAt: r.created_at, lastUsedAt: r.last_used_at });

export class ApiTokens {
  private pool: pg.Pool;
  private device: Buffer;
  /** When each token's last use was last written. */
  private written = new Map<string, number>();

  constructor(pool: pg.Pool, deviceToken: string) {
    this.pool = pool;
    this.device = sha256(deviceToken);
  }

  /**
   * Who an Authorization header ("Bearer <token>") is: "all" for KUBUS_TOKEN, the access of an API
   * token (its last use noted), null for anything else (also while the database can't be read).
   */
  async check(header: string | undefined): Promise<{ access: Access } | null> {
    const token = bearer(header);
    if (timingSafeEqual(sha256(token), this.device)) return { access: "all" };
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    try {
      const { rows } = await this.pool.query<{ id: string; access: ApiTokenAccess }>(
        "SELECT id, access FROM api_tokens WHERE token_sha256 = $1",
        [sha256(token).toString("hex")],
      );
      if (rows.length === 0) return null;
      this.used(rows[0].id);
      return { access: rows[0].access };
    } catch {
      return null;
    }
  }

  private used(id: string) {
    const at = Date.now();
    if (at - (this.written.get(id) ?? 0) < LAST_USED_MS) return;
    this.written.set(id, at);
    this.pool.query("UPDATE api_tokens SET last_used_at = now() WHERE id = $1", [id]).catch((e) => console.error("Noting an API token's use failed", e));
  }

  async list(): Promise<ApiTokenInfo[]> {
    const { rows } = await this.pool.query<Row>("SELECT id, name, access, created_at, last_used_at FROM api_tokens ORDER BY created_at, id");
    return rows.map(infoOf);
  }

  async make(request: ApiTokenRequest): Promise<ApiTokenMade> {
    const name = typeof request.name === "string" ? request.name.trim() : "";
    if (!name || name.length > MAX_NAME) throw new HttpError(400, `Give the token a name (at most ${MAX_NAME} characters)`);
    if (request.access !== "read" && request.access !== "write") throw new HttpError(400, 'Its access is "read" or "write"');
    const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const { rows } = await this.pool.query<Row>(
      "INSERT INTO api_tokens (id, name, access, token_sha256) VALUES ($1, $2, $3, $4) RETURNING id, name, access, created_at, last_used_at",
      [randomUUID(), name, request.access, sha256(token).toString("hex")],
    );
    return { ...infoOf(rows[0]), token };
  }

  /** Whether there was such a token. */
  async revoke(id: string): Promise<boolean> {
    this.written.delete(id);
    return ((await this.pool.query("DELETE FROM api_tokens WHERE id = $1", [id])).rowCount ?? 0) > 0;
  }

  /** The devices' endpoints: /api/tokens (list, make), /api/tokens/{id} (revoke). */
  routes(router: Router): Router {
    return router
      .add("GET", "/api/tokens", async () => json(200, await this.list()))
      .add("POST", "/api/tokens", async (req) => json(201, await this.make(((await readJson(req, 4096)) ?? {}) as ApiTokenRequest)))
      .add("DELETE", "/api/tokens/{id}", async (_req, { id }) => ((await this.revoke(id)) ? json(200, { ok: true }) : json(404, { error: "No such token" })));
  }
}
