import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The unit and integration tests (`npm test`), one project per part of the app, so a change runs
// only the tests of what it touched: `npm test -- --project sync`, or `npm run test:changed` for the
// tests that import a changed file. docs/testing.md says which project covers what.
//
// connectors and server test server/ code, which needs the server's packages (`npm ci` in server/);
// without them they are left out, with a note. server's tests also need Postgres (KUBUS_TEST_POSTGRES,
// server/test/postgres.ts); without it they are skipped, except in CI.

// Coverage slows the code down (and the machine is often busy): more time per test. The server's and the
// connectors' tests start real servers and databases: their timeout only guards against a hang.
const coverage = process.argv.includes("--coverage");
const project = (name: string, include: string[], timeout = 5_000) => ({
  test: { name, include, environment: "node", testTimeout: coverage ? Math.max(timeout, 20_000) : timeout },
});

const serverInstalled = existsSync(new URL("server/node_modules/pg", import.meta.url));
if (!serverInstalled) console.warn("The connectors and server tests are left out: install the server's packages (npm ci in server/)");

// `npm run test:coverage` writes V8 coverage as istanbul json to coverage/unit; tests/coverage.mjs merges
// it with the GUI suite's. The real server the HTTP tests start is a child process: with KUBUS_V8_DIR
// set, server/test/serve.ts has it dump its V8 coverage there, and tests/coverage.mjs adds it.
if (process.argv.includes("--coverage") && !process.env.KUBUS_V8_DIR) {
  process.env.KUBUS_V8_DIR = fileURLToPath(new URL("coverage/server-v8", import.meta.url));
  rmSync(process.env.KUBUS_V8_DIR, { recursive: true, force: true });
}
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage/unit",
      reporter: ["json", "text-summary"],
      reportOnFailure: true,
      include: ["app/src/**", "server/src/**", "shared/**"],
      exclude: ["**/*.test.{ts,tsx}", "app/src/test/**", "**/*.{css,md,sql,d.ts}"],
    },
    projects: [
      project("domain", ["app/src/domain/**/*.test.ts"]),
      project("storage", ["app/src/data/*.test.ts", "app/src/data/sqlite/**/*.test.ts"]),
      project("sync", ["app/src/data/sync/**/*.test.ts", "app/src/data/remote/**/*.test.ts"]),
      project("api", ["app/src/headless/**/*.test.ts"]),
      project("app", ["app/src/{app,platform,ui,views,pages,workspace,test}/**/*.test.{ts,tsx}"]),
      ...(serverInstalled
        ? [project("connectors", ["server/test/connectors/**/*.test.ts"], 30_000), project("server", ["server/test/*.test.ts"], 30_000)]
        : []),
    ],
  },
});
