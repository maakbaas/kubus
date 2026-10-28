// @vitest-environment node
// File bytes (src/files.ts) against a real database (KUBUS_TEST_POSTGRES: ./postgres.ts).
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WireChanges } from "../../shared/sync.ts";
import { deleteFile, getFile, hasFile, missingFiles, putFile, sha256 } from "../src/files.ts";
import { loadSchema } from "../src/schema.ts";
import { ADMIN, createDatabase, dropDatabase } from "./postgres.ts";

const DB = "kubus_files_test";

describe.skipIf(!ADMIN)("file bytes", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await createDatabase(DB) });
    await pool.query(await loadSchema());
  });
  afterAll(async () => {
    await pool?.end();
    await dropDatabase(DB);
  });
  beforeEach(async () => {
    await pool.query("DELETE FROM file_bytes");
  });

  const bytes = (text: string) => Buffer.from(text);
  const value = (item_id: string, over: Record<string, string | null> = {}) => ({ item_id, field_id: "f", value_text: null, value_file: null, ...over });
  const missing = async (changes: WireChanges) => {
    const client = await pool.connect();
    try {
      return (await missingFiles(client, changes)).sort();
    } finally {
      client.release();
    }
  };

  it("names a file by the SHA-256 of its bytes", () => {
    expect(sha256(bytes("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256(Buffer.alloc(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("stores the bytes under their id, and serves them with their type", async () => {
    const data = Buffer.from([0, 1, 2, 255, 254]);
    const id = sha256(data);
    expect(await hasFile(pool, id)).toBe(false);
    expect(await getFile(pool, id)).toBeNull();
    expect(await putFile(pool, id, "image/png", data)).toBe(true);
    expect(await hasFile(pool, id)).toBe(true);
    const file = await getFile(pool, id);
    expect(file?.mime).toBe("image/png");
    expect(file?.data.equals(data)).toBe(true);
  });

  it("refuses bytes that aren't the file their id names, wrong or cut off, and stores nothing", async () => {
    const id = sha256(bytes("whole file"));
    expect(await putFile(pool, id, "text/plain", bytes("whole fil"))).toBe(false);
    expect(await putFile(pool, id, "text/plain", Buffer.alloc(0))).toBe(false);
    expect(await putFile(pool, "not-a-hash", "text/plain", bytes("x"))).toBe(false);
    expect((await pool.query("SELECT count(*)::int AS n FROM file_bytes")).rows).toEqual([{ n: 0 }]);
  });

  it("keeps the first copy when the same file is stored again", async () => {
    const data = bytes("same");
    const id = sha256(data);
    await putFile(pool, id, "text/plain", data);
    expect(await putFile(pool, id, "application/other", data)).toBe(true);
    expect((await getFile(pool, id))?.mime).toBe("text/plain");
  });

  it("stores an empty file", async () => {
    const id = sha256(Buffer.alloc(0));
    expect(await putFile(pool, id, "application/octet-stream", Buffer.alloc(0))).toBe(true);
    expect((await getFile(pool, id))?.data.length).toBe(0);
  });

  it("deletes the bytes, and doesn't mind a file that isn't there", async () => {
    const data = bytes("gone");
    const id = sha256(data);
    await putFile(pool, id, "text/plain", data);
    await deleteFile(pool, id);
    expect(await hasFile(pool, id)).toBe(false);
    await deleteFile(pool, id);
  });

  it("lists the files pushed values use that it doesn't have: image values and files/<id> in any text", async () => {
    const have = sha256(bytes("have"));
    await putFile(pool, have, "text/plain", bytes("have"));
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const c = "c".repeat(64);
    expect(await missing({})).toEqual([]);
    expect(await missing({ field_values: [value("i1", { value_file: have })] })).toEqual([]);
    expect(await missing({
      field_values: [
        value("i1", { value_file: a }),
        value("i2", { value_text: `![x](files/${b}) and files/${have}` }),
        value("i3", { value_text: `files/${a} again, files/${c}.` }),
        value("i4", { value_text: "files/not-an-id" }),
      ],
    })).toEqual([a, b, c]);
  });

  it("doesn't ask for the files of items pushed as deleted", async () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    expect(await missing({
      items: [{ id: "gone", deleted_at: "2026-10-01T00:00:00.000Z" }, { id: "kept", deleted_at: null }],
      field_values: [value("gone", { value_file: a }), value("kept", { value_file: b })],
    })).toEqual([b]);
  });
});
