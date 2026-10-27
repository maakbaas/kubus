// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { device, FakeServer, TOKEN } from "../test/fakeServer";
import { AiService } from "./ai";

let server: FakeServer;
beforeEach(() => {
  server = new FakeServer().install();
});

/** Lets the look at the server's offer finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("the server's language model", () => {
  it("is used by a device without its own, through the server with the sync token", async () => {
    server.ai = { available: true, fieldModel: "small", codeModel: "" };
    const ai = new AiService(await device());
    await settle();
    expect(ai.settings.source).toBe("server");
    expect(ai.configured).toBe(true);
    expect(ai.modelFor("code")).toBe("small");
    expect(await ai.client("field").complete([{ role: "user", content: "?" }])).toBe("42");
    expect(server.aiRequests).toEqual([{ model: "small", authorization: `Bearer ${TOKEN}` }]);
  });

  it("says why there is none, and the device's own model takes over when chosen", async () => {
    const ai = new AiService(await device());
    await settle();
    expect(ai.configured).toBe(false);
    expect(ai.serverOffer.problem).toMatch(/offers no language model/);
    ai.setSettings({ ...ai.settings, source: "own", baseUrl: "https://llm.test/v1", apiKey: "k", fieldModel: "mine" });
    expect(ai.configured).toBe(true);
    expect(ai.providerOf(ai.settings)).toMatchObject({ baseUrl: "https://llm.test/v1", apiKey: "k", fieldModel: "mine" });
  });

  it("needs a server to be set up", async () => {
    const ai = new AiService(await device({ connect: false }));
    await settle();
    expect(ai.serverOffer.problem).toMatch(/No server/);
    expect(ai.configured).toBe(false);
  });
});

describe("settings saved by an earlier version", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stored = (value: unknown) => {
    const items = new Map([["kubus.ai", JSON.stringify(value)]]);
    vi.stubGlobal("localStorage", { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => items.set(k, v), removeItem: (k: string) => items.delete(k) });
  };

  it("keep the device's own model when they name one (from before the server offered one)", async () => {
    stored({ baseUrl: "https://llm.test/v1", apiKey: "k", fieldModel: "mine", codeModel: "", paused: false });
    const ai = new AiService(await device({ connect: false }));
    expect(ai.settings.source).toBe("own");
    expect(ai.configured).toBe(true);
  });

  it("use the server's when they name none", async () => {
    stored({ paused: true });
    expect(new AiService(await device({ connect: false })).settings).toMatchObject({ source: "server", paused: true });
  });
});
