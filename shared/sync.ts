// The sync protocol shared by the app (app/src/data/sync) and the server (server/src): which
// tables replicate, their columns and types, and the request / response shapes. Types and
// constants only (no imports, no enums), so the server can run it directly with Node.
//
// Whenever a table or column in app/src/data/schema.sql changes, change this list and
// server/schema.sql too (app/src/data/sync/spec.test.ts fails until they agree).

/** Maps to SQLite / Postgres: text, number = real / double precision, int, bool = 0|1 / boolean,
 *  json = text / jsonb, date = text YYYY-MM-DD / date, timestamp = ISO text / timestamptz,
 *  bytes = blob / bytea. On the wire: text, number, 0|1, JSON text, base64. */
export type ColumnType = "text" | "number" | "int" | "bool" | "json" | "date" | "timestamp" | "bytes";

export interface SyncTable {
  name: string;
  /** Primary key columns. A row's identity in the outbox is its key values (JSON array if composite). */
  key: string[];
  /** Newest `updated_at` wins. null = immutable rows, insert only (content-addressed files). */
  version: "updated_at" | null;
  columns: Record<string, ColumnType>;
}

const stamps = { created_at: "timestamp", updated_at: "timestamp", deleted_at: "timestamp" } as const;

/** In foreign-key order (referenced tables first). `meta` and the outbox are local only. */
export const SYNC_TABLES: SyncTable[] = [
  {
    name: "spaces",
    key: ["id"],
    version: "updated_at",
    columns: { id: "text", name: "text", icon: "text", position: "int", ...stamps },
  },
  {
    name: "collections",
    key: ["id"],
    version: "updated_at",
    columns: {
      id: "text", name: "text", plural_name: "text", icon: "text", description: "text", item_views: "json",
      space_ids: "json", ...stamps,
    },
  },
  {
    name: "components",
    key: ["id"],
    version: "updated_at",
    columns: {
      id: "text", name: "text", description: "text", params: "json", code: "text", output: "text", frame_ratio: "text", ...stamps,
    },
  },
  {
    name: "fields",
    key: ["id"],
    version: "updated_at",
    columns: {
      id: "text", collection_id: "text", name: "text", kind: "text", target_collection_id: "text", component_id: "text",
      component_args: "json", choice_filter: "json", toggle_icon: "text", ai_prompt: "text", ai_output: "text", position: "int", ...stamps,
    },
  },
  {
    name: "views",
    key: ["id"],
    version: "updated_at",
    columns: {
      id: "text", collection_id: "text", space_id: "text", name: "text", kind: "text", config: "json", position: "int",
      is_default: "int", ...stamps,
    },
  },
  {
    name: "items",
    key: ["id"],
    version: "updated_at",
    columns: { id: "text", collection_id: "text", space_id: "text", item_view_id: "text", ...stamps },
  },
  {
    name: "files",
    key: ["id"],
    version: null,
    columns: { id: "text", mime: "text", size: "int", data: "bytes", created_at: "timestamp" },
  },
  {
    name: "field_values",
    key: ["item_id", "field_id"],
    version: "updated_at",
    columns: {
      item_id: "text", field_id: "text", value_text: "text", value_number: "number", value_date: "date",
      value_datetime: "timestamp", value_bool: "bool", value_ref: "text", value_file: "text", value_json: "json",
      updated_at: "timestamp",
    },
  },
  {
    name: "bookmarks",
    key: ["id"],
    version: "updated_at",
    columns: {
      id: "text", kind: "text", collection_id: "text", space_id: "text", target_id: "text", label: "text", position: "int",
      ...stamps,
    },
  },
];

export type WireValue = string | number | null;
/** One row on the wire: column name to value (bool as 0 / 1, json as text, bytes as base64). */
export type WireRow = Record<string, WireValue>;
/** Rows by table name. */
export type WireChanges = Record<string, WireRow[]>;

export interface SyncRequest {
  /** The highest server sequence number this device has already received (0 = nothing yet). */
  since: number;
  /** Rows changed on the device since its last successful sync. */
  changes: WireChanges;
}
export interface SyncResponse {
  /** Pass as `since` next time. */
  cursor: number;
  /** Rows changed on the server after `since` (including the ones just pushed). */
  changes: WireChanges;
}
