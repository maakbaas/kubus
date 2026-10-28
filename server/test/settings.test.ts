// @vitest-environment node
// The server's settings: secrets are kept only where they were given for (server/src/settings.ts),
// sources stored by their kind's fields (server/src/connectors/kinds.ts).
import { describe, expect, it } from "vitest";
import { applyUpdate, NO_SETTINGS, sourceConfigs, viewOf, type Stored } from "../src/settings.ts";
import type { ServerSettingsUpdate } from "../../shared/settings.ts";

const crm = { host: "crm", port: "5432", database: "crm", user: "reader", ssl: "" };
const stored: Stored = {
  ai: { url: "https://api.example.com/v1", key: "sk-secret", fieldModel: "small", codeModel: "" },
  sources: [{ id: "s1", name: "CRM", kind: "postgres", fields: crm, password: "pw", schemas: [], queries: true, timeoutSeconds: 30 }],
};
const update = (over: { ai?: Partial<ServerSettingsUpdate["ai"]>; source?: Partial<ServerSettingsUpdate["sources"][number]> } = {}): ServerSettingsUpdate => ({
  ai: { url: stored.ai.url, fieldModel: "small", codeModel: "", ...over.ai },
  sources: [{ id: "s1", name: "CRM", kind: "postgres", fields: crm, schemas: [], queries: true, timeoutSeconds: 30, ...over.source }],
});

describe("server settings", () => {
  it("never show a secret", () => {
    const view = viewOf(stored, () => ({ connector: "postgres" }));
    expect(JSON.stringify(view)).not.toMatch(/sk-secret|"pw"/);
    expect(view.ai.keySet).toBe(true);
    expect(view.sources[0]).toMatchObject({ passwordSet: true, connector: "postgres", kind: "postgres", fields: crm });
  });

  it("show the kinds the server reads, with their fields", () => {
    const { kinds } = viewOf(stored, () => ({}));
    expect(kinds.map((k) => k.id)).toEqual(["postgres", "n8n", "influxdb", "d1"]);
    expect(kinds[0].fields.map((f) => f.key)).toEqual(["host", "port", "database", "user", "ssl"]);
    expect(kinds.find((k) => k.id === "d1")?.schemas).toBeNull();
  });

  it("keep a secret left out while it goes to the same place", () => {
    const next = applyUpdate(stored, update({ source: { name: "Sales", schemas: ["public"], fields: { ...crm, database: "sales" } } }));
    expect(next.ai.key).toBe("sk-secret");
    expect(next.sources[0]).toMatchObject({ name: "Sales", password: "pw", schemas: ["public"], fields: { database: "sales" } });
  });

  it("drop it when it would go somewhere else", () => {
    const next = applyUpdate(stored, update({ ai: { url: "https://evil.example/v1" }, source: { fields: { ...crm, host: "evil" } } }));
    expect(next.ai.key).toBe("");
    expect(next.sources[0].password).toBe("");
    expect(applyUpdate(stored, update({ source: { fields: { ...crm, user: "admin" } } })).sources[0].password).toBe("");
    expect(applyUpdate(stored, update({ source: { fields: { ...crm, port: "6543" } } })).sources[0].password).toBe("");
    expect(applyUpdate(stored, update({ source: { kind: "n8n", fields: { address: "crm" } } })).sources[0].password).toBe("");
  });

  it("take a new one and clear one", () => {
    expect(applyUpdate(stored, update({ ai: { key: "sk-new" } })).ai.key).toBe("sk-new");
    expect(applyUpdate(stored, update({ ai: { key: "" } })).ai.key).toBe("");
    const next = applyUpdate(stored, update({ source: { password: "p@ss" } })).sources[0];
    expect(next.password).toBe("p@ss");
    expect(sourceConfigs({ ...NO_SETTINGS, sources: [next] })[0]).toMatchObject({ kind: "postgres", fields: crm, password: "p@ss", timeoutMs: 30_000 });
    expect(applyUpdate(stored, update({ source: { password: "" } })).sources[0].password).toBe("");
  });

  it("store only a kind's own fields, trimmed, each of them", () => {
    const next = applyUpdate(stored, update({ source: { kind: "d1", fields: { account: " acc ", other: "x" } } })).sources[0];
    expect(next.fields).toEqual({ account: "acc", database: "" });
  });

  it("refuse what can't be stored", () => {
    expect(() => applyUpdate(stored, update({ source: { name: "no spaces" } }))).toThrow(/letters, digits/);
    expect(() => applyUpdate(stored, update({ source: { kind: "oracle" } }))).toThrow(/kind “oracle”/);
    expect(() => applyUpdate(stored, { ...update(), sources: [...update().sources, { ...update().sources[0], id: "s2" }] })).toThrow(/Two sources/);
    expect(() => applyUpdate(stored, update({ ai: { url: "ftp://x" } }))).toThrow(/http/);
  });
});
