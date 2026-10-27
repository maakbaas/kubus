import type { ServerAi } from "../../shared/api.ts";
import { HttpError, json, type ApiRequest, type ApiResponse } from "../../shared/router.ts";

// The language model the server offers every device (Settings → AI → "This server's" in the app):
// an OpenAI-style API set by environment variables. Devices don't get the key: they call
// /api/ai/... with KUBUS_TOKEN and the server forwards the request with KUBUS_AI_KEY.
//   KUBUS_AI_URL          the API's root, e.g. https://api.openai.com/v1
//   KUBUS_AI_KEY          its key (none for a local server)
//   KUBUS_AI_FIELD_MODEL  the model for AI fields
//   KUBUS_AI_CODE_MODEL   the model for writing components (default: the field model)

const MAX_BODY = 5 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

const url = (process.env.KUBUS_AI_URL ?? "").trim().replace(/\/+$/, "");
const key = (process.env.KUBUS_AI_KEY ?? "").trim();
const fieldModel = (process.env.KUBUS_AI_FIELD_MODEL ?? "").trim();
const codeModel = (process.env.KUBUS_AI_CODE_MODEL ?? "").trim();

export const serverAi: ServerAi = { available: url !== "" && fieldModel !== "", fieldModel, codeModel };

/** GET /api/ai: what the server offers (never its address or key). */
export const aiInfo = async (): Promise<ApiResponse> => json(200, serverAi);

/** Forwards a request to the provider (`path`: /chat/completions or /models) with the server's key. */
export async function aiProxy(req: ApiRequest, path: string): Promise<ApiResponse> {
  if (!serverAi.available) throw new HttpError(404, "This server offers no language model (KUBUS_AI_URL and KUBUS_AI_FIELD_MODEL aren't set)");
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
