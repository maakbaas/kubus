import type { ConnectionKind } from "../../../shared/settings.ts";

// The kinds of source the server reads, with the fields each is set up with in the app (Settings →
// Connections): a source is stored as its kind and these fields (and its password), and its kind
// picks its connector (index.ts), which reads them. Kept apart from the connectors (no database
// packages), so the settings can use it anywhere.

interface Kind extends ConnectionKind {
  /** The fields that decide where its password (and secret fields) go: stored ones are dropped when one of them changes (a secret field may be one). */
  place: string[];
}

const KINDS: Kind[] = [
  {
    id: "postgres",
    label: "PostgreSQL",
    fields: [
      { key: "host", label: "Host", placeholder: "db.example.com" },
      { key: "port", label: "Port", placeholder: "5432" },
      { key: "database", label: "Database", placeholder: "crm" },
      { key: "user", label: "User", helperText: "One that can only read." },
      {
        key: "ssl",
        label: "TLS",
        choices: [
          { value: "", text: "Off" },
          { value: "require", text: "On, any certificate" },
          { value: "verify", text: "On, a trusted certificate" },
        ],
      },
    ],
    password: { label: "Password", helperText: "Kept while left empty (unless the host, port or user changes)." },
    schemas: { label: "Schemas", helperText: "Only these schemas' tables are offered, comma-separated. Empty: all." },
    place: ["host", "port", "user"],
  },
  {
    id: "n8n",
    label: "n8n data tables",
    fields: [{ key: "address", label: "Address", placeholder: "https://n8n.example.com", helperText: "Where n8n runs (https:// unless it says http://)." }],
    password: { label: "API key", helperText: "From n8n's Settings → n8n API. Kept while left empty (unless the address changes)." },
    schemas: { label: "Projects", helperText: "Only these projects' tables (their ids), comma-separated. Empty: all." },
    place: ["address"],
  },
  {
    id: "influxdb",
    label: "InfluxDB 2",
    fields: [
      { key: "address", label: "Address", placeholder: "http://influx.example.com:8086", helperText: "http:// unless it says https://; port 8086 (http) or 443 (https) unless given." },
      { key: "org", label: "Organization", placeholder: "my-org" },
    ],
    password: { label: "Token", helperText: "One that can only read. Kept while left empty (unless the address changes)." },
    schemas: { label: "Buckets", helperText: "Only these buckets' measurements are offered, comma-separated. Empty: all." },
    place: ["address"],
  },
  {
    id: "d1",
    label: "Cloudflare D1",
    fields: [
      { key: "account", label: "Account ID", helperText: "In the Cloudflare dashboard, beside the account's name." },
      { key: "database", label: "Database ID", helperText: "On the database's page (Storage & databases → D1)." },
    ],
    password: { label: "API token", helperText: "One with D1 Read permission. Kept while left empty (unless the account changes)." },
    schemas: null,
    place: ["account"],
  },
  {
    id: "mysql",
    label: "MySQL",
    fields: [
      { key: "host", label: "Host", placeholder: "db.example.com" },
      { key: "port", label: "Port", placeholder: "3306" },
      { key: "database", label: "Database", placeholder: "crm", helperText: "Opened first; the other databases (schemas) the user can read are offered too." },
      { key: "user", label: "User", helperText: "One that can only read." },
      {
        key: "ssl",
        label: "TLS",
        choices: [
          { value: "", text: "Off" },
          { value: "require", text: "On, any certificate" },
          { value: "verify", text: "On, a trusted certificate" },
        ],
      },
    ],
    password: { label: "Password", helperText: "Kept while left empty (unless the host, port or user changes)." },
    schemas: { label: "Databases", helperText: "Only these databases' tables are offered, comma-separated. Empty: all the user can read." },
    place: ["host", "port", "user"],
  },
  {
    id: "mariadb",
    label: "MariaDB",
    fields: [
      { key: "host", label: "Host", placeholder: "db.example.com" },
      { key: "port", label: "Port", placeholder: "3306" },
      { key: "database", label: "Database", placeholder: "crm", helperText: "Opened first; the other databases (schemas) the user can read are offered too." },
      { key: "user", label: "User", helperText: "One that can only read." },
      {
        key: "ssl",
        label: "TLS",
        choices: [
          { value: "", text: "Off" },
          { value: "require", text: "On, any certificate" },
          { value: "verify", text: "On, a trusted certificate" },
        ],
      },
    ],
    password: { label: "Password", helperText: "Kept while left empty (unless the host, port or user changes)." },
    schemas: { label: "Databases", helperText: "Only these databases' tables are offered, comma-separated. Empty: all the user can read." },
    place: ["host", "port", "user"],
  },
  {
    id: "actual",
    label: "Actual Budget",
    fields: [
      { key: "address", label: "Address", placeholder: "https://actual-api.example.com", helperText: "Where actual-http-api runs (https:// unless it says http://), not Actual itself." },
      { key: "budget", label: "Budget sync ID", helperText: "In Actual: Settings → Show advanced settings → Sync ID." },
      { key: "encryption", label: "Encryption password", helperText: "Only for a budget with end-to-end encryption. Kept like the API key: never shown again.", secret: true },
    ],
    password: { label: "API key", helperText: "actual-http-api's API_KEY. Kept while left empty (unless the address changes)." },
    schemas: null,
    place: ["address"],
  },
  {
    id: "ics",
    label: "Calendar (ICS)",
    fields: [
      {
        key: "address",
        label: "Address",
        placeholder: "webcal://calendar.example.com/…/basic.ics",
        helperText: "The calendar's secret or public address (webcal://, webcals:// or https://). Kept like a password: only its host is shown again.",
        secret: true,
      },
    ],
    password: { label: "Password", helperText: "Only for a calendar behind a login (sent as Basic with no user, or as Bearer). Usually empty." },
    schemas: null,
    place: ["address"],
  },
  {
    id: "json",
    label: "JSON over HTTP",
    fields: [
      {
        key: "address",
        label: "Address",
        placeholder: "https://api.example.com/items",
        helperText: "https:// unless it says http://. Kept like a password (it may hold a key): only its host is shown again.",
        secret: true,
      },
      { key: "rows", label: "Rows at", placeholder: "/data/items", helperText: "Where the rows are, as a JSON Pointer. Empty: the top level." },
      { key: "header", label: "Header name", placeholder: "X-Api-Key", helperText: "The password goes under this header. Empty: Authorization: Bearer." },
    ],
    password: { label: "Password", helperText: "An API key or token, if it needs one. Kept while left empty (unless the address changes)." },
    schemas: null,
    place: ["address", "header"],
  },
  {
    id: "csv",
    label: "CSV over HTTP",
    fields: [
      {
        key: "address",
        label: "Address",
        placeholder: "https://docs.google.com/spreadsheets/d/e/…/pub?output=csv",
        helperText: "https:// unless it says http://. Kept like a password (a published sheet's holds its secret): only its host is shown again.",
        secret: true,
      },
      { key: "header", label: "Header name", placeholder: "X-Api-Key", helperText: "The password goes under this header. Empty: Authorization: Bearer." },
    ],
    password: { label: "Password", helperText: "An API key or token, if it needs one. Kept while left empty (unless the address changes)." },
    schemas: null,
    place: ["address", "header"],
  },
];

