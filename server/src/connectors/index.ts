import type { Connector, SourceConfig } from "./connector.ts";
import { N8nConnector } from "./n8n.ts";
import { PostgresConnector } from "./postgres.ts";

// The connectors, by the scheme of a source's connection string. Another kind of source is
// another entry here (and its own file beside postgres.ts and n8n.ts); nothing else on the server or in the
// app changes.

const CONNECTORS: Record<string, (config: SourceConfig) => Connector> = {
  postgres: (config) => new PostgresConnector(config),
  postgresql: (config) => new PostgresConnector(config),
  n8n: (config) => new N8nConnector(config),
  "n8n+http": (config) => new N8nConnector(config),
};

/** The connector for a source, or why there is none. */
export function connectorFor(config: SourceConfig): Connector | { problem: string } {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(config.url)?.[1]?.toLowerCase() ?? "";
  const make = CONNECTORS[scheme];
  if (!make) return { problem: `No connector reads “${scheme || config.url}” connections (known: ${Object.keys(CONNECTORS).join(", ")})` };
  return make(config);
}
