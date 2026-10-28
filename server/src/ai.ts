import type { ServerAi } from "../../shared/api.ts";
import { HttpError, json, type ApiRequest, type ApiResponse } from "../../shared/router.ts";
import type { StoredAi } from "./settings.ts";

// The language model the server offers every device (Settings → AI → "This server's" in the app):
// an OpenAI-style API, set in the app's Settings → AI (server/src/settings.ts). Devices don't
// get the key: they call /api/ai/... with KUBUS_TOKEN and the server forwards the request with it.

const MAX_BODY = 5 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

let settings: StoredAi = { url: "", key: "", fieldModel: "", codeModel: "" };

/** Uses these settings from now on (at start, and when they are changed). */
export function setAiSettings(next: StoredAi) {
  settings = { ...next, url: next.url.replace(/\/+$/, "") };
}

const offer = (): ServerAi => ({ available: settings.url !== "" && settings.fieldModel !== "", fieldModel: settings.fieldModel, codeModel: settings.codeModel });

/** GET /api/ai: what the server offers (never its address or key). */
export const aiInfo = async (): Promise<ApiResponse> => json(200, offer());

/** Forwards a request to the provider (`path`: /chat/completions or /models) with the server's key. */
export async function aiProxy(req: ApiRequest, path: string): Promise<ApiResponse> {
  if (!offer().available) throw new HttpError(404, "This server offers no language model (set one in Settings → AI)");
  const { url, key } = settings;
  const body = req.method === "POST" ? await req.body(MAX_BODY) : undefined;
  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      method: req.method,
      headers: {
        ...(body && { "Content-Type": "application/json" }),
        ...(key && { Authorization: `Bearer ${key}` }),
      },
      body: body as Uint8Array<ArrayBuffer> | undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(502, "The server can't reach its language model");
  }
  return {
    status: response.status,
    bytes: new Uint8Array(await response.arrayBuffer()),
    headers: { "Content-Type": response.headers.get("Content-Type") ?? "application/json" },
  };
}
