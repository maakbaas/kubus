import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Headless, HeadlessOptions, StartHeadless } from "../../shared/api.ts";
import { SYNC_VERSION } from "../../shared/sync.ts";

// Loads the headless device (app/src/headless, built into ../headless by `npm run build:headless`)
// that answers /api/v1. Without the bundle the rest of the server works as before and /api/v1
// says how to build it.

const BUNDLE = join(import.meta.dirname, "../headless/index.js");
const RETRY_MS = 30_000;

export class HeadlessHost {
  device: Headless | null = null;
  /** Why there is no device (yet). */
  problem = "The API is starting";
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  /** Starts the device (it syncs with this server, so the server must be listening); retries on failure. */
  async start(options: HeadlessOptions): Promise<void> {
    if (!existsSync(BUNDLE)) {
      this.problem = "The API isn't built: run `npm run build:headless` in the repository, then restart the server";
      options.log(this.problem);
      return;
    }
    try {
      const { startHeadless, syncVersion } = (await import(pathToFileURL(BUNDLE).href)) as { startHeadless: StartHeadless; syncVersion?: number };
      // Built from another version of the app (a stale bundle after an update): it would be refused by this server's strict gate.
      if (syncVersion !== SYNC_VERSION) {
        throw new Error(`The built API is for sync version ${syncVersion ?? "?"}, this server's is ${SYNC_VERSION}: run \`npm run build:headless\` and restart the server`);
      }
      this.device = await startHeadless(options);
      options.log("API ready at /api/v1");
    } catch (e) {
      this.problem = `The API couldn't start: ${e instanceof Error ? e.message : String(e)}`;
      options.log(`${this.problem} (trying again in ${RETRY_MS / 1000} s)`);
      if (!this.stopped) {
        this.retry = setTimeout(() => void this.start(options), RETRY_MS);
        this.retry.unref();
      }
    }
  }

  /** The server is stopping: the device saves its database (when it has a directory) and lets go of it. */
  async close(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    await this.device?.close();
  }
}
