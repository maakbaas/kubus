// @vitest-environment node
// The server's settings: secrets are kept only where they were given for (server/src/settings.ts).
import { describe, expect, it } from "vitest";
import {
  applyUpdate, loadSettings, NO_SETTINGS, saveSettings, secretKey, secretWarnings, sourceConfigs, splitPassword, viewOf, type Stored,
} from "../src/settings.ts";
import type { ServerSettingsUpdate } from "../../shared/settings.ts";

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
      expect(raw(db)).toContain("reader@crm");
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
        expect(sourceConfigs(loaded)[0].url).toBe("postgres://reader@crm:5432/crm");
        expect(secretWarnings(loaded, other).join()).toMatch(/can't open|doesn't open/);
        // Saved again without entering them: still there for the right key.
        await saveSettings(db, applyUpdate(loaded, update()), other);
        expect((await loadSettings(db, key)).stored).toEqual(stored);
      }
    });
  });
});
