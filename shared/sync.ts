// The sync protocol shared by the app (app/src/data/sync) and the server (server/src): which
// tables replicate, their columns and types, and the request / response shapes. Types and
// constants only (no imports, no enums), so the server can run it directly with Node.
//
// Whenever a table or column in app/src/data/schema.sql changes, change this list too
// (app/src/data/sync/spec.test.ts fails until they agree): the device's outbox triggers
// (app/src/data/schema.ts) and the server's tables (server/src/schema.ts) are made from it.
// Every change to it (or to what a synced value may hold) raises SYNC_VERSION: see docs/migrations.md.

/**
 * The version of the synced data's shape: this list and what its values may hold. Raised with
 * every change to them (app/src/data/sync/spec.test.ts fails until it is). The gate is strict:
 * a device and a server sync only when their versions are equal, in both directions (the server
 * answers 426 `SyncOutdated` to a device of another version and writes nothing), so every release
 * with a sync change is rolled out to the server and all devices together: docs/migrations.md.
 */
export const SYNC_VERSION = 4;

/** Maps to SQLite / Postgres: text, number = real / double precision, int, bool = 0|1 / boolean,
 *  json = text / jsonb, date = text YYYY-MM-DD / date, timestamp = ISO text / timestamptz,
 *  On the wire: text, number, 0|1, JSON text. File bytes don't travel as rows: see /api/files
 *  (server/src/files.ts) and the sync engine. */
export type ColumnType = "text" | "number" | "int" | "bool" | "json" | "date" | "timestamp";

export interface SyncTable {
  name: string;
  /** Primary key columns. A row's identity in the outbox is its key values (JSON array if composite). */
  key: string[];
  /** Newest `updated_at` wins. null = immutable rows, insert only (content-addressed files). */
  version: "updated_at" | null;
  columns: Record<string, ColumnType>;
  /**
   * The value of a column added after the first release (SYNC_VERSION 1) for rows written without it
   * (before it existed): the server's column default, and what a device stores
   * for such a row's null when its own column is NOT NULL. Not needed for a nullable column.
   */
  defaults?: Record<string, WireValue>;
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
      space_ids: "json", source: "json", title_field: "text", hidden_in_nav: "int", ...stamps,
    },
  },
  {
    name: "components",
    key: ["id"],
    version: "updated_at",
    columns: {
      id: "text", name: "text", description: "text", code: "text", output: "text", frame_ratio: "text", ai: "int", ...stamps,
    },
  },
  {
    name: "dashboards",
    key: ["id"],
    version: "updated_at",
    columns: { id: "text", name: "text", icon: "text", description: "text", space_ids: "json", position: "int", ...stamps },
  },
  {
    name: "dashboard_views",
    key: ["id"],
    version: "updated_at",
    columns: {
      id: "text", dashboard_id: "text", space_id: "text", name: "text", config: "json", position: "int", is_default: "int", ...stamps,
    },
  },
  {
    name: "fields",
    key: ["id"],
    version: "updated_at",
    columns: {
      id: "text", collection_id: "text", name: "text", kind: "text", target_collection_id: "text", component_id: "text",
      code: "text", output: "text", frame_ratio: "text", choice_filter: "json", toggle_icon: "text", strike_through: "int", source_column: "text",
      position: "int", ...stamps,
    },
  },
  {
    name: "views",
    key: ["id"],
    version: "updated_at",
    columns: {
      id: "text", collection_id: "text", space_id: "text", name: "text", config: "json", position: "int",
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
    // The bytes are the local-only column `data` on a device, `file_bytes` on the server.
    columns: { id: "text", mime: "text", size: "int", created_at: "timestamp" },
  },
  {
    name: "thumbnails",
    key: ["file_id"],
    version: null,
    columns: { file_id: "text", thumb_id: "text", created_at: "timestamp" },
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
    // Derived from field_values (the links in a value), with the value's own id and updated_at so it merges to the
    // same version as the value: every device writes it with its values (a first download heals a server filled before it existed).
    name: "item_links",
    key: ["id"],
    version: "updated_at",
    columns: { id: "text", source_item_id: "text", source_field_id: "text", targets: "json", updated_at: "timestamp", deleted_at: "timestamp" },
  },
  {
    name: "bookmarks",
    key: ["id"],
    version: "updated_at",
    columns: {
      id: "text", kind: "text", collection_id: "text", space_id: "text", target_id: "text", label: "text", position: "int",
      ...stamps, dashboard_id: "text",
    },
  },
];

export type WireValue = string | number | null;
/** One row on the wire: column name to value (bool as 0 / 1, json as text). */
export type WireRow = Record<string, WireValue>;
/** Rows by table name. */
export type WireChanges = Record<string, WireRow[]>;

/**
 * Which database a server holds: a random id made with the database (a wipe, a new volume or
 * another database gives a new one), and when that was, for people.
 */
export interface DatabaseInfo {
  id: string;
  createdAt: string;
}

export interface SyncRequest {
  /** The highest server sequence number this device has already received (0 = nothing yet). */
  since: number;
  /** Rows changed on the device since its last successful sync. */
  changes: WireChanges;
  /**
   * The id of the server database this device synced with (absent: none yet).
   * Another one there: nothing is written and the server answers 409 with a `SyncMismatch`.
   */
  database?: string;
  /** The device's SYNC_VERSION (missing: a device from before versions, 0). */
  version: number;
}
export interface SyncResponse {
  /** Pass as `since` next time. */
  cursor: number;
  /**
   * Rows changed on the server after `since`, but for the ones this request wrote: the device
   * has those already (its own changes), and `cursor` covers them.
   */
  changes: WireChanges;
  /** The server's database. */
  database: DatabaseInfo;
  /** The server's SYNC_VERSION: always the device's (otherwise the answer is a 426 `SyncOutdated`). */
  version?: number;
  /**
   * Files the pushed rows use whose bytes the server doesn't have (deleted as unused meanwhile):
   * a device that has them queues them again.
   */
  missingFiles?: string[];
}
/** The 409 answer when the device synced with another database than the server holds now. */
export interface SyncMismatch {
  error: string;
  database: DatabaseInfo;
  /** The server holds no rows at all (as after a wipe). */
  empty: boolean;
}

/**
 * The 426 answer: this device and the server have different SYNC_VERSIONs, so they can't sync
 * until the older one is updated (nothing was written). `update` says which: `app` when the
 * device is older than the server, `server` when the server is older than the device. `version`
 * is the server's SYNC_VERSION.
 */
export interface SyncOutdated {
  error: string;
  update: "app" | "server";
  version?: number;
}

/** The largest file a device stores and the server accepts (PUT /api/files/<id>). */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
