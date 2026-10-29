// A stand-in for Cloudflare's D1 HTTP API (POST /accounts/{account}/d1/database/{database}/raw), which cannot run
// locally: D1 is Cloudflare's, and wrangler / miniflare run D1 inside the Workers runtime, not behind this REST API.
// The statements run on a real SQLite (node:sqlite), as D1's do, and the answers follow Cloudflare's documented ones:
// the envelope `{ result, success, errors, messages }`, a result per statement with `meta` (changed_db, changes,
// duration, last_row_id, rows_read, rows_written, size_after, served_by_*) and `results` as `{ columns, rows }` (rows as arrays,
// a blob as an array of bytes), D1's errors (400 with code 7500 and SQLite's message plus ": SQLITE_ERROR"; 401 for a token
// Cloudflare doesn't know, 400 for an Authorization header that isn't one, 404 for a database it can't route to) and D1's
// limits (100 bound parameters, 100 KB of SQL).
import type { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";

export const ACCOUNT = "acc";
export const DATABASE = "db-1";
export const TOKEN = "token-1";
const API = "https://api.cloudflare.com/client/v4";

/** D1's limits (developers.cloudflare.com/d1/platform/limits). */
const MAX_PARAMS = 100;
const MAX_SQL_BYTES = 100_000;

export interface D1Request {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  sql: string;
  params: unknown[];
}

export interface D1Stub {
  requests: D1Request[];
  /** An answer instead of running the statement (Cloudflare's own errors); null to run it. */
  override: ((sql: string) => Response | null) | null;
}

const envelope = (over: object) => ({ result: null, success: false, errors: [], messages: [], ...over });
const failure = (status: number, errors: { code: number; message: string }[]) => Response.json(envelope({ errors }), { status });

/** Installs the stand-in as `fetch`, answering for `db`; `vi.unstubAllGlobals()` removes it. */
export function stubD1(db: DatabaseSync, options: { account?: string; database?: string; token?: string } = {}): D1Stub {
  const { account = ACCOUNT, database = DATABASE, token = TOKEN } = options;
  const stub: D1Stub = { requests: [], override: null };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const body = JSON.parse(String(init.body ?? "{}")) as { sql?: string; params?: (string | number | null)[] };
    stub.requests.push({ url, method: init.method ?? "GET", authorization: headers.get("authorization"), contentType: headers.get("content-type"), sql: body.sql ?? "", params: body.params ?? [] });
    const authorization = headers.get("authorization") ?? "";
    if (!/^Bearer \S+$/.test(authorization)) {
      return failure(400, [
        { code: 6003, message: "Invalid request headers" },
        { code: 6111, message: "Invalid format for Authorization header" },
      ]);
    }
    if (authorization !== `Bearer ${token}`) return failure(401, [{ code: 9109, message: "Invalid access token" }]);
    if (url !== `${API}/accounts/${account}/d1/database/${database}/raw`) {
      return failure(404, [{ code: 7003, message: `Could not route to ${new URL(url).pathname}, perhaps your object identifier is invalid?` }]);
    }
    const { sql = "", params = [] } = body;
    if (stub.override) {
      const answer = stub.override(sql);
      if (answer) return answer;
    }
    if (!sql.trim()) return failure(400, [{ code: 7400, message: "No SQL statements detected." }]);
    if (new TextEncoder().encode(sql).length > MAX_SQL_BYTES) return failure(400, [{ code: 7500, message: "statement too long: SQLITE_TOOBIG" }]);
    if (params.length > MAX_PARAMS) return failure(400, [{ code: 7500, message: `too many SQL variables at offset ${sql.length}: SQLITE_ERROR` }]);
    const started = performance.now();
    try {
      const statement = db.prepare(sql);
      statement.setReturnArrays(true);
      const named = Object.fromEntries(params.map((v, i) => [`?${i + 1}`, v]));
      const columns = statement.columns().map((c) => c.name);
      let rows: unknown[][] = [];
      let changes = 0;
      if (columns.length === 0) changes = Number(statement.run(named).changes);
      else rows = (statement.all(named) as unknown as unknown[][]).map((r) => r.map((v) => (v instanceof Uint8Array ? [...v] : typeof v === "bigint" ? Number(v) : v)));
      const duration = performance.now() - started;
      return Response.json(
        envelope({
          success: true,
          result: [
            {
              success: true,
              meta: {
                served_by: "v3-prod",
                served_by_region: "WEUR",
                served_by_primary: true,
                timings: { sql_duration_ms: duration },
                duration,
                changes,
                last_row_id: 0,
                changed_db: changes > 0,
                size_after: 8192,
                rows_read: rows.length,
                rows_written: changes,
              },
              results: { columns, rows },
            },
          ],
        }),
      );
    } catch (e) {
      return failure(400, [{ code: 7500, message: `${(e as Error).message}: SQLITE_ERROR` }]);
    }
  });
  return stub;
}
