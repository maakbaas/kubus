// The real server (node src/index.ts, as the image runs it) in a child process, on a free port,
// against a test database: for the tests of its HTTP endpoints and of devices syncing with it.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

export const TOKEN = "test-token";

/** Whether the headless device is built (npm run build:headless): without it /api/v1 answers 503. */
export const HEADLESS_BUILT = existsSync(join(import.meta.dirname, "../headless/index.js"));
if (!HEADLESS_BUILT && process.env.CI) throw new Error("The headless device isn't built: CI runs npm run build:headless before the server's tests");

export interface RunningServer {
  url: string;
  /** What it printed so far (stdout and stderr). */
  output(): string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/** Starts a server on `databaseUrl`; resolves once it answers. */
export async function startServer(databaseUrl: string, env: Record<string, string> = {}): Promise<RunningServer> {
  const port = await freePort();
  // Under coverage (vitest.config.ts sets KUBUS_V8_DIR) the server leaves its V8 coverage there when it exits
  // (stop() sends SIGTERM, on which it shuts down and exits).
  const dump = process.env.KUBUS_V8_DIR;
  const child = spawn(process.execPath, [join(import.meta.dirname, "../src/index.ts")], {
    env: { ...process.env, DATABASE_URL: databaseUrl, KUBUS_TOKEN: TOKEN, PORT: String(port), ...(dump ? { NODE_V8_COVERAGE: dump } : {}), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const url = `http://127.0.0.1:${port}`;
  const server: RunningServer = {
    url,
    output: () => output,
    async stop() {
      if (child.exitCode === null) child.kill();
      await exited;
    },
  };
  for (const started = Date.now(); Date.now() - started < 15_000; await new Promise((r) => setTimeout(r, 50))) {
    if (child.exitCode !== null) throw new Error(`The server exited (${child.exitCode}):\n${output}`);
    if (await fetch(`${url}/api/health`).then((r) => r.ok, () => false)) return server;
  }
  await server.stop();
  throw new Error(`The server didn't start:\n${output}`);
}

/** A request to the server with the token (or another `Authorization`). */
export function request(server: RunningServer, path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${TOKEN}`);
  if (json !== undefined) headers.set("Content-Type", "application/json");
  return fetch(`${server.url}${path}`, { ...rest, headers, ...(json !== undefined && { body: JSON.stringify(json) }) });
}
