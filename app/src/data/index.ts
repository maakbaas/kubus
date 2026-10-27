import type { Repository } from "./repository";
import { terminateWorkers, WorkerSqlClient } from "./sqlite/client";
import { SqliteRepository } from "./sqlite/SqliteRepository";
import { browserEnvironment } from "./sync/environment";

export type { Repository } from "./repository";

// One database connection (= one worker holding the database lock) per page. Opening
// twice, e.g. because React StrictMode mounts the store twice in development, would make
// the second worker wait for the first's lock and fail with "open in another tab".
let opening: Promise<Repository> | null = null;

/** Same code path in the Tauri shell and in a plain browser / home-screen web app. */
export function openRepository(): Promise<Repository> {
  opening ??= (async () => {
    // Ask the browser not to evict our storage (matters most on iOS Safari).
    await navigator.storage?.persist?.().catch(() => false);
    return SqliteRepository.open(await WorkerSqlClient.open(), browserEnvironment);
  })();
  opening.catch(() => (opening = null)); // allow a retry (e.g. after closing another tab)
  return opening;
}

// Dev: when this module is hot-replaced, shut the old worker down so it releases the lock.
import.meta.hot?.dispose(() => terminateWorkers());
