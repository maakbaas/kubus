// A real InfluxDB 2 (tests/services.yml, profile `connectors`; KUBUS_TEST_INFLUX is its address, e.g.
// http://localhost:8086) filled through its own HTTP API: a bucket per test file, line protocol written
// to it, and tokens that can only read it (or that can write too). The organization and admin token are
// the ones the image is set up with (services.yml), or KUBUS_TEST_INFLUX_ORG / KUBUS_TEST_INFLUX_TOKEN.
import { PEOPLE } from "./dataset.ts";

export const INFLUX = process.env.KUBUS_TEST_INFLUX;
export const ORG = process.env.KUBUS_TEST_INFLUX_ORG ?? "kubus";
export const ADMIN_TOKEN = process.env.KUBUS_TEST_INFLUX_TOKEN ?? "kubus-test-admin-token";

async function api(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, ...rest } = init;
  const response = await fetch(`${INFLUX}${path}`, {
    ...rest,
    headers: { Authorization: `Token ${ADMIN_TOKEN}`, ...(json !== undefined && { "Content-Type": "application/json" }), ...rest.headers },
    ...(json !== undefined && { body: JSON.stringify(json) }),
  });
  if (!response.ok) throw new Error(`InfluxDB ${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`);
  return response;
}

/** The source's fields (connectors/kinds.ts) for the test server. */
export function influxFields(): Record<string, string> {
  return { address: INFLUX!, org: ORG };
}

/** A new, empty bucket (one left over from an interrupted run is deleted first). */
export async function createBucket(name: string): Promise<{ id: string; orgId: string }> {
  const found = (await (await api(`/api/v2/buckets?name=${encodeURIComponent(name)}`).catch(() => new Response("{}"))).json()) as { buckets?: { id: string }[] };
  for (const b of found.buckets ?? []) await api(`/api/v2/buckets/${b.id}`, { method: "DELETE" });
  const orgs = (await (await api(`/api/v2/orgs?org=${encodeURIComponent(ORG)}`)).json()) as { orgs: { id: string }[] };
  const orgId = orgs.orgs[0].id;
  const made = (await (await api("/api/v2/buckets", { method: "POST", json: { orgID: orgId, name, retentionRules: [] } })).json()) as { id: string };
  return { id: made.id, orgId };
}

export async function deleteBucket(id: string): Promise<void> {
  await api(`/api/v2/buckets/${id}`, { method: "DELETE" });
}

/** Writes line protocol (one point per line, times in nanoseconds) to a bucket. */
export async function write(bucket: string, lines: string[]): Promise<void> {
  await api(`/api/v2/write?org=${encodeURIComponent(ORG)}&bucket=${encodeURIComponent(bucket)}&precision=ns`, { method: "POST", body: lines.join("\n"), headers: { "Content-Type": "text/plain" } });
}

/** A token with these actions on these buckets: its id (to delete it) and secret. */
export async function createToken(orgId: string, bucketIds: string[], description: string, actions: ("read" | "write")[] = ["read"]): Promise<{ id: string; token: string }> {
  const body = { orgID: orgId, description, permissions: bucketIds.flatMap((id) => actions.map((action) => ({ action, resource: { type: "buckets", id, orgID: orgId } }))) };
  return (await (await api("/api/v2/authorizations", { method: "POST", json: body })).json()) as { id: string; token: string };
}

export async function deleteToken(id: string): Promise<void> {
  await api(`/api/v2/authorizations/${id}`, { method: "DELETE" });
}

/** How many points a bucket holds (to see that a connector wrote nothing). */
export async function countPoints(bucket: string): Promise<number> {
  const flux = `from(bucket: "${bucket}") |> range(start: 0, stop: 2200-01-01T00:00:00Z) |> filter(fn: (r) => r._field == "id") |> group() |> count()`;
  const text = await (await api(`/api/v2/query?org=${encodeURIComponent(ORG)}`, { method: "POST", json: { query: flux, type: "flux" }, headers: { Accept: "application/csv" } })).text();
  const line = text.split(/\r?\n/).filter((l) => l && !l.startsWith("#"))[1];
  return line ? Number(line.split(",").at(-1)) : 0;
}

const esc = (s: string) => s.replace(/[ ,=]/g, (c) => `\\${c}`);
const str = (s: string) => `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** The time a person's point has: `seen`, else a made-up one (a point needs a time). */
export const timeOf = (seen: string | null, i: number) => (seen ? Date.parse(seen) : Date.parse("2025-01-01T00:00:00Z") + i * 1000);

/** The people as points of the measurement `people`: tag city; fields id, name, age, score, active; the time `seen`. */
export function peopleLines(): string[] {
  return PEOPLE.map((p, i) => {
    const tags = p.city === null ? "" : `,city=${esc(p.city)}`;
    const fields = [
      `id=${p.id}i`,
      ...(p.name === null ? [] : [`name=${str(p.name)}`]),
      ...(p.age === null ? [] : [`age=${p.age}`]),
      ...(p.score === null ? [] : [`score=${p.score.toFixed(6)}`]),
      ...(p.active === null ? [] : [`active=${p.active}`]),
    ];
    return `people${tags} ${fields.join(",")} ${timeOf(p.seen, i)}000000`;
  });
}
