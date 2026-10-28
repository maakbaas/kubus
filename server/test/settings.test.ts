// @vitest-environment node
// The server's settings: secrets are kept only where they were given for (server/src/settings.ts),
// sources stored by their kind's fields (server/src/connectors/kinds.ts).
import { describe, expect, it } from "vitest";
import {
  applyUpdate, loadSettings, NO_SETTINGS, saveSettings, secretKey, secretWarnings, sourceConfigs, viewOf, type Stored,
} from "../src/settings.ts";
import type { ServerSettingsUpdate } from "../../shared/settings.ts";

const crm = { host: "crm", port: "5432", database: "crm", user: "reader", ssl: "" };
const stored: Stored = {
  ai: { url: "https://api.example.com/v1", key: "sk-secret", fieldModel: "small", codeModel: "" },
  sources: [{ id: "s1", name: "CRM", formerNames: [], kind: "postgres", fields: crm, password: "pw", secrets: {}, schemas: [], timeoutSeconds: 30 }],
};
const update = (over: { ai?: Partial<ServerSettingsUpdate["ai"]>; source?: Partial<ServerSettingsUpdate["sources"][number]> } = {}): ServerSettingsUpdate => ({
  ai: { url: stored.ai.url, fieldModel: "small", codeModel: "", ...over.ai },
  sources: [{ id: "s1", name: "CRM", kind: "postgres", fields: crm, schemas: [], timeoutSeconds: 30, ...over.source }],
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
    expect(kinds.map((k) => k.id)).toEqual(["postgres", "n8n", "influxdb", "d1", "mysql", "mariadb", "actual", "ics", "json", "csv"]);
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
    expect(() => applyUpdate(stored, update({ source: { name: "no/slashes" } }))).toThrow(/letters, digits/);
    expect(() => applyUpdate(stored, update({ source: { name: "two  spaces" } }))).toThrow(/letters, digits/);
    expect(() => applyUpdate(stored, update({ source: { kind: "oracle" } }))).toThrow(/kind “oracle”/);
    expect(() => applyUpdate(stored, { ...update(), sources: [...update().sources, { ...update().sources[0], id: "s2" }] })).toThrow(/Two sources/);
    expect(() => applyUpdate(stored, update({ ai: { url: "ftp://x" } }))).toThrow(/http/);
  });

  it("keep a renamed source's former names (names with spaces too), and pass them to its connector", () => {
    const renamed = applyUpdate(stored, update({ source: { name: "Sales CRM" } }));
    expect(renamed.sources[0]).toMatchObject({ name: "Sales CRM", formerNames: ["CRM"] });
    const again = applyUpdate(renamed, update({ source: { name: "Sales" } }));
    expect(again.sources[0].formerNames).toEqual(["CRM", "Sales CRM"]);
    expect(sourceConfigs(again)[0].formerNames).toEqual(["CRM", "Sales CRM"]);
    // A name another source takes up again is that one's; never shown to devices in the settings.
    const back = applyUpdate(again, update({ source: { name: "CRM" } }));
    expect(back.sources[0].formerNames).toEqual(["Sales CRM", "Sales"]);
    expect(JSON.stringify(viewOf(back, () => ({})))).not.toMatch(/formerNames/);
  });

  describe("secret fields (a budget's encryption password)", () => {
    const actual = { address: "https://actual.example.com", budget: "b1" };
    const encryption = "s3cr3t";
    const budget = (over: Partial<ServerSettingsUpdate["sources"][number]> = {}) =>
      update({ source: { kind: "actual", fields: actual, secrets: { encryption }, password: "pw", ...over } });
    const first = applyUpdate(stored, budget());

    it("are stored apart from the fields, given to the connector, and never shown", () => {
      expect(first.sources[0]).toMatchObject({ fields: actual, secrets: { encryption } });
      expect(sourceConfigs(first)[0].fields).toEqual({ ...actual, encryption });
      const view = viewOf(first, () => ({}));
      expect(JSON.stringify(view)).not.toMatch(/s3cr3t/);
      expect(view.sources[0].secretsSet).toEqual(["encryption"]);
      // Typed in the fields instead, a secret one isn't taken.
      expect(applyUpdate(stored, update({ source: { kind: "actual", fields: { ...actual, encryption } } })).sources[0]).toMatchObject({ fields: actual, secrets: {} });
    });

    it("are kept while left out, with the password", () => {
      const kept = applyUpdate(first, update({ source: { kind: "actual", fields: actual, name: "Budget" } })).sources[0];
      expect(kept).toMatchObject({ secrets: { encryption }, password: "pw" });
    });

    it("are dropped with the password when the place changes, and cleared by an empty one", () => {
      const moved = applyUpdate(first, update({ source: { kind: "actual", fields: { ...actual, address: "https://evil.example" } } })).sources[0];
      expect(moved).toMatchObject({ secrets: {}, password: "" });
      expect(applyUpdate(first, update({ source: { kind: "actual", fields: actual, secrets: { encryption: "" } } })).sources[0].secrets).toEqual({});
      expect(applyUpdate(first, update({ source: { kind: "json", fields: {} } })).sources[0]).toMatchObject({ secrets: {}, password: "" });
    });

    it("are encrypted with the key like the password", async () => {
      const rows = new Map<string, unknown>();
      const db = {
        async query<R>(sql: string, values: unknown[] = []) {
          if (sql.startsWith("INSERT")) {
            rows.set("ai", JSON.parse(values[0] as string));
            rows.set("sources", JSON.parse(values[1] as string));
          }
          return { rows: [...rows].map(([key, value]) => ({ key, value })) as R[] };
        },
      };
      const key = secretKey("a long random string");
      await saveSettings(db, first, key);
      expect(JSON.stringify([...rows.values()])).not.toMatch(/s3cr3t/);
      expect((await loadSettings(db, key)).stored).toEqual(first);
      const unopened = (await loadSettings(db, null)).stored;
      expect(viewOf(unopened, () => ({})).sources[0].secretsSet).toEqual([]);
      expect(secretWarnings(unopened, null).join()).toMatch(/encryption/);
    });
  });

  describe("stored with KUBUS_SECRET_KEY", () => {
    /** A server_settings table in memory: what saveSettings writes, loadSettings reads. */
    const table = () => {
      const rows = new Map<string, unknown>();
      return {
        rows,
        async query<R>(sql: string, values: unknown[] = []) {
          if (sql.startsWith("INSERT")) {
            rows.set("ai", JSON.parse(values[0] as string));
            rows.set("sources", JSON.parse(values[1] as string));
          }
          return { rows: [...rows].map(([key, value]) => ({ key, value })) as R[] };
        },
      };
    };
    const key = secretKey("a long random string");
    const raw = (db: ReturnType<typeof table>) => JSON.stringify([...db.rows.values()]);

    it("encrypt the secrets, and read them back with the key", async () => {
      const db = table();
      await saveSettings(db, stored, key);
      expect(raw(db)).not.toMatch(/sk-secret|"pw"/);
      expect(raw(db)).toContain("\"user\":\"reader\"");
      expect(await loadSettings(db, key)).toEqual({ stored, plainText: false });
      const long = { ...stored, ai: { ...stored.ai, key: "k".repeat(2000) } };
      await saveSettings(db, long, key);
      expect((await loadSettings(db, key)).stored.ai.key).toBe(long.ai.key);
      expect(secretWarnings(stored, key)).toEqual([]);
    });

    it("store them as plain text without a key, and encrypt them once there is one", async () => {
      const db = table();
      await saveSettings(db, stored, null);
      expect(raw(db)).toMatch(/sk-secret/);
      expect(secretWarnings((await loadSettings(db, null)).stored, null)[0]).toMatch(/plain text/);
      const loaded = await loadSettings(db, key);
      expect(loaded).toEqual({ stored, plainText: true });
      await saveSettings(db, loaded.stored, key);
      expect(raw(db)).not.toMatch(/sk-secret/);
      expect((await loadSettings(db, key)).plainText).toBe(false);
    });

    it("keep one another key (or no key) can't open, unused, until the right key is back", async () => {
      const db = table();
      await saveSettings(db, stored, key);
      for (const other of [null, secretKey("another key")]) {
        const { stored: loaded, plainText } = await loadSettings(db, other);
        expect(plainText).toBe(false);
        expect(viewOf(loaded, () => ({}))).toMatchObject({ ai: { keySet: false }, sources: [{ passwordSet: false }] });
        expect(sourceConfigs(loaded)[0]).toMatchObject({ kind: "postgres", fields: crm, password: "" });
        expect(secretWarnings(loaded, other).join()).toMatch(/can't open|doesn't open/);
        // Saved again without entering them: still there for the right key.
        await saveSettings(db, applyUpdate(loaded, update()), other);
        expect((await loadSettings(db, key)).stored).toEqual(stored);
      }
    });
  });
});
