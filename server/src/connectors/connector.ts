import type { SourceDescription, SourceQuery, SourceResult, SourceRow, SourceRowRequest, SourceTable, SourceTarget } from "../../../shared/sources.ts";

// A connector reads one kind of source (a Postgres database, n8n's data tables, an InfluxDB 2 server) for the app, in the
// app's terms (shared/sources.ts): everything kind-specific (its query language, its types, how
// it stays read-only) is inside it. The server picks one per configured source by its kind
// (connectors/index.ts; the kinds and their fields: kinds.ts). Only reading: a connector never writes.

/** One configured source (from the server's settings: server/src/settings.ts). */
export interface SourceConfig {
  /** As configured, e.g. "CRM". */
  name: string;
  /** Names it had before: it is still asked for by them (collections made under one). */
  formerNames?: string[];
  /** Its kind (kinds.ts): picks the connector. */
  kind: string;
  /** That kind's fields, e.g. { host, port, database, user, ssl } (kinds.ts). */
  fields: Record<string, string>;
  /** Its password, API key or token ("": none). */
  password: string;
  /** Only these schemas' tables are offered (n8n: these projects' ids; InfluxDB: buckets; empty: all but the system's). */
  schemas: string[];
  /** Longest a statement may run, in milliseconds. */
  timeoutMs: number;
}

export interface Connector {
  /** For people, e.g. "postgres". */
  readonly kind: string;
  /** Checks the connection once at start; returns warnings to log (e.g. a user that can write). */
  check(): Promise<string[]>;
  tables(): Promise<SourceTable[]>;
  describe(target: SourceTarget): Promise<SourceDescription>;
  query(query: SourceQuery): Promise<SourceResult>;
  row(request: SourceRowRequest): Promise<SourceRow | null>;
  close(): Promise<void>;
}

/** A request the source can't answer as asked (an unknown column, a query that isn't allowed): 400, not 500. */
export class SourceError extends Error {}
