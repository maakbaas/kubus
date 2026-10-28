// @vitest-environment node
// What the HTTP connectors (csv, json, ics: httpDocument.ts) do with real files, served by real HTTP servers
// (httpFiles.ts): sizes, encodings, malformed content, redirects, timeouts, the password in each place, and that
// they only read.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SourceError } from "../../src/connectors/connector.ts";
import { CsvConnector } from "../../src/connectors/csv.ts";
import { fetchDocument, forgetDocuments, MAX_DOCUMENT_BYTES } from "../../src/connectors/httpDocument.ts";
import { IcsConnector } from "../../src/connectors/ics.ts";
import { JsonConnector } from "../../src/connectors/json.ts";
import { MAX_ROWS } from "../../src/connectors/httpTable.ts";
import type { SourceQuery } from "../../../shared/sources.ts";
import { PASSWORD, serve, type Served } from "./httpFiles.ts";

let dir: string;
let main: Served;
let away: Served;

const write = (name: string, content: string | Buffer) => writeFileSync(join(dir, name), content);
const config = (kind: string, address: string, fields: Record<string, string> = {}, password = "", timeoutMs = 5000) => ({ name: "Doc", kind, fields: { address, ...fields }, password, schemas: [], timeoutMs });
const csv = (path: string, fields: Record<string, string> = {}, password = "", timeoutMs = 5000) => new CsvConnector(config("csv", `${main.base}${path}`, fields, password, timeoutMs));
const json = (path: string, fields: Record<string, string> = {}, password = "", timeoutMs = 5000) => new JsonConnector(config("json", `${main.base}${path}`, fields, password, timeoutMs));
const calendar = (path: string, password = "") => new IcsConnector(config("ics", `${main.base}${path}`, {}, password));

const rows = (over: Partial<SourceQuery> = {}): SourceQuery => ({
  target: { table: { schema: null, name: "rows" } },
  key: "id",
  columns: ["id", "name"],
  title: ["name"],
  untitled: "Row",
  filter: { and: [] },
  search: "",
  sort: [{ column: "id", direction: "asc" }],
  groupBy: null,
  groupOrder: "asc",
  timeZone: "UTC",
  offset: 0,
  limit: 10,
  counts: true,
  ...over,
});
const ids = async (c: CsvConnector | JsonConnector, over: Partial<SourceQuery> = {}) => (await c.query(rows(over))).rows.map((r) => r.key);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kubus-transport-"));
  write("people.csv", "id,name\r\n1,Ada\r\n2,Bob\r\n3,Cy\r\n");
  write("people.json", JSON.stringify([{ id: 1, name: "Ada" }, { id: 2, name: "Bob" }, { id: 3, name: "Cy" }]));
  away = await serve(dir);
  main = await serve(dir, { other: away.base });
});

afterAll(async () => {
  await main?.close();
  await away?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  forgetDocuments();
  main.seen.length = 0;
  away.seen.length = 0;
});

