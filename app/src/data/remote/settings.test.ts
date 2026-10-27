// @vitest-environment node
// The server's settings: secrets are kept only where they were given for (server/src/settings.ts).
import { describe, expect, it } from "vitest";
import { applyUpdate, NO_SETTINGS, sourceConfigs, splitPassword, viewOf, type Stored } from "../../../../server/src/settings.ts";
import type { ServerSettingsUpdate } from "../../../../shared/settings";

const stored: Stored = {
  ai: { url: "https://api.example.com/v1", key: "sk-secret", fieldModel: "small", codeModel: "" },
  sources: [{ id: "s1", name: "CRM", url: "postgres://reader@crm:5432/crm", password: "pw", schemas: [], queries: true, timeoutSeconds: 30 }],
};
const update = (over: { ai?: Partial<ServerSettingsUpdate["ai"]>; source?: Partial<ServerSettingsUpdate["sources"][number]> } = {}): ServerSettingsUpdate => ({
  ai: { url: stored.ai.url, fieldModel: "small", codeModel: "", ...over.ai },
  sources: [{ id: "s1", name: "CRM", url: "postgres://reader@crm:5432/crm", schemas: [], queries: true, timeoutSeconds: 30, ...over.source }],
});

describe("server settings", () => {
  it("never show a secret", () => {
    const view = viewOf(stored, () => ({ connector: "postgres" }));
    expect(JSON.stringify(view)).not.toMatch(/sk-secret|"pw"/);
    expect(view.ai.keySet).toBe(true);
    expect(view.sources[0]).toMatchObject({ passwordSet: true, connector: "postgres" });
  });

  it("keep a secret left out while it goes to the same place", () => {
    const next = applyUpdate(stored, update({ source: { name: "Sales", schemas: ["public"] } }));
    expect(next.ai.key).toBe("sk-secret");
    expect(next.sources[0]).toMatchObject({ name: "Sales", password: "pw", schemas: ["public"] });
  });

  it("drop it when it would go somewhere else", () => {
    const next = applyUpdate(stored, update({ ai: { url: "https://evil.example/v1" }, source: { url: "postgres://reader@evil:5432/crm" } }));
    expect(next.ai.key).toBe("");
    expect(next.sources[0].password).toBe("");
    expect(applyUpdate(stored, update({ source: { url: "postgres://admin@crm:5432/crm" } })).sources[0].password).toBe("");
  });

  it("take a new one, from its input or the connection string, and clear one", () => {
    expect(applyUpdate(stored, update({ ai: { key: "sk-new" } })).ai.key).toBe("sk-new");
    expect(applyUpdate(stored, update({ ai: { key: "" } })).ai.key).toBe("");
    const inUrl = applyUpdate(stored, update({ source: { url: "postgres://reader:p%40ss@crm:5432/crm" } })).sources[0];
    expect(inUrl).toMatchObject({ url: "postgres://reader@crm:5432/crm", password: "p@ss" });
    expect(sourceConfigs({ ...NO_SETTINGS, sources: [inUrl] })[0].url).toBe("postgres://reader:p%40ss@crm:5432/crm");
  });

  it("refuse what can't be stored", () => {
    expect(() => applyUpdate(stored, update({ source: { name: "no spaces" } }))).toThrow(/letters, digits/);
    expect(() => applyUpdate(stored, update({ source: { url: "not a url" } }))).toThrow(/isn't a URL/);
    expect(() => applyUpdate(stored, { ...update(), sources: [...update().sources, { ...update().sources[0], id: "s2" }] })).toThrow(/Two sources/);
    expect(() => applyUpdate(stored, update({ ai: { url: "ftp://x" } }))).toThrow(/http/);
  });

  it("split a password out of a connection string", () => {
    expect(splitPassword("postgres://u:secret@h/db")).toEqual({ url: "postgres://u@h/db", password: "secret" });
  });
});
