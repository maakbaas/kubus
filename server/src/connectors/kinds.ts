import type { ConnectionKind } from "../../../shared/settings.ts";

// The kinds of source the server reads, with the fields each is set up with in the app (Settings →
// Connections): a source is stored as its kind and these fields (and its password), and its kind
// picks its connector (index.ts), which reads them. Kept apart from the connectors (no database
// packages), so the settings can use it anywhere.

interface Kind extends ConnectionKind {
  /** The fields that decide where its password goes: a stored one is dropped when one of them changes. */
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
];

/** The kinds, as the app shows them. */
export const connectionKinds = (): ConnectionKind[] => KINDS.map(({ place: _p, ...kind }) => kind);

/** A kind's own fields out of `fields` (trimmed, every one present), or null for an unknown kind. */
export function fieldsFor(kind: string, fields: unknown): Record<string, string> | null {
  const k = KINDS.find((x) => x.id === kind);
  if (!k) return null;
  const given = fields && typeof fields === "object" ? (fields as Record<string, unknown>) : {};
  return Object.fromEntries(k.fields.map((f) => [f.key, typeof given[f.key] === "string" ? (given[f.key] as string).trim().slice(0, 500) : ""]));
}

/** Where a source's password goes: the same place keeps a stored one. */
export function placeOf(kind: string, fields: Record<string, string>): string {
  const k = KINDS.find((x) => x.id === kind);
  return JSON.stringify([kind, ...(k?.place ?? []).map((key) => (fields[key] ?? "").toLowerCase())]);
}

/** An address typed with or without http(s)://, as a URL (`secure` when none is given: https). */
export function addressOf(typed: string, secure: boolean): URL {
  const t = typed.trim().replace(/\/+$/, "");
  return new URL(/^https?:\/\//i.test(t) ? t : `${secure ? "https" : "http"}://${t}`);
}
