import type { Connector, SourceConfig } from "./connector.ts";
import { InfluxConnector } from "./influx.ts";
import { PostgresConnector } from "./postgres.ts";

// The connectors, by the scheme of a source's connection string (postgres.ts, influx.ts: InfluxDB 2). Another kind of source is
// another entry here (and its own file beside postgres.ts); nothing else on the server or in the
// app changes.

const CONNECTORS: Record<string, (config: SourceConfig) => Connector> = {
  postgres: (config) => new PostgresConnector(config),
  postgresql: (config) => new PostgresConnector(config),
  influxdb: (config) => new InfluxConnector(config),
  influxdbs: (config) => new InfluxConnector(config),
};

/** The connector for a source, or why there is none. */
export function connectorFor(config: SourceConfig): Connector | { problem: string } {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(config.url)?.[1]?.toLowerCase() ?? "";
  const make = CONNECTORS[scheme];
  if (!make) return { problem: `No connector reads “${scheme || config.url}” connections (known: ${Object.keys(CONNECTORS).join(", ")})` };
  try {
    return make(config);
  } catch (e) {
    return { problem: e instanceof Error ? e.message : String(e) };
  }
}