/** The kinds, as the app shows them. */
export const connectionKinds = (): ConnectionKind[] => KINDS.map(({ place: _p, ...kind }) => kind);

/** A kind's own fields out of `fields` (trimmed, every one present, its secret ones left out), or null for an unknown kind. */
export function fieldsFor(kind: string, fields: unknown): Record<string, string> | null {
  const k = KINDS.find((x) => x.id === kind);
  if (!k) return null;
  const given = fields && typeof fields === "object" ? (fields as Record<string, unknown>) : {};
  return Object.fromEntries(k.fields.filter((f) => !f.secret).map((f) => [f.key, typeof given[f.key] === "string" ? (given[f.key] as string).trim().slice(0, 500) : ""]));
}

/** The keys of a kind's secret fields (kept like its password). */
export const secretKeysOf = (kind: string): string[] => (KINDS.find((x) => x.id === kind)?.fields ?? []).filter((f) => f.secret).map((f) => f.key);

/** What a device is shown of a secret field's value: an address's scheme and host ("https://calendar.example.com/…"), else "". */
export function hintOf(secret: string): string {
  try {
    const u = new URL(secret.trim());
    return u.host ? `${u.protocol}//${u.host}/…` : "";
  } catch {
    return "";
  }
}

/** Where a source's password (and its secret fields) go: the same place keeps stored ones. `fields` includes the secret ones. */
export function placeOf(kind: string, fields: Record<string, string>): string {
  const k = KINDS.find((x) => x.id === kind);
  const secret = new Set(secretKeysOf(kind));
  // Hosts and the like case-insensitively; a secret (a path) as it is.
  return JSON.stringify([kind, ...(k?.place ?? []).map((key) => (secret.has(key) ? (fields[key] ?? "") : (fields[key] ?? "").toLowerCase()))]);
}

/** An address typed with or without http(s)://, as a URL (`secure` when none is given: https). */
export function addressOf(typed: string, secure: boolean): URL {
  const t = typed.trim().replace(/\/+$/, "");
  return new URL(/^https?:\/\//i.test(t) ? t : `${secure ? "https" : "http"}://${t}`);
}
