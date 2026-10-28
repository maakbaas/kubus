/// <reference lib="webworker" />
// Owns the single SQLite connection. Runs in a dedicated worker because the
// OPFS SAH-pool VFS needs synchronous file handles, which only exist in workers.

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { acquireDbLock, POOL_NAME, waitForPoolFiles } from "./dbLock";
import { SqliteEngine } from "./engine";
import type { OpenResult, Request, Response } from "./protocol";

const DB_FILE = "/kubus.sqlite3";

let engine: SqliteEngine | null = null;

async function open(): Promise<OpenResult> {
  const sqlite3 = await sqlite3InitModule();
  let db;
  let persistent = false;
  if ("storage" in navigator && "getDirectory" in navigator.storage) {
    // DANGER: if installOpfsSAHPoolVfs() cannot open a pool file (because another
    // worker still holds it), its error handling deletes the pool directory, i.e.
    // the database. So only install once we hold the lock AND every file is free.
    await acquireDbLock();
    if (!(await waitForPoolFiles())) throw new Error("The database is still in use by another Kubus window. Close it and reload.");
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
