// @vitest-environment node
// The language model the server offers (src/ai.ts), against a stand-in for an OpenAI-style provider.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { aiInfo, aiProxy, setAiSettings } from "../src/ai.ts";
import { apiRequest } from "./request.ts";

describe("the server's language model", () => {
  let provider: Server;
  let base: string;
  let reply: { status: number; type?: string; body: string } = { status: 200, body: "{}" };
  let seen: { method?: string; path?: string; authorization?: string; type?: string; body: string }[] = [];

  beforeAll(async () => {
    provider = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        seen.push({ method: req.method, path: req.url, authorization: req.headers.authorization, type: req.headers["content-type"], body });
        res.writeHead(reply.status, reply.type === undefined ? {} : { "Content-Type": reply.type });
        res.end(reply.body);
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  });
  afterAll(() => {
    provider.close();
    provider.closeAllConnections();
  });
  beforeEach(() => {
    seen = [];
    reply = { status: 200, type: "application/json", body: '{"data":[]}' };
    setAiSettings({ url: `${base}/v1`, key: "sk-server", fieldModel: "small", codeModel: "big" });
  });

  const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

  it("says what it offers, never its address or key", async () => {
    expect(await aiInfo()).toEqual({ status: 200, json: { available: true, fieldModel: "small", codeModel: "big" } });
  });

  it("offers nothing without an address or without a model for AI fields", async () => {
    setAiSettings({ url: "", key: "k", fieldModel: "small", codeModel: "big" });
    expect((await aiInfo()).json).toMatchObject({ available: false });
    setAiSettings({ url: `${base}/v1`, key: "k", fieldModel: "", codeModel: "big" });
    expect((await aiInfo()).json).toMatchObject({ available: false, codeModel: "big" });
  });

  it("answers 404 to a request while it offers no model, without calling anyone", async () => {
    setAiSettings({ url: "", key: "", fieldModel: "", codeModel: "" });
    await expect(aiProxy(apiRequest("POST", "/api/ai/chat/completions", {}), "/chat/completions")).rejects.toMatchObject({ status: 404 });
    expect(seen).toEqual([]);
  });

  it("forwards a chat request with the server's key, and gives the provider's answer back as it is", async () => {
    reply = { status: 200, type: "application/json", body: '{"choices":[{"message":{"content":"42"}}]}' };
    const answer = await aiProxy(apiRequest("POST", "/api/ai/chat/completions", { model: "small", messages: [] }, { authorization: "Bearer device-token" }), "/chat/completions");
    expect(answer.status).toBe(200);
    expect(text(answer.bytes)).toBe(reply.body);
    expect(answer.headers).toEqual({ "Content-Type": "application/json" });
    // The device's own token never goes on; the server's key does.
    expect(seen).toEqual([{ method: "POST", path: "/v1/chat/completions", authorization: "Bearer sk-server", type: "application/json", body: '{"model":"small","messages":[]}' }]);
  });

  it("forwards a model list request without a body, and ignores trailing slashes in the address", async () => {
    setAiSettings({ url: `${base}/v1///`, key: "sk-server", fieldModel: "small", codeModel: "" });
    await aiProxy(apiRequest("GET", "/api/ai/models"), "/models");
    expect(seen).toEqual([{ method: "GET", path: "/v1/models", authorization: "Bearer sk-server", type: undefined, body: "" }]);
  });

  it("sends no Authorization when the provider needs no key", async () => {
    setAiSettings({ url: `${base}/v1`, key: "", fieldModel: "small", codeModel: "" });
    await aiProxy(apiRequest("POST", "/api/ai/chat/completions", {}), "/chat/completions");
    expect(seen[0].authorization).toBeUndefined();
  });

  it("passes the provider's errors and content type through", async () => {
    reply = { status: 429, type: "text/plain", body: "slow down" };
    const answer = await aiProxy(apiRequest("POST", "/api/ai/chat/completions", {}), "/chat/completions");
    expect(answer.status).toBe(429);
    expect(text(answer.bytes)).toBe("slow down");
    expect(answer.headers).toEqual({ "Content-Type": "text/plain" });
  });

  it("answers JSON when the provider names no type", async () => {
    reply = { status: 200, body: "{}" };
    expect((await aiProxy(apiRequest("GET", "/api/ai/models"), "/models")).headers).toEqual({ "Content-Type": "application/json" });
  });

  it("refuses a request body over 5 MB", async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    await expect(aiProxy(apiRequest("POST", "/api/ai/chat/completions", big), "/chat/completions")).rejects.toMatchObject({ status: 413 });
    expect(seen).toEqual([]);
  });

  it("answers 502 when it can't reach the provider", async () => {
    setAiSettings({ url: "http://127.0.0.1:1/v1", key: "k", fieldModel: "small", codeModel: "" });
    await expect(aiProxy(apiRequest("GET", "/api/ai/models"), "/models")).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/can't reach/) });
  });
});