describe("sizes", () => {
  it("reads 20,000 rows and queries them", async () => {
    const lines = ["id,name,score,when"];
    for (let i = 1; i <= 20_000; i++) lines.push(`${i},Person number ${i},${(i * 7) % 1000 / 10},2026-01-${String((i % 28) + 1).padStart(2, "0")}T12:00:00Z`);
    write("big.csv", lines.join("\n") + "\n");
    const c = csv("/big.csv");
    const r = await c.query(rows({ filter: { column: "name", operator: "contains", value: "number 1999" }, columns: ["id", "name", "score", "when"], limit: 5 }));
    expect(r.total).toBe(11);
    expect(r.rows[0].values).toEqual([1999, "Person number 1999", 99.3, "2026-01-12T12:00:00.000Z"]);
    const grouped = await c.query(rows({ groupBy: "score", groupOrder: "count", limit: 3, columns: ["id"] }));
    expect(grouped.groups).toHaveLength(1000);
    expect(grouped.groups![0].count).toBe(20);
    // The second query is served from the one read: the file was asked for once.
    expect(main.seen.filter((r) => r.url === "/big.csv")).toHaveLength(1);
  }, 30_000);

  it("refuses more rows than a source reads, in words", async () => {
    write("toomany.csv", ["id", ...Array.from({ length: MAX_ROWS + 1 }, (_, i) => String(i + 1))].join("\n"));
    await expect(csv("/toomany.csv").query(rows({ columns: ["id"] }))).rejects.toThrow(new RegExp(`More than ${MAX_ROWS.toLocaleString("en")} rows`));
    write("toomany.json", JSON.stringify(Array.from({ length: MAX_ROWS + 1 }, (_, i) => ({ id: i + 1 }))));
    await expect(json("/toomany.json").check()).rejects.toThrow(/More than 100,000 rows/);
    expect((await csv("/toomany.csv").check().catch((e: Error) => e)) instanceof Error).toBe(true);
  }, 30_000);

  it("refuses a document over the size limit, announced or not, and reads one just under it", async () => {
    // The real limit, announced by Content-Length: refused before the body is read.
    write("huge.csv", Buffer.alloc(MAX_DOCUMENT_BYTES + 1, "a"));
    await expect(csv("/huge.csv").check()).rejects.toThrow(/larger than 20 MB/);
    // A smaller limit on a small file, announced and not (chunked: refused when it grows past it), and just under.
    write("medium.csv", "x\n" + "a".repeat(300_000));
    const limit = { what: "CSV", timeoutMs: 5000, maxBytes: 200_000 };
    await expect(fetchDocument(`${main.base}/medium.csv`, limit)).rejects.toThrow(/larger than 0 MB/);
    forgetDocuments();
    await expect(fetchDocument(`${main.base}/nolength/medium.csv`, limit)).rejects.toThrow(/larger than 0 MB/);
    forgetDocuments();
    expect((await fetchDocument(`${main.base}/medium.csv`, { ...limit, maxBytes: 300_002 })).bytes.length).toBe(300_002);
  }, 30_000);

  it("reads an empty file, and a header alone, as no rows", async () => {
    write("empty.csv", "");
    write("header.csv", "id,name\r\n");
    expect(await ids(csv("/empty.csv"), { key: "_row", columns: [], title: [], sort: [] })).toEqual([]);
    const d = await csv("/header.csv").describe({ table: { schema: null, name: "rows" } });
    expect(d.columns.map((c) => c.name)).toEqual(["_row"]);
    expect((await csv("/header.csv").query(rows({ key: "_row", columns: ["_row"], title: [], sort: [] }))).total).toBe(0);
    write("empty.json", "[]");
    expect((await json("/empty.json").query(rows({ key: "_row", columns: ["_row"], title: [], sort: [] }))).total).toBe(0);
  });
});

describe("encodings", () => {
  it("drops a UTF-8 byte order mark and reads accents, emoji and CJK", async () => {
    write("utf8.csv", "﻿id,name\r\n1,Zoë\r\n2,😀 smile\r\n3,日本語\r\n");
    const r = await csv("/utf8.csv").query(rows());
    expect(r.rows.map((x) => x.values[1])).toEqual(["Zoë", "😀 smile", "日本語"]);
    const d = await csv("/utf8.csv").describe({ table: { schema: null, name: "rows" } });
    expect(d.columns[0].name).toBe("id");
  });

  it("reads the charset the server declares: a Latin-1 / Windows-1252 export, UTF-16 with its byte order mark", async () => {
    // "é" is one byte in Latin-1; "€" is 0x80 in Windows-1252.
    write("latin1.csv", Buffer.from("id,name\r\n1,Caf\xe9\r\n2,Zo\xeb\r\n", "latin1"));
    write("cp1252.csv", Buffer.from("id,name\r\n1,Cr\xe8me\r\n", "latin1"));
    write("utf16.csv", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("id,name\r\n1,Zoë\r\n2,日本\r\n", "utf16le")]));
    write("utf16be.csv", Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("id,name\r\n1,Zoë\r\n", "utf16le").swap16()]));
    const latin = await csv("/as/text_csv;%20charset=iso-8859-1/latin1.csv").query(rows());
    expect(latin.rows.map((x) => x.values[1])).toEqual(["Café", "Zoë"]);
    const cp = await csv("/as/text_csv;%20charset=windows-1252/cp1252.csv").query(rows());
    expect(cp.rows.map((x) => x.values[1])).toEqual(["Crème"]);
    // No charset declared: UTF-16 is told by its byte order mark.
    expect((await csv("/utf16.csv").query(rows())).rows.map((x) => x.values[1])).toEqual(["Zoë", "日本"]);
    expect((await csv("/utf16be.csv").query(rows())).rows.map((x) => x.values[1])).toEqual(["Zoë"]);
  });

  it("reads bytes that aren't UTF-8 as replacement characters, rather than failing, when no charset says otherwise", async () => {
    const r = await csv("/latin1.csv").query(rows());
    expect(r.rows.map((x) => x.values[1])).toEqual(["Caf�", "Zo�"]);
  });

  it("reads a calendar's charset too", async () => {
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//T//EN", "BEGIN:VEVENT", "UID:a@x", "DTSTART:20260301T100000Z", "SUMMARY:Caf\xe9 meeting", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
    write("latin1.ics", Buffer.from(lines, "latin1"));
    const q = rows({ target: { table: { schema: null, name: "events" } }, key: "uid", columns: ["title"], title: ["title"] });
    const r = await calendar("/as/text_calendar;%20charset=iso-8859-1/latin1.ics").query(q);
    expect(r.rows[0].values).toEqual(["Café meeting"]);
  });

  it("reads JSON with a byte order mark, and CSV with CR line ends, LF, a missing last newline, tabs and semicolons", async () => {
    write("bom.json", "﻿" + JSON.stringify([{ id: 1, name: "Ada" }]));
    expect(await ids(json("/bom.json"))).toEqual(["1"]);
    write("cr.csv", "id,name\r1,Ada\r2,Bob");
    expect(await ids(csv("/cr.csv"))).toEqual(["1", "2"]);
    write("tab.csv", "id\tname\n1\tAda\n2\tBob");
    expect(await ids(csv("/tab.csv"))).toEqual(["1", "2"]);
  });

  it("reads a gzipped body, and a body without a length", async () => {
    expect(await ids(csv("/gzip/people.csv"))).toEqual(["1", "2", "3"]);
    expect(await ids(json("/nolength/people.json"))).toEqual(["1", "2", "3"]);
  });
});

