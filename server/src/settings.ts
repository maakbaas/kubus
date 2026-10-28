import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { HttpError } from "../../shared/router.ts";
import { DEFAULT_MAP_STYLE, MAP_STYLE_IDS, SOURCE_NAME, type ServerAiSettings, type ServerMapSettings, type ServerSettingsUpdate, type ServerSettingsView, type ServerSourceSettings } from "../../shared/settings.ts";
import type { SourceConfig } from "./connectors/connector.ts";
import { connectionKinds, fieldsFor, placeOf, secretKeysOf } from "./connectors/kinds.ts";

// The server's own settings (shared/settings.ts): the language model it offers, the sources it
// reads and how maps look, set in the app (Settings → AI, Connections and Maps) and stored in its table server_settings, secrets
// included. Secrets are never sent back, and a stored one is only used where it was given for: one
// whose address changes is dropped, so whoever holds the token can't send it somewhere new.
// With KUBUS_SECRET_KEY set, the secrets are stored encrypted with it (AES-256-GCM): the database
// alone (a dump, a backup) doesn't give them. Without it they are stored as plain text: the
// server's owner chooses. One the key can't open (no key, another key) stays stored as it is, but
// isn't used and reads as not set, so setting the right key again brings it back.

export interface StoredAi extends ServerAiSettings {
  key: string;
}
export interface StoredSource extends ServerSourceSettings {
  password: string;
  /** Its secret fields (kinds.ts ConnectionField.secret), kept like the password: only the set ones. */
  secrets: Record<string, string>;
  /** The names it had before (renamed in the settings): collections made under one still read it. */
  formerNames: string[];
}
export interface Stored {
  ai: StoredAi;
  sources: StoredSource[];
  map: ServerMapSettings;
}

