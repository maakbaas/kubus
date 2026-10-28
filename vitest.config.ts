import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// The unit and integration tests (`npm test`), one project per part of the app, so a change runs
// only the tests of what it touched: `npm test -- --project sync`, or `npm run test:changed` for the
// tests that import a changed file. docs/testing.md says which project covers what.
//
// connectors and server test server/ code, which needs the server's packages (`npm ci` in server/);
// without them they are left out, with a note. server's tests also need Postgres (KUBUS_TEST_POSTGRES,
// server/test/postgres.ts); without it they are skipped, except in CI.
const project = (name: string, include: string[]) => ({ test: { name, include, environment: "node" } });

const serverInstalled = existsSync(new URL("server/node_modules/pg", import.meta.url));
if (!serverInstalled) console.warn("The connectors and server tests are left out: install the server's packages (npm ci in server/)");

export default defineConfig({
  test: {
    projects: [
      project("domain", ["app/src/domain/**/*.test.ts"]),
      project("storage", ["app/src/data/*.test.ts", "app/src/data/sqlite/**/*.test.ts"]),
      project("sync", ["app/src/data/sync/**/*.test.ts", "app/src/data/remote/**/*.test.ts"]),
      project("api", ["app/src/headless/**/*.test.ts"]),
      project("app", ["app/src/{app,platform,ui,views,pages,workspace}/**/*.test.{ts,tsx}"]),
      ...(serverInstalled
        ? [project("connectors", ["server/test/connectors/**/*.test.ts"]), project("server", ["server/test/*.test.ts"])]
        : []),
    ],
  },
});