describe("malformed content", () => {
  it("says an unclosed quote, a web page, plain nonsense and truncated JSON in words", async () => {
    write("unclosed.csv", 'id,name\r\n1,"Ada\r\n2,Bob\r\n');
    await expect(csv("/unclosed.csv").check()).rejects.toThrow(/quoted value that isn't closed \(from line 2\)/);
    await expect(csv("/login").check()).rejects.toThrow(/web page, not CSV/);
    await expect(json("/login").check()).rejects.toThrow(/web page, not JSON/);
    write("nonsense.json", "this is not json");
    await expect(json("/nonsense.json").check()).rejects.toThrow(/isn't JSON/);
    write("cut.json", '[{"id": 1, "name": "Ada"}, {"id": 2, "na');
    await expect(json("/cut.json").check()).rejects.toThrow(/isn't JSON/);
    write("trailing.json", '[{"id": 1},]');
    await expect(json("/trailing.json").check()).rejects.toThrow(/isn't JSON/);
    write("blank.json", "  \n");
    await expect(json("/blank.json").check()).rejects.toThrow(/empty/);
    write("hello.ics", "hello");
    await expect(calendar("/hello.ics").check()).rejects.toThrow(/BEGIN:VCALENDAR/);
  });

  it("reads rows with too few or too many values, duplicate and empty headers", async () => {
    write("ragged.csv", "id,name,,name\r\n1,Ada\r\n2,Bob,x,y,z\r\n");
    const c = csv("/ragged.csv");
    const d = await c.describe({ table: { schema: null, name: "rows" } });
    expect(d.columns.map((x) => x.name)).toEqual(["id", "name", "Column 3", "name 2", "Column 5"]);
    const r = await c.query(rows({ columns: ["id", "name", "Column 3", "name 2", "Column 5"] }));
    expect(r.rows.map((x) => x.values)).toEqual([[1, "Ada", null, null, null], [2, "Bob", "x", "y", "z"]]);
  });

  it("says where the rows are when the JSON is an object of lists, and what is at a wrong pointer", async () => {
    write("object.json", JSON.stringify({ meta: {}, data: { items: [{ id: 1 }] } }));
    await expect(json("/object.json").check()).rejects.toThrow(/set Rows at to one of its lists \(\/data\/items\)/);
    await expect(json("/object.json", { rows: "/nothing/here" }).check()).rejects.toThrow(/nothing at “\/nothing”/);
    expect(await ids(json("/object.json", { rows: "/data/items" }), { columns: ["id"], title: ["id"] })).toEqual(["1"]);
    write("scalars.json", "[1, 2, 3]");
    expect((await json("/scalars.json").query(rows({ key: "value", columns: ["value"], title: ["value"], sort: [] }))).rows.map((r) => r.values[0])).toEqual([1, 2, 3]);
  });

  it("reads objects one level down as columns and anything deeper, and lists of objects, as hidden JSON text", async () => {
    write("nested.json", JSON.stringify([{ id: 1, a: { b: { c: 1 }, d: 2 }, list: [{ x: 1 }] }]));
    const c = json("/nested.json");
    const d = await c.describe({ table: { schema: null, name: "rows" } });
    expect(d.columns.map((x) => [x.name, x.kind, !!x.hidden])).toEqual([["id", "number", false], ["a.b", "string", true], ["a.d", "number", false], ["list", "string", true]]);
    expect((await c.query(rows({ columns: ["a.b", "a.d", "list"], title: ["id"] }))).rows[0].values).toEqual(['{"c":1}', 2, '[{"x":1}]']);
  });
});

describe("redirects, statuses and time", () => {
  it("follows a redirect and a chain of them, and says a loop", async () => {
    expect(await ids(csv("/redirect/people.csv"))).toEqual(["1", "2", "3"]);
    forgetDocuments();
    expect(await ids(csv("/redirect/people.csv?status=301"))).toEqual(["1", "2", "3"]);
    forgetDocuments();
    expect(await ids(csv("/chain/a"))).toEqual(["1", "2", "3"]);
    await expect(csv("/loop").check()).rejects.toThrow(/redirects more than 10 times/);
  });

  it("sends the password to the address's own origin and not to the one a redirect leads to", async () => {
    const own = csv("/redirect/bearer/people.csv", {}, PASSWORD);
    expect(await ids(own)).toEqual(["1", "2", "3"]);
    forgetDocuments();
    away.seen.length = 0;
    // The same file at another origin, behind a redirect: the Bearer password, a header and a query parameter stay home.
    for (const [fields, password] of [[{}, PASSWORD], [{ header: "x-api-key" }, PASSWORD], [{ param: "key" }, PASSWORD]] as const) {
      forgetDocuments();
      const c = csv("/away/people.csv", { ...fields }, password);
      expect(await ids(c)).toEqual(["1", "2", "3"]);
    }
    expect(away.seen.length).toBe(3);
    for (const r of away.seen) {
      expect(r.headers.authorization).toBeUndefined();
      expect(r.headers["x-api-key"]).toBeUndefined();
      expect(r.url).not.toContain(PASSWORD);
    }
  });

  it("says each status in words, and which are the source's problem (never a SourceError)", async () => {
    const says: [number, RegExp][] = [
      [401, /401.*password/],
      [403, /403.*password/],
      [404, /no CSV at the address \(404\)/],
      [410, /\(410\)/],
      [429, /429: too many requests/],
      [500, /500: its server has a problem/],
      [503, /503/],
      [418, /answers 418/],
    ];
    for (const [status, message] of says) {
      forgetDocuments();
      const e = await csv(`/status/${status}`).check().catch((x: Error) => x);
      expect(e, String(status)).toBeInstanceOf(Error);
      expect(e, String(status)).not.toBeInstanceOf(SourceError);
      expect((e as Error).message, String(status)).toMatch(message);
    }
    // 204 and 205 have no document: no rows.
    forgetDocuments();
    expect((await csv("/status/204").query(rows({ key: "_row", columns: [], title: [], sort: [] }))).total).toBe(0);
  });

  it("gives up on a slow answer and a body that stops, at the source's time limit", async () => {
    await expect(csv("/slow/people.csv?ms=3000", {}, "", 200).check()).rejects.toThrow(/didn't answer within/);
    // (Time enough for its first bytes to come, on a busy machine too.)
    await expect(csv("/stall/people.csv", {}, "", 2000).check()).rejects.toThrow(/didn't send the document within/);
    // A slow answer that is in time is read.
    expect(await ids(csv("/slow/people.csv?ms=100", {}, "", 3000))).toEqual(["1", "2", "3"]);
  });

  it("says a body cut off half way, and a server that isn't there", async () => {
    const e = await csv("/cut/people.csv").check().catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(SourceError);
    const closed = await serve(dir);
    const gone = closed.base;
    await closed.close();
    await expect(new CsvConnector(config("csv", `${gone}/x.csv`)).check()).rejects.toThrow(/Can't reach the address \(ECONNREFUSED\)/);
    await expect(new CsvConnector(config("csv", "http://no-such-host.invalid/x.csv")).check()).rejects.toThrow(/Can't reach the address/);
  });
});

describe("the password, in each place", () => {
  it("goes as Bearer, in a header, in a query parameter or in the address, and a wrong or missing one is a 401", async () => {
    expect(await ids(csv("/bearer/people.csv", {}, PASSWORD))).toEqual(["1", "2", "3"]);
    forgetDocuments();
    expect(await ids(csv("/header/people.csv", { header: "X-Api-Key" }, PASSWORD))).toEqual(["1", "2", "3"]);
    forgetDocuments();
    expect(await ids(csv("/param/people.csv", { param: "key" }, PASSWORD))).toEqual(["1", "2", "3"]);
    forgetDocuments();
    expect(await ids(csv("/secret/{secret}/people.csv", {}, PASSWORD))).toEqual(["1", "2", "3"]);
    forgetDocuments();
    expect(await ids(json("/bearer/people.json", {}, PASSWORD))).toEqual(["1", "2", "3"]);
    for (const [path, fields] of [["/bearer/people.csv", {}], ["/header/people.csv", { header: "X-Api-Key" }], ["/param/people.csv", { param: "key" }]] as const) {
      forgetDocuments();
      await expect(csv(path, { ...fields }, "wrong").check(), path).rejects.toThrow(/401.*password/);
      forgetDocuments();
      await expect(csv(path, { ...fields }).check(), path).rejects.toThrow(/401/);
    }
    await expect(calendar("/bearer/people.ics", "wrong").check()).rejects.toThrow(/401/);
  });

  it("is encoded as one part of the address, and a header name that isn't one is refused before anything is sent", async () => {
    const c = csv("/secret/{secret}/people.csv", {}, "a/b c");
    await expect(c.check()).rejects.toThrow(/no CSV at the address \(404\)/);
    expect(main.seen.at(-1)!.url).toBe("/secret/a%2Fb%20c/people.csv");
    main.seen.length = 0;
    expect(() => csv("/bearer/people.csv", { header: "bad header" }, PASSWORD)).toThrow(SourceError);
    expect(main.seen).toEqual([]);
  });
});

describe("pages", () => {
  it("follows Link: rel=next from page to page", async () => {
    for (let i = 1; i <= 3; i++) write(`pages-${i}.json`, JSON.stringify([{ id: i * 10 + 1, name: `a${i}` }, { id: i * 10 + 2, name: `b${i}` }]));
    expect(await ids(json("/pages/pages-1.json"), { limit: 100 })).toEqual(["11", "12", "21", "22", "31", "32"]);
    // Its pages are asked for once each.
    expect(main.seen.filter((r) => r.url?.startsWith("/pages/"))).toHaveLength(3);
  });
});

describe("only reads", () => {
  it("sends nothing but GETs, with the one User-Agent, and no body", async () => {
    forgetDocuments();
    main.seen.length = 0;
    await csv("/people.csv").query(rows());
    await json("/people.json").row({ ...rows(), keyValue: "1" });
    await calendar("/status/200").check().catch(() => undefined);
    expect(main.seen.length).toBeGreaterThan(0);
    for (const r of main.seen) {
      expect(r.method).toBe("GET");
      expect(r.headers["user-agent"]).toBe("Kubus");
      expect(r.headers["content-length"]).toBeUndefined();
    }
  });

  it("asks again with the ETag when a kept document is old, and reads a changed file", async () => {
    write("changing.csv", "id,name\r\n1,Ada\r\n");
    const url = `${main.base}/changing.csv`;
    const t = Date.now();
    const first = await fetchDocument(url, { what: "CSV", timeoutMs: 2000 }, t);
    expect(first.text).toContain("Ada");
    // Old, unchanged: 304, the same document.
    const again = await fetchDocument(url, { what: "CSV", timeoutMs: 2000 }, t + 61_000);
    expect(again).toBe(first);
    expect(main.seen.at(-1)!.headers["if-none-match"]).toBeDefined();
    // Changed (a different size, so another ETag): read anew.
    write("changing.csv", "id,name\r\n1,Ada\r\n2,Bob\r\n");
    const changed = await fetchDocument(url, { what: "CSV", timeoutMs: 2000 }, t + 122_000);
    expect(changed).not.toBe(first);
    expect(changed.text).toContain("Bob");
  });
});
