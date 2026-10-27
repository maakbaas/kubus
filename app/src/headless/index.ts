// The headless device: the app's own repository and sync engine inside the server process, with
// an in-memory database, so the HTTP API (/api/v1) follows exactly the rules the GUI does. It is
// one more synced device: it syncs with the server over HTTP like the others, hears their changes
// through /api/events, and its own writes reach them through sync. Bundled for Node by
// `npm run build:headless` (app/vite.headless.config.ts) into server/headless, which the server
// loads (server/src/headless.ts). See docs/sync.md, "The API".

import type { HeadlessOptions, StartHeadless } from "../../../shared/api";
import type { ApiRequest, ApiResponse } from "../../../shared/router";
import { HttpError, json } from "../../../shared/router";
import { DirectSqlClient } from "../data/sqlite/direct";
import { SqliteRepository } from "../data/sqlite/SqliteRepository";
import { memoryEnvironment } from "../data/sync/environment";
import { setCompiler } from "../domain/components";
import { createApi } from "./api";
import { contextCompiler } from "./compiler";
import { Webhooks } from "./webhooks";

export class HeadlessDevice {
  private queue: Promise<unknown> = Promise.resolve();
  readonly webhooks: Webhooks;

  private constructor(
    readonly repo: SqliteRepository,
    private options: HeadlessOptions,
  ) {
    this.webhooks = new Webhooks(repo, options.webhooks, options.log);
    this.webhooks.attach();
    // The server's database was wiped or replaced: this device holds nothing it must keep (it is
    // a cache of the server), so it starts over with what the server holds now.
    repo.sync.subscribe(() => {
      if (repo.sync.status.replaced) void this.serial(() => this.reset());
    });
  }

  /** Opens an empty device and connects it: its first sync downloads everything (but file bytes). */
  static async start(options: HeadlessOptions): Promise<HeadlessDevice> {
    setCompiler(contextCompiler);
    const repo = await SqliteRepository.open(await DirectSqlClient.open(), memoryEnvironment({ keepFiles: false }));
    const device = new HeadlessDevice(repo, options);
    await device.serial(() => device.connect());
    return device;
  }

  private async connect() {
    const { serverUrl: url, token } = this.options;
    await this.repo.sync.configure({ url, token, enabled: true, originals: "opened" });
    this.check();
  }

  private async reset() {
    if (!this.repo.sync.status.replaced) return;
    this.options.log("The server's database was replaced: the headless device starts over");
    await this.repo.wipeLocal();
    await this.connect();
  }

  /** Throws (503) unless the last sync worked. */
  private check() {
    const { state, error } = this.repo.sync.status;
    if (state === "error") throw new HttpError(503, `The server's headless device can't sync: ${error}`);
  }

  /**
   * Brings this device up to date with the server: no request when it is already (the server
   * says so), unless it has a write of its own to send (`push`).
   */
  async refresh(push = false) {
    if (push) await this.repo.sync.syncNow();
    else await this.repo.sync.catchUp(this.options.cursor());
    if (this.repo.sync.status.replaced) await this.reset();
    this.check();
  }

  /** Runs tasks one at a time, in order. */
  serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }
}

export const startHeadless: StartHeadless = async (options) => {
  const device = await HeadlessDevice.start(options);
  const api = createApi(device.repo);
  return {
    handle: (req: ApiRequest): Promise<ApiResponse> =>
      device.serial(async () => {
        try {
          await device.refresh(); // reads see the latest data
          const response = await api.handle(req);
          // A write is on the server (and on its way to every device) when the answer arrives.
          if (req.method !== "GET" && response.status < 400) await device.refresh(true);
          return response;
        } catch (e) {
          if (e instanceof HttpError) return json(e.status, { error: e.message });
          throw e;
        }
      }),
  };
};
