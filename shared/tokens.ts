// API tokens (Settings → Server in the app): made for other tools, each reaching only the HTTP API
// (/api/v1) and the server's MCP endpoint, to read or to read and write. Stored on the server only
// (its table api_tokens: the token's SHA-256, never the token), listed, made and revoked by devices
// (KUBUS_TOKEN) at /api/tokens. Types only, so the server runs it directly with Node (as shared/sync.ts).

/** "read": only GET / HEAD; "write": reads and writes. */
export type ApiTokenAccess = "read" | "write";

/** GET /api/tokens: one token, without the token itself. */
export interface ApiTokenInfo {
  id: string;
  name: string;
  access: ApiTokenAccess;
  /** ISO timestamps. */
  createdAt: string;
  /** Updated at most once a minute; null: never used. */
  lastUsedAt: string | null;
}

/** POST /api/tokens. */
export interface ApiTokenRequest {
  name: string;
  access: ApiTokenAccess;
}

/** POST /api/tokens' answer: the token, the only time it is shown. */
export interface ApiTokenMade extends ApiTokenInfo {
  token: string;
}
