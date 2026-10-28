import type { ConnectionKind } from "../../../shared/settings.ts";

// The fields each kind of source is set up with in the app (Settings → Connections), and how they
// make its connection string, the form a source is stored in (and what picks its connector:
// index.ts). Kept apart from the connectors (no database packages), so the settings can use it
// anywhere. A connection string none of these reads stays a plain connection string in the app.

type Fields = Record<string, string>;
interface Form extends ConnectionKind {
  toUrl(fields: Fields): string;
  /** Its fields, or null when the string isn't this kind's or holds more than its fields say. */
  fromUrl(url: URL): Fields | null;
}

const enc = encodeURIComponent;
const dec = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
const path = (u: URL) => dec(u.pathname.replace(/^\/+|\/+$/g, ""));
const field = (f: Fields, key: string) => (f[key] ?? "").trim();
/** An address typed with or without http(s)://: whether it is https, and the rest (host, port, path). */
const address = (typed: string) => {
  const m = /^(https?):\/\/(.*)$/i.exec(typed.trim());
  return { secure: m ? m[1].toLowerCase() === "https" : true, rest: (m ? m[2] : typed.trim()).replace(/\/+$/, "") };
};
/** No user, query or fragment: what the kinds below other than Postgres don't have fields for. */
const plain = (u: URL) => !u.username && !u.search && !u.hash;

const FORMS: Form[] = [
  {
    id: "postgres",
    label: "PostgreSQL",
    fields: [
      { key: "host", label: "Host", placeholder: "db.example.com" },
      { key: "port", label: "Port", placeholder: "5432" },
      { key: "database", label: "Database", placeholder: "crm" },
      { key: "user", label: "User", helperText: "One that can only read: queries written in the app can read whatever it can." },
      { key: "options", label: "Options", placeholder: "sslmode=require", helperText: "Connection options as name=value, joined by &. Empty: none." },
    ],
    password: { label: "Password", helperText: "Kept while left empty (unless the host, port or user changes)." },
    schemas: { label: "Schemas", helperText: "Only these schemas' tables are offered, comma-separated. Empty: all." },
    toUrl: (f) => {
      const user = field(f, "user");
      const port = field(f, "port");
      const options = field(f, "options").replace(/^\?/, "");
      return `postgres://${user ? `${enc(user)}@` : ""}${field(f, "host")}${port ? `:${port}` : ""}/${enc(field(f, "database"))}${options ? `?${options}` : ""}`;
    },
    fromUrl: (u) =>
      u.protocol === "postgres:" || u.protocol === "postgresql:"
        ? { host: u.hostname, port: u.port, database: path(u), user: dec(u.username), options: u.search.slice(1) }
        : null,
  },
  {
    id: "n8n",
    label: "n8n data tables",
    fields: [{ key: "address", label: "Address", placeholder: "https://n8n.example.com", helperText: "Where n8n runs (https:// unless it says http://)." }],
    password: { label: "API key", helperText: "From n8n's Settings → n8n API. Kept while left empty (unless the address changes)." },
    schemas: { label: "Projects", helperText: "Only these projects' tables (their ids), comma-separated. Empty: all." },
    toUrl: (f) => {
      const { secure, rest } = address(field(f, "address"));
      return `${secure ? "n8n" : "n8n+http"}://${rest}`;
    },
    fromUrl: (u) =>
      (u.protocol === "n8n:" || u.protocol === "n8n+http:") && plain(u)
        ? { address: `${u.protocol === "n8n:" ? "https" : "http"}://${u.host}${u.pathname.replace(/\/+$/, "")}` }
        : null,
  },
  {
    id: "influxdb",
    label: "InfluxDB 2",
    fields: [
      { key: "address", label: "Address", placeholder: "http://influx.example.com:8086", helperText: "With http:// or https://; port 8086 (http) or 443 (https) unless given." },
      { key: "org", label: "Organization", placeholder: "my-org" },
    ],
    password: { label: "Token", helperText: "One that can only read. Kept while left empty (unless the address changes)." },
    schemas: { label: "Buckets", helperText: "Only these buckets' measurements are offered, comma-separated. Empty: all." },
    toUrl: (f) => {
      const { secure, rest } = address(field(f, "address"));
      return `${secure ? "influxdbs" : "influxdb"}://${rest}/${enc(field(f, "org"))}`;
    },
    fromUrl: (u) =>
      (u.protocol === "influxdb:" || u.protocol === "influxdbs:") && plain(u)
        ? { address: `${u.protocol === "influxdbs:" ? "https" : "http"}://${u.host}`, org: path(u) }
        : null,
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
    toUrl: (f) => `d1://${enc(field(f, "account"))}/${enc(field(f, "database"))}`,
    fromUrl: (u) => (u.protocol === "d1:" && plain(u) ? { account: dec(u.hostname), database: path(u) } : null),
  },
];

/** The kinds, as the app shows them. */
export const connectionKinds = (): ConnectionKind[] => FORMS.map(({ toUrl: _t, fromUrl: _f, ...kind }) => kind);

/** The kind and fields of a stored connection string (without its password), or null when no kind reads it. */
export function fieldsOf(url: string): { kind: string; fields: Fields } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  for (const form of FORMS) {
    const fields = form.fromUrl(u);
    if (fields) return { kind: form.id, fields };
  }
  return null;
}

/** The connection string these fields make, or null for an unknown kind. */
export function urlOf(kind: string, fields: Fields): string | null {
  return FORMS.find((f) => f.id === kind)?.toUrl(fields) ?? null;
}
