import type { Connector, SourceConfig } from "./connector.ts";
import { D1Connector } from "./d1.ts";
import { IcsConnector } from "./ics.ts";
import { InfluxConnector } from "./influx.ts";
import { N8nConnector } from "./n8n.ts";
import { PostgresConnector } from "./postgres.ts";

// The connectors, by a source's kind (postgres.ts, n8n.ts, influx.ts: InfluxDB 2, d1.ts: Cloudflare D1, ics.ts: a calendar subscription). Another kind of source is
// another entry here, its fields in kinds.ts (and its own file beside them); nothing else on the
// server or in the app changes.

const CONNECTORS: Record<string, (config: SourceConfig) => Connector> = {
  postgres: (config) => new PostgresConnector(config),
  n8n: (config) => new N8nConnector(config),
  influxdb: (config) => new InfluxConnector(config),
  d1: (config) => new D1Connector(config),
  ics: (config) => new IcsConnector(config),
};

/** The connector for a source, or why there is none. */
export function connectorFor(config: SourceConfig): Connector | { problem: string } {
  const make = Object.hasOwn(CONNECTORS, config.kind) ? CONNECTORS[config.kind] : undefined;
  if (!make) return { problem: `No connector reads “${config.kind}” sources (known: ${Object.keys(CONNECTORS).join(", ")})` };
  try {
    return make(config);
  } catch (e) {
    return { problem: e instanceof Error ? e.message : String(e) };
  }
}
