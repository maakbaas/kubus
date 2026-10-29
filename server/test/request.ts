// An ApiRequest (shared/router.ts) without node:http, for the tests of modules that answer one.
import { HttpError, type ApiRequest } from "../../shared/router.ts";

export function apiRequest(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): ApiRequest {
  const bytes = body === undefined ? new Uint8Array() : body instanceof Uint8Array ? body : new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
  const [pathname, query = ""] = path.split("?");
  return {
    method,
    path: pathname,
    query: new URLSearchParams(query),
    headers,
    // As the server's readBody: refused beyond the limit.
    async body(limit) {
      if (bytes.byteLength > limit) throw new HttpError(413, "Request too large");
      return bytes;
    },
  };
}
