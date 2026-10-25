// Language models, behind one small interface. Everything that asks a model (AI fields, writing a
// component) goes through `LlmClient`, and the one implementation speaks the OpenAI-style chat API
// that OpenAI, OpenRouter, Ollama, LM Studio and others share. So
// the provider is a base URL, a key and a model name in the settings, and a different API would be
// another implementation of the interface, not a change in its callers.
//
// Called straight from the browser (the app has no backend of its own), so the key lives on this
// device only (domain-free settings in localStorage, see app/ai.ts) and a provider must allow CORS.

export interface LlmSettings {
  /** The API's root, e.g. https://api.openai.com/v1 (the client adds /chat/completions and /models). */
  baseUrl: string;
  /** Sent as the bearer token; empty for providers without one (a local server). */
  apiKey: string;
  /** The provider's name for the model, e.g. deepseek/deepseek-chat. */
  model: string;
}

export const DEFAULT_LLM_SETTINGS: LlmSettings = { baseUrl: "", apiKey: "", model: "" };

export interface LlmMessage {
  role: "system" | "user";
  content: string;
}

export interface LlmClient {
  /** The model's reply to a conversation. */
  complete(messages: LlmMessage[], options?: { signal?: AbortSignal }): Promise<string>;
  /** The ids of the models the provider offers (empty when it doesn't say). */
  models(options?: { signal?: AbortSignal }): Promise<string[]>;
}

const root = (baseUrl: string) => baseUrl.trim().replace(/\/+$/, "");

async function failure(res: Response): Promise<Error> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { message?: string } | string; message?: string };
    detail = (typeof body.error === "string" ? body.error : body.error?.message) ?? body.message ?? "";
  } catch {
    /* not JSON */
  }
  return new Error(`${res.status}${res.statusText ? ` ${res.statusText}` : ""}${detail ? `: ${detail}` : ""}`);
}

/** The OpenAI-style chat API (`POST {baseUrl}/chat/completions`, `GET {baseUrl}/models`). */
export function createLlmClient(settings: LlmSettings): LlmClient {
  const base = root(settings.baseUrl);
  const headers = (json: boolean): Record<string, string> => ({
    ...(json && { "Content-Type": "application/json" }),
    ...(settings.apiKey && { Authorization: `Bearer ${settings.apiKey}` }),
  });
  const request = async (path: string, init: RequestInit): Promise<Response> => {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, init);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      throw new Error(`Could not reach ${base || "the provider"}. Check the address and your connection.`);
    }
    if (!res.ok) throw await failure(res);
    return res;
  };
  return {
    async complete(messages, options) {
      if (!base) throw new Error("No provider address is set.");
      if (!settings.model.trim()) throw new Error("No model is chosen.");
      const res = await request("/chat/completions", {
        method: "POST",
        headers: headers(true),
        body: JSON.stringify({ model: settings.model.trim(), messages }),
        signal: options?.signal,
      });
      const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[]; error?: { message?: string } };
      if (body.error?.message) throw new Error(body.error.message);
      const content = body.choices?.[0]?.message?.content;
      // Some providers answer with parts instead of a string.
      const text = Array.isArray(content) ? content.map((p: { text?: string }) => p?.text ?? "").join("") : typeof content === "string" ? content : "";
      if (!text.trim()) throw new Error("The model replied with nothing.");
      return text;
    },
    async models(options) {
      if (!base) return [];
      const res = await request("/models", { headers: headers(false), signal: options?.signal });
      const body = (await res.json()) as { data?: { id?: unknown }[] };
      return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string").sort();
    },
  };
}
