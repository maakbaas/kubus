// Tests against a real MySQL and MariaDB: KUBUS_TEST_MYSQL (MySQL 8) and KUBUS_TEST_MARIADB name an
// account that can create databases and users, e.g. mysql://root:root@127.0.0.1:3306. Each test file
// makes its own database (and drops it again). Without one its tests are skipped, except in CI,
// which runs both: there a missing server is an error, not a silent skip.
import mysql from "mysql2/promise";

export const SERVERS = { mysql: process.env.KUBUS_TEST_MYSQL, mariadb: process.env.KUBUS_TEST_MARIADB };
if ((!SERVERS.mysql || !SERVERS.mariadb) && process.env.CI) {
  throw new Error("KUBUS_TEST_MYSQL or KUBUS_TEST_MARIADB isn't set: CI runs the MySQL connector's tests against MySQL 8 and MariaDB");
}

/** Runs SQL (several statements) as the admin of `url`, in `database` if given; no sql_mode (a fixture may hold zero dates), UTC. */
export async function admin(url: string, sql: string, database?: string): Promise<void> {
  const c = await mysql.createConnection({ uri: url, database, multipleStatements: true });
  try {
    await c.query(`SET sql_mode = '', time_zone = '+00:00'; ${sql}`);
  } finally {
    await c.end();
  }
}

/** `database` as a source's kind, fields and password (server/src/connectors/kinds.ts), as the admin or as `user`. */
export function sourceFor(kind: "mysql" | "mariadb", url: string, database: string, user?: { name: string; password: string }) {
  const u = new URL(url);
  return {
    kind,
    fields: { host: u.hostname, port: u.port, database, user: user?.name ?? decodeURIComponent(u.username), ssl: "" },
    password: user?.password ?? decodeURIComponent(u.password),
  };
}

/** A new, empty database (one left over from an interrupted run is dropped first). */
export async function createDatabase(url: string, name: string): Promise<void> {
  await admin(url, `DROP DATABASE IF EXISTS \`${name}\`; CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
}

export async function dropDatabase(url: string, name: string): Promise<void> {
  await admin(url, `DROP DATABASE IF EXISTS \`${name}\``);
}
