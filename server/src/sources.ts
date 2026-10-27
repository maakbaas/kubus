import { HttpError, json, readJson, Router, type ApiRequest } from "../../shared/router.ts";
import type { SourceInfo, SourceQuery, SourceRowRequest, SourceTarget } from "../../shared/sources.ts";
import { SourceError, type Connector, type SourceConfig } from "./connectors/connector.ts";
import { connectorFor } from "./connectors/index.ts";

// Remote sources: databases the server reads for the devices (shared/sources.ts), one connector
// each. Devices see their names and what they can do, never their addresses or passwords; they
// ask through /api/sources/... with KUBUS_TOKEN, like the language model (server/src/ai.ts).
// Configured by environment variables, any number of them:
//   KUBUS_SOURCE_<NAME>          its connection string, e.g. postgres://reader:secret@crm-host:5432/crm
//   KUBUS_SOURCE_<NAME>_SCHEMAS  only these schemas' tables, comma-separated (default: all)
//   KUBUS_SOURCE_<NAME>_QUERIES  "off": its tables only, no queries written in the app
//   KUBUS_SOURCE_<NAME>_TIMEOUT  longest a statement may run, in seconds (default 30)

const PREFIX = "KUBUS_SOURCE_";
const OPTIONS = ["_SCHEMAS", "_QUERIES", "_TIMEOUT"];
const MAX_BODY = 1024 * 1024;

/** The configured sources, from the environment (one place, so they can come from elsewhere too). */
export function sourceConfigs(env: Record<string, string | undefined> = process.env): SourceConfig[] {
  const keys = Object.keys(env).filter((k) => k.startsWith(PREFIX) && k.length > PREFIX.length && (env[k] ?? "").trim());
  // A key ending in an option's suffix is that option when the shorter key is a source.
  const isOption = (k: string) => OPTIONS.some((o) => k.endsWith(o) && keys.includes(k.slice(0, -o.length)));
  return keys
    .filter((k) => !isOption(k))
    .sort()
    .map((k) => {
      const option = (o: string) => (env[`${k}${o}`] ?? "").trim();
      const timeout = Number(option("_TIMEOUT") || "30");
      return {
        name: k.slice(PREFIX.length),
        url: env[k]!.trim(),
        schemas: option("_SCHEMAS").split(",").map((s) => s.trim()).filter(Boolean),
        queries: !/^(off|false|no|0)$/i.test(option("_QUERIES")),
        timeoutMs: Math.round((Number.isFinite(timeout) && timeout > 0 ? timeout : 30) * 1000),
      };
    });
}

interface Source {
  config: SourceConfig;
  connector: Connector | null;
  /** Why it can't be read (no connector for it, the last failure to connect). */
  problem?: string;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Sources {
  private sources = new Map<string, Source>();

  constructor(configs: SourceConfig[]) {
    for (const config of configs) {
      const connector = connectorFor(config);
      this.sources.set(config.name, "problem" in connector ? { config, connector: null, problem: connector.problem } : { config, connector });
    }
  }

  get size() {
    return this.sources.size;
  }

  /** Connects to each once, logging what is wrong (a source that fails stays listed, with its problem). */
  async check(log: (message: string) => void) {
    for (const source of this.sources.values()) {
      const name = source.config.name;
      if (!source.connector) {
        log(`[source ${name}] ${source.problem}`);
        continue;
      }
      try {
        for (const warning of await source.connector.check()) log(`[source ${name}] warning: ${warning}`);
        log(`[source ${name}] ready (${source.connector.kind})`);
      } catch (e) {
        source.problem = `Can't connect: ${messageOf(e)}`;
        log(`[source ${name}] ${source.problem}`);
      }
    }
  }

  list(): SourceInfo[] {
    return [...this.sources.values()].map(({ config, connector, problem }) => ({
      name: config.name,
      connector: connector?.kind ?? "none",
      capabilities: connector?.capabilities ?? { query: false },
      ...(problem && { problem }),
    }));
  }

  /** Runs a request on a source: its mistakes answer 400, an unreachable source 502. */
  private async on<T>(name: string, work: (connector: Connector) => Promise<T>): Promise<T> {
    const source = this.sources.get(name);
    if (!source) throw new HttpError(404, `The server has no source “${name}”`);
    if (!source.connector) throw new HttpError(502, source.problem ?? "Unavailable");
    try {
      const result = await work(source.connector);
      delete source.problem;
      return result;
    } catch (e) {
      if (e instanceof SourceError || e instanceof HttpError) throw e instanceof SourceError ? new HttpError(400, e.message) : e;
      console.error(`[source ${name}]`, e);
      source.problem = `Can't read it: ${messageOf(e)}`;
      throw new HttpError(502, `${name}: ${messageOf(e)}`);
    }
  }

  /** The devices' endpoints (behind the token, like the rest of /api). */
  routes(router: Router): Router {
    const body = async <T>(req: ApiRequest, check: (b: Record<string, unknown>) => boolean): Promise<T> => {
      const b = await readJson(req, MAX_BODY);
      if (!b || typeof b !== "object" || !check(b as Record<string, unknown>)) throw new HttpError(400, "Not a valid request");
      return b as T;
    };
    const isTarget = (t: unknown): t is SourceTarget =>
      !!t && typeof t === "object" && (typeof (t as { query?: unknown }).query === "string" || typeof (t as { table?: { name?: unknown } }).table?.name === "string");
    const isShape = (b: Record<string, unknown>) =>
      isTarget(b.target) && typeof b.key === "string" && Array.isArray(b.columns) && Array.isArray(b.title) && typeof b.untitled === "string";
    return router
      .add("GET", "/api/sources", async () => json(200, this.list()))
      .add("GET", "/api/sources/{name}/tables", async (_req, params) => json(200, await this.on(params.name, (c) => c.tables())))
      .add("POST", "/api/sources/{name}/describe", async (req, params) => {
        const { target } = await body<{ target: SourceTarget }>(req, (b) => isTarget(b.target));
        return json(200, await this.on(params.name, (c) => c.describe(target)));
      })
      .add("POST", "/api/sources/{name}/query", async (req, params) => {
        const query = await body<SourceQuery>(
          req,
          (b) => isShape(b) && Array.isArray(b.filters) && Array.isArray(b.sort) && typeof b.timeZone === "string" && typeof b.offset === "number" && typeof b.limit === "number",
        );
        return json(200, await this.on(params.name, (c) => c.query({ ...query, search: String(query.search ?? ""), groupOrder: query.groupOrder ?? "asc" })));
      })
      .add("POST", "/api/sources/{name}/row", async (req, params) => {
        const request = await body<SourceRowRequest>(req, (b) => isShape(b) && typeof b.keyValue === "string");
        return json(200, { row: await this.on(params.name, (c) => c.row(request)) });
      });
  }
}