/** What this needs of the server's pool (pg.Pool): kept narrow, so it is tested without the server's packages. */
interface Db {
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

export const NO_SETTINGS: Stored = { ai: { url: "", key: "", fieldModel: "", codeModel: "" }, sources: [], map: { style: DEFAULT_MAP_STYLE } };

/** A map style as stored or sent; else `fallback`. */
const mapOf = (raw: unknown, fallback: ServerMapSettings): ServerMapSettings => {
  const style = (raw as Partial<ServerMapSettings> | null | undefined)?.style;
  return MAP_STYLE_IDS.includes(style as never) ? { style: style! } : fallback;
};

const text = (v: unknown, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** A stored secret encrypted with the key: the prefix, then base64url of iv (12), tag (16) and ciphertext. */
const SEALED = "kubus-sealed:v1:";

/** The key the secrets are encrypted with, from KUBUS_SECRET_KEY (any string); null = plain text. */
export function secretKey(raw: string | undefined): Buffer | null {
  return raw ? scryptSync(raw, "kubus-server-settings", 32) : null;
}

/** A secret still encrypted: one the key couldn't open. It isn't used and reads as not set. */
export const isSealed = (secret: string) => secret.startsWith(SEALED);
/** A secret as it can be used: "" while it is sealed. */
export const usable = (secret: string) => (isSealed(secret) ? "" : secret);

function seal(secret: string, key: Buffer | null): string {
  if (!key || !secret || isSealed(secret)) return secret;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return SEALED + Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
}

function open(secret: string, key: Buffer | null): string {
  if (!key || !isSealed(secret)) return secret;
  try {
    const bytes = Buffer.from(secret.slice(SEALED.length), "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return secret; // another key: kept sealed
  }
}

/** The stored secrets, each with what it is for (for the log). */
const secretsOf = (stored: Stored) => [
  { what: "the language model's key", secret: stored.ai.key },
  ...stored.sources.flatMap((s) => [
    { what: `${s.name}'s password`, secret: s.password },
    ...Object.entries(s.secrets).map(([key, secret]) => ({ what: `${s.name}'s ${key}`, secret })),
  ]),
];

/** What is wrong with how the secrets are stored, for the log at start ([] = nothing). */
export function secretWarnings(stored: Stored, key: Buffer | null): string[] {
  const secrets = secretsOf(stored).filter((s) => s.secret);
  const sealed = secrets.filter((s) => isSealed(s.secret)).map((s) => s.what);
  return [
    ...(!key && secrets.length > sealed.length ? ["KUBUS_SECRET_KEY isn't set: the server's secrets are stored as plain text"] : []),
    ...(sealed.length ? [`KUBUS_SECRET_KEY ${key ? "doesn't open" : "isn't set, so it can't open"} ${sealed.join(", ")}: set the key it was stored with, or enter ${sealed.length > 1 ? "them" : "it"} again`] : []),
  ];
}

/** The stored settings, the secrets opened with the key; `plainText`: some are stored as plain text. */
export async function loadSettings(pool: Db, key: Buffer | null): Promise<{ stored: Stored; plainText: boolean }> {
  const { rows } = await pool.query<{ key: string; value: unknown }>("SELECT key, value FROM server_settings");
  const value = (key: string) => rows.find((r) => r.key === key)?.value;
  const ai = (value("ai") ?? {}) as Partial<StoredAi>;
  const sources = Array.isArray(value("sources")) ? (value("sources") as Partial<StoredSource>[]) : [];
  // Read whole: encrypted, a secret of applyUpdate's 2000 characters is longer.
  const secret = (v: unknown) => text(v, 4000);
  const secretsOfSource = (s: Partial<StoredSource>) => (s.secrets && typeof s.secrets === "object" ? Object.values(s.secrets) : []);
  const plainText = [ai.key, ...sources.flatMap((s) => [s.password, ...secretsOfSource(s)])].some((v) => secret(v) !== "" && !isSealed(secret(v)));
  const stored: Stored = {
    ai: { url: text(ai.url), key: open(secret(ai.key), key), fieldModel: text(ai.fieldModel), codeModel: text(ai.codeModel) },
    sources: sources.map((s) => ({
      id: text(s.id),
      name: text(s.name),
      kind: text(s.kind),
      fields: fieldsFor(text(s.kind), s.fields) ?? {},
      password: open(secret(s.password), key),
      secrets: Object.fromEntries(
        secretKeysOf(text(s.kind))
          .map((k) => [k, open(secret((s.secrets as Record<string, unknown> | undefined)?.[k]), key)] as const)
          .filter(([, v]) => v !== ""),
      ),
      formerNames: Array.isArray(s.formerNames) ? s.formerNames.map((n) => text(n, 40)).filter(Boolean) : [],
      schemas: Array.isArray(s.schemas) ? s.schemas.map((x) => text(x)).filter(Boolean) : [],
      timeoutSeconds: typeof s.timeoutSeconds === "number" && s.timeoutSeconds > 0 ? s.timeoutSeconds : 30,
    })),
    map: mapOf(value("map"), NO_SETTINGS.map),
  };
  return { stored, plainText };
}

/** Stores the settings, the secrets encrypted with the key when there is one. */
export async function saveSettings(pool: Db, stored: Stored, key: Buffer | null): Promise<void> {
  const ai = { ...stored.ai, key: seal(stored.ai.key, key) };
  const sources = stored.sources.map((s) => ({
    ...s,
    password: seal(s.password, key),
    secrets: Object.fromEntries(Object.entries(s.secrets).map(([k, v]) => [k, seal(v, key)])),
  }));
  await pool.query(
    `INSERT INTO server_settings (key, value, updated_at) VALUES ('ai', $1, now()), ('sources', $2, now()), ('map', $3, now())
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [JSON.stringify(ai), JSON.stringify(sources), JSON.stringify(stored.map)],
  );
}

/** The settings after an update (checked; 400 when something can't be stored), secrets kept by the rule above. */
export function applyUpdate(old: Stored, update: ServerSettingsUpdate): Stored {
  if (!update || typeof update !== "object" || !update.ai || !Array.isArray(update.sources) || update.sources.some((s) => !s || typeof s !== "object")) throw new HttpError(400, "Send the settings as a whole");
  const aiUrl = text(update.ai.url).replace(/\/+$/, "");
  if (aiUrl && !/^https?:\/\//i.test(aiUrl)) throw new HttpError(400, "The model's address starts with http:// or https://");
  const key = typeof update.ai.key === "string" ? text(update.ai.key) : aiUrl === old.ai.url ? old.ai.key : "";
  const names = new Set<string>();
  const sources = update.sources.map((s): StoredSource => {
    const name = text(s.name, 40);
    if (!SOURCE_NAME.test(name)) throw new HttpError(400, `A source's name is letters, digits, spaces, - and _ (“${name}” isn't)`);
    if (names.has(name.toLowerCase())) throw new HttpError(400, `Two sources are called “${name}”`);
    names.add(name.toLowerCase());
    const kind = text(s.kind, 40);
    const fields = fieldsFor(kind, s.fields);
    if (!fields) throw new HttpError(400, `${name}: the server doesn't read sources of the kind “${kind}”`);
    const before = old.sources.find((o) => o.id === s.id);
    // The secret fields given, else the stored ones (while of the same kind): kept below only if the place stays.
    const given = s.secrets && typeof s.secrets === "object" ? s.secrets : {};
    const isGiven = (k: string) => typeof given[k] === "string";
    const secretKeys = secretKeysOf(kind);
    const candidate = Object.fromEntries(secretKeys.map((k) => [k, isGiven(k) ? text(given[k]) : before?.kind === kind ? (before.secrets[k] ?? "") : ""]));
    const samePlace = !!before && placeOf(before.kind, { ...before.fields, ...before.secrets }) === placeOf(kind, { ...fields, ...candidate });
    const secrets = Object.fromEntries(secretKeys.map((k) => [k, isGiven(k) || samePlace ? candidate[k] : ""] as const).filter(([, v]) => v !== ""));
    const password = typeof s.password === "string" ? s.password : samePlace ? before.password : "";
    const timeout = Number(s.timeoutSeconds);
    // Renamed: its old name is kept, so collections that read it by that name still do.
    const formerNames = before ? [...before.formerNames, ...(before.name !== name ? [before.name] : [])] : [];
    return {
      id: text(s.id, 100) || crypto.randomUUID(),
      name,
      formerNames,
      kind,
      fields,
      password,
      secrets,
      schemas: Array.isArray(s.schemas) ? s.schemas.map((x) => text(x, 200)).filter(Boolean) : [],
      timeoutSeconds: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 3600) : 30,
    };
  });
  // A former name another source now has is that one's (the last 20 kept).
  for (const s of sources) s.formerNames = [...new Set(s.formerNames)].filter((n) => !names.has(n.toLowerCase())).slice(-20);
  return { ai: { url: aiUrl, key, fieldModel: text(update.ai.fieldModel, 200), codeModel: text(update.ai.codeModel, 200) }, sources, map: mapOf(update.map, old.map) };
}

/** What the connectors are given. */
export function sourceConfigs(stored: Stored): SourceConfig[] {
  return stored.sources.map((s) => ({
    name: s.name,
    formerNames: s.formerNames,
    kind: s.kind,
    fields: { ...s.fields, ...Object.fromEntries(Object.entries(s.secrets).map(([k, v]) => [k, usable(v)])) },
    password: usable(s.password),
    schemas: s.schemas,
    timeoutMs: Math.round(s.timeoutSeconds * 1000),
  }));
}

/** The settings as a device sees them: secrets left out. */
export function viewOf(stored: Stored, status: (name: string) => { connector?: string; problem?: string; warnings?: string[] }): ServerSettingsView {
  const { key, ...ai } = stored.ai;
  return {
    ai: { ...ai, keySet: usable(key) !== "" },
    map: stored.map,
    kinds: connectionKinds(),
    sources: stored.sources.map(({ password, secrets, formerNames: _formerNames, ...s }) => ({
      ...s,
      passwordSet: usable(password) !== "",
      secretsSet: Object.keys(secrets).filter((k) => usable(secrets[k]) !== ""),
      ...status(s.name),
    })),
  };
}
