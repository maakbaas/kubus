/// <reference lib="webworker" />
// Owns the single SQLite connection. Runs in a dedicated worker because the
// OPFS SAH-pool VFS needs synchronous file handles, which only exist in workers.

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { SqliteEngine } from "./engine";
import type { OpenResult, Request, Response } from "./protocol";

const DB_FILE = "/kubus.sqlite3";
const POOL_NAME = "kubus-sahpool";
const POOL_DIR = `.${POOL_NAME}`; // the SAH pool's default directory for this name

let engine: SqliteEngine | null = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const OTHER_TAB = "Kubus is open in another tab or window. Close it there and reload.";

/**
 * Whether another live Kubus worker holds the lock: the holder answers a ping. A reloading page's
 * previous worker is gone by then and doesn't answer, so that case keeps waiting for the lock.
 */
function holderAnswers(timeoutMs = 400): Promise<boolean> {
  if (typeof BroadcastChannel === "undefined") return Promise.resolve(false);
  return new Promise((resolve) => {
    const channel = new BroadcastChannel("kubus-db");
    const done = (answered: boolean) => {
      clearTimeout(timer);
      channel.close();
      resolve(answered);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    channel.onmessage = (e) => e.data === "pong" && done(true);
    channel.postMessage("ping");
  });
}

/**
 * Exclusive lock on the database for this worker's whole lifetime. A reloading
 * page's previous worker may still hold it for a moment; we wait for it. A
 * second tab is told at once (the holder answers); should it not answer, it waits up to
 * `timeoutMs`, then gives up without touching the files.
 */
function acquireDbLock(timeoutMs = 10_000): Promise<void> {
  if (!("locks" in navigator)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const held = () => {
      clearTimeout(timer);
      resolve();
      // Answer other tabs' pings for as long as the lock is held.
      if (typeof BroadcastChannel !== "undefined") {
        const channel = new BroadcastChannel("kubus-db");
        channel.onmessage = (e) => e.data === "ping" && channel.postMessage("pong");
      }
      return new Promise<void>(() => {}); // held until the worker terminates
    };
    navigator.locks
      .request("kubus-db", { ifAvailable: true }, (lock) => {
        if (lock) return held();
        // Taken: by another tab (say so now) or by a page that is reloading (wait for it).
        return holderAnswers().then((answered) => {
          if (answered) throw new Error(OTHER_TAB);
          timer = setTimeout(() => controller.abort(), timeoutMs);
          return navigator.locks.request("kubus-db", { signal: controller.signal }, held);
        });
      })
      .catch((e) => reject(e instanceof Error && e.message === OTHER_TAB ? e : new Error(OTHER_TAB)));
  });
}

/** True when every file of the SAH pool can be opened, i.e. no other worker still holds one. */
async function poolFilesFree(): Promise<boolean> {
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(POOL_DIR);
  } catch {
    return true; // no pool yet
  }
  const probe = async (d: FileSystemDirectoryHandle): Promise<boolean> => {
    for await (const handle of (d as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
      if (handle.kind === "directory") {
        if (!(await probe(handle as FileSystemDirectoryHandle))) return false;
        continue;
      }
      try {
        const access = await (handle as FileSystemFileHandle).createSyncAccessHandle();
        access.close();
      } catch {
        return false;
      }
    }
    return true;
  };
  return probe(dir);
}

async function open(): Promise<OpenResult> {
  const sqlite3 = await sqlite3InitModule();
  let db;
  let persistent = false;
  if ("storage" in navigator && "getDirectory" in navigator.storage) {
    // DANGER: if installOpfsSAHPoolVfs() cannot open a pool file (because another
    // worker still holds it), its error handling deletes the pool directory, i.e.
    // the database. So only install once we hold the lock AND every file is free.
    await acquireDbLock();
    let free = false;
    for (let attempt = 0; attempt < 50 && !free; attempt++) {
      free = await poolFilesFree();
      if (!free) await sleep(100);
    }
    if (!free) throw new Error("The database is still in use by another Kubus window. Close it and reload.");
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: POOL_NAME });
    db = new pool.OpfsSAHPoolDb(DB_FILE);
    persistent = true;
  } else {
    db = new sqlite3.oo1.DB(":memory:", "c");
  }
  engine = new SqliteEngine(sqlite3, db);
  return { persistent, sqliteVersion: engine.version };
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const req = event.data;
  let res: Response;
  try {
    if (req.op === "open") {
      res = { id: req.id, ok: true, result: engine ? null : await open() };
    } else if (!engine) {
      throw new Error("Database not open");
    } else if (req.op === "wipe") {
      engine.wipe();
      res = { id: req.id, ok: true, result: null };
    } else if (req.op === "select") {
      res = { id: req.id, ok: true, result: engine.select(req.sql, req.bind) };
    } else {
      engine.write(req.statements);
      res = { id: req.id, ok: true, result: null };
    }
  } catch (e) {
    res = { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  self.postMessage(res);
};
