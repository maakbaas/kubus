// Tests against a real Postgres: KUBUS_TEST_POSTGRES names a superuser's connection string, e.g.
// postgres://postgres:postgres@localhost:5432/postgres. Each test file makes its own database (and
// drops it again). Without it they are skipped, except in CI, which runs them: there a missing
// database is an error, not a silent skip.
import pg from "pg";

export const ADMIN = process.env.KUBUS_TEST_POSTGRES;
if (!ADMIN && process.env.CI) throw new Error("KUBUS_TEST_POSTGRES isn't set: CI runs the server's tests against Postgres");

/** Runs SQL as the superuser, in the database it names (or `database`). */
export async function admin(sql: string, database?: string): Promise<void> {
  const c = new pg.Client({ connectionString: database ? urlFor(database) : ADMIN! });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

/** The connection string of `database`, as the superuser or as `user`. */
export function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = new URL(ADMIN!);
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  url.pathname = `/${database}`;
  return url.toString();
}

/** `database` as a source's kind, fields and password (server/src/connectors/kinds.ts), as the superuser or as `user`. */
export function sourceFor(database: string, user?: { name: string; password: string }) {
  const url = new URL(urlFor(database, user));
  return {
    kind: "postgres",
    fields: { host: url.hostname, port: url.port, database, user: decodeURIComponent(url.username), ssl: "" },
    password: decodeURIComponent(url.password),
  };
}

/** A new, empty database (one left over from an interrupted run is dropped first); its connection string. */
export async function createDatabase(name: string): Promise<string> {
  await dropDatabase(name);
  await admin(`CREATE DATABASE ${name}`);
  return urlFor(name);
}

export async function dropDatabase(name: string): Promise<void> {
  await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
}
