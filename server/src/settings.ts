import { HttpError } from "../../shared/router.ts";
import { SOURCE_NAME, type ServerAiSettings, type ServerSettingsUpdate, type ServerSettingsView, type ServerSourceSettings } from "../../shared/settings.ts";
import type { SourceConfig } from "./connectors/connector.ts";
import { connectionKinds, fieldsFor, placeOf } from "./connectors/kinds.ts";

// The server's own settings (shared/settings.ts): the language model it offers and the sources it
// reads, set in the app (Settings → AI and Connections) and stored in its table server_settings, secrets
// included. Secrets are never sent back, and a stored one is only used where it was given for: one
// whose address changes is dropped, so whoever holds the token can't send it somewhere new.

export interface StoredAi extends ServerAiSettings {
  key: string;
}
export interface StoredSource extends ServerSourceSettings {
  password: string;
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
      kind: text(s.kind),
      fields: fieldsFor(text(s.kind), s.fields) ?? {},
      password: text(s.password),
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

/** The settings after an update (checked; 400 when something can't be stored), secrets kept by the rule above. */
export function applyUpdate(old: Stored, update: ServerSettingsUpdate): Stored {
  if (!update || typeof update !== "object" || !update.ai || !Array.isArray(update.sources)) throw new HttpError(400, "Send the settings as a whole");
  const aiUrl = text(update.ai.url).replace(/\/+$/, "");
  if (aiUrl && !/^https?:\/\//i.test(aiUrl)) throw new HttpError(400, "The model's address starts with http:// or https://");
  const key = typeof update.ai.key === "string" ? text(update.ai.key) : aiUrl === old.ai.url ? old.ai.key : "";
  const names = new Set<string>();
  const sources = update.sources.map((s): StoredSource => {
    const name = text(s.name, 40);
    if (!SOURCE_NAME.test(name)) throw new HttpError(400, `A source's name is letters, digits, - and _ (“${name}” isn't)`);
    if (names.has(name.toLowerCase())) throw new HttpError(400, `Two sources are called “${name}”`);
    names.add(name.toLowerCase());
    const kind = text(s.kind, 40);
    const fields = fieldsFor(kind, s.fields);
    if (!fields) throw new HttpError(400, `${name}: the server doesn't read sources of the kind “${kind}”`);
    const before = old.sources.find((o) => o.id === s.id);
    const password =
      typeof s.password === "string" ? s.password : before && placeOf(before.kind, before.fields) === placeOf(kind, fields) ? before.password : "";
    const timeout = Number(s.timeoutSeconds);
    return {
      id: text(s.id, 100) || crypto.randomUUID(),
      name,
      kind,
      fields,
      password,
      schemas: Array.isArray(s.schemas) ? s.schemas.map((x) => text(x, 200)).filter(Boolean) : [],
      queries: s.queries !== false,
      timeoutSeconds: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 3600) : 30,
    };
  });
  return { ai: { url: aiUrl, key, fieldModel: text(update.ai.fieldModel, 200), codeModel: text(update.ai.codeModel, 200) }, sources };
}

/** What the connectors are given. */
export function sourceConfigs(stored: Stored): SourceConfig[] {
  return stored.sources.map((s) => ({ name: s.name, kind: s.kind, fields: s.fields, password: s.password, schemas: s.schemas, queries: s.queries, timeoutMs: Math.round(s.timeoutSeconds * 1000) }));
}

/** The settings as a device sees them: secrets left out. */
export function viewOf(stored: Stored, status: (name: string) => { connector?: string; problem?: string; warnings?: string[] }): ServerSettingsView {
  const { key, ...ai } = stored.ai;
  return {
    ai: { ...ai, keySet: key !== "" },
    kinds: connectionKinds(),
    sources: stored.sources.map(({ password, ...s }) => ({ ...s, passwordSet: password !== "", ...status(s.name) })),
  };
}
