// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
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
