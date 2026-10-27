import type { Bind, OpenResult, Request, Response, Statement } from "./protocol";

type Pending = { resolve(v: unknown): void; reject(e: Error): void };
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** Every worker started by this module, so they can be shut down (and release the database lock). */
const workers = new Set<Worker>();

/** Terminates all database workers; their lock is released with them. */
export function terminateWorkers() {
  workers.forEach((w) => w.terminate());
  workers.clear();
}

// Dev: when this module is hot-replaced, shut its workers down first.
import.meta.hot?.dispose(() => terminateWorkers());

/** Promise-based RPC to the worker. */
class WorkerChannel {
  private worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor() {
    workers.add(this.worker);
    this.worker.onmessage = (e: MessageEvent<Response>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(new Error(e.data.error));
    };
  }

  send(req: DistributiveOmit<Request, "id">): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...req, id });
    });
  }
}

/** Handle on the SQLite database living in the worker. */
export class SqlClient {
  private constructor(
    private channel: WorkerChannel,
    readonly info: OpenResult,
  ) {}

  static async open(): Promise<SqlClient> {
    const channel = new WorkerChannel();
    const info = (await channel.send({ op: "open" })) as OpenResult;
    return new SqlClient(channel, info);
  }

  select<T>(sql: string, bind?: Bind): Promise<T[]> {
    return this.channel.send({ op: "select", sql, bind }) as Promise<T[]>;
  }

  /** Drops all data: every table empty, as in a new database. */
  async wipe(): Promise<void> {
    await this.channel.send({ op: "wipe" });
  }

  /** Executes all statements in a single transaction. */
  async write(statements: Statement[]): Promise<void> {
    if (statements.length > 0) await this.channel.send({ op: "write", statements });
  }
}
