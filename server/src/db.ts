import pg from "pg";

// Keep dates and timestamps as the strings the app stores (pg would build local-time Dates), and
// sequence numbers (bigint) as numbers.
pg.types.setTypeParser(1082, (v) => v); // date: YYYY-MM-DD
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString()); // timestamptz: ISO 8601 UTC
pg.types.setTypeParser(20, (v) => Number(v)); // bigint

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 5 });
}
