import { HttpError } from "../../shared/router.ts";
import { SOURCE_NAME, type ServerAiSettings, type ServerSettingsUpdate, type ServerSettingsView, type ServerSourceSettings } from "../../shared/settings.ts";
import type { SourceConfig } from "./connectors/connector.ts";

// The server's own settings (shared/settings.ts): the language model it offers and the sources it
// reads, set in the app (Settings → Server) and stored in its table server_settings, secrets
// included. Secrets are never sent back, and a stored one is only used where it was given for: one
// whose address changes is dropped, so whoever holds the token can't send it somewhere new.

export interface StoredAi extends ServerAiSettings {
  key: string;
}
export interface StoredSource extends ServerSourceSettings {
  password: string;
  /** The names it had before (renamed in the settings): collections made under one still read it. */
  formerNames: string[];
}
export interface Stored {
  ai: StoredAi;
  sources: StoredSource[];
}

/** What this needs of the server's pool (pg.Pool): kept narrow, so it is tested without the server's packages. */
interface Db {
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

export const NO_SETTINGS: Stored = { ai: { url: "", key: "", fieldModel: "", codeModel: "" }, sources: [] };

const text = (v: unknown, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export async function loadSettings(pool: Db): Promise<Stored> {
  const { rows } = await pool.query<{ key: string; value: unknown }>("SELECT key, value FROM server_settings");
  const value = (key: string) => rows.find((r) => r.key === key)?.value;
  const ai = (value("ai") ?? {}) as Partial<StoredAi>;
  const sources = Array.isArray(value("sources")) ? (value("sources") as Partial<StoredSource>[]) : [];
  return {
    ai: { url: text(ai.url), key: text(ai.key), fieldModel: text(ai.fieldModel), codeModel: text(ai.codeModel) },
    sources: sources.map((s) => ({
      id: text(s.id),
      name: text(s.name),
      url: text(s.url),
      password: text(s.password),
      formerNames: Array.isArray(s.formerNames) ? s.formerNames.map((n) => text(n, 40)).filter(Boolean) : [],
      schemas: Array.isArray(s.schemas) ? s.schemas.map((x) => text(x)).filter(Boolean) : [],
      queries: s.queries !== false,
      timeoutSeconds: typeof s.timeoutSeconds === "number" && s.timeoutSeconds > 0 ? s.timeoutSeconds : 30,
    })),
  };
}

export async function saveSettings(pool: Db, stored: Stored): Promise<void> {
  await pool.query(
    `INSERT INTO server_settings (key, value, updated_at) VALUES ('ai', $1, now()), ('sources', $2, now())
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [JSON.stringify(stored.ai), JSON.stringify(stored.sources)],
  );
}

/** A connection string's parts that decide where its password goes. */
function placeOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${decodeURIComponent(u.username)}@${u.hostname}:${u.port}`;
  } catch {
    return null;
  }
}

/** A connection string without its password, and the password it held (""). */
export function splitPassword(url: string): { url: string; password: string } {
  try {
    const u = new URL(url);
    const password = decodeURIComponent(u.password);
    u.password = "";
    return { url: u.toString(), password };
  } catch {
    return { url, password: "" };
  }
}

/** The settings after an update (checked; 400 when something can't be stored), secrets kept by the rule above. */
export function applyUpdate(old: Stored, update: ServerSettingsUpdate): Stored {
  if (!update || typeof update !== "object" || !update.ai || !Array.isArray(update.sources)) throw new HttpError(400, "Send the settings as a whole");
  const aiUrl = text(update.ai.url).replace(/\/+$/, "");
  if (aiUrl && !/^https?:\/\//i.test(aiUrl)) throw new HttpError(400, "The model's address starts with http:// or https://");
  const key = typeof update.ai.key === "string" ? text(update.ai.key) : aiUrl === old.ai.url ? old.ai.key : "";
  const names = new Set<string>();
  const sources = update.sources.map((s): StoredSource => {
    const name = text(s.name, 40);
    if (!SOURCE_NAME.test(name)) throw new HttpError(400, `A source's name is letters, digits, spaces, - and _ (“${name}” isn't)`);
    if (names.has(name.toLowerCase())) throw new HttpError(400, `Two sources are called “${name}”`);
    names.add(name.toLowerCase());
    const given = splitPassword(text(s.url));
    if (!placeOf(given.url)) throw new HttpError(400, `${name}: the connection string isn't a URL (e.g. postgres://user@host:5432/database or influxdb://host:8086/org)`);
    const before = old.sources.find((o) => o.id === s.id);
    const password =
      given.password || (typeof s.password === "string" ? s.password : before && placeOf(before.url) === placeOf(given.url) ? before.password : "");
    const timeout = Number(s.timeoutSeconds);
    // Renamed: its old name is kept, so collections that read it by that name still do.
    const formerNames = before ? [...before.formerNames, ...(before.name !== name ? [before.name] : [])] : [];
    return {
      id: text(s.id, 100) || crypto.randomUUID(),
      name,
      formerNames,
      url: given.url,
      password,
      schemas: Array.isArray(s.schemas) ? s.schemas.map((x) => text(x, 200)).filter(Boolean) : [],
      queries: s.queries !== false,
      timeoutSeconds: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 3600) : 30,
    };
  });
  // A former name another source now has is that one's (the last 20 kept).
  for (const s of sources) s.formerNames = [...new Set(s.formerNames)].filter((n) => !names.has(n.toLowerCase())).slice(-20);
  return { ai: { url: aiUrl, key, fieldModel: text(update.ai.fieldModel, 200), codeModel: text(update.ai.codeModel, 200) }, sources };
}

/** What the connectors are given: the connection string with its password. */
export function sourceConfigs(stored: Stored): SourceConfig[] {
  return stored.sources.map((s) => {
    let url = s.url;
    if (s.password) {
      try {
        const u = new URL(s.url);
        u.password = s.password;
        url = u.toString();
      } catch {
        // Not a URL: the connector says so.
      }
    }
    return { name: s.name, formerNames: s.formerNames, url, schemas: s.schemas, queries: s.queries, timeoutMs: Math.round(s.timeoutSeconds * 1000) };
  });
}

/** The settings as a device sees them: secrets left out. */
export function viewOf(stored: Stored, status: (name: string) => { connector?: string; problem?: string; warnings?: string[] }): ServerSettingsView {
  const { key, ...ai } = stored.ai;
  return {
    ai: { ...ai, keySet: key !== "" },
    sources: stored.sources.map(({ password, formerNames: _formerNames, ...s }) => ({ ...s, passwordSet: password !== "", ...status(s.name) })),
  };
}
