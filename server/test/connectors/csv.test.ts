// @vitest-environment node
// CSV over HTTP (server/src/connectors/csv.ts, httpTable.ts): the parser and inference, and the connector against a stand-in server.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CsvConnector, csvDelimiter, csvHeader, csvRecords, parseCsv } from "../../src/connectors/csv.ts";
import { forgetDocuments } from "../../src/connectors/httpDocument.ts";
import { tableOf } from "../../src/connectors/httpTable.ts";
import type { SourceConfig } from "../../src/connectors/connector.ts";
import type { SourceQuery } from "../../../shared/sources.ts";

describe("parseCsv", () => {
  it("reads RFC 4180: quotes, doubled quotes, line breaks in quotes, CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n"two\r\nlines",\r\n', ",")).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["two\r\nlines", ""],
    ]);
    expect(parseCsv("a;b\n1;2", ";")).toEqual([["a", "b"], ["1", "2"]]);
    // Empty lines are left out; a quote inside an unquoted value is a quote.
    expect(parseCsv('a\n\nb"c\n', ",")).toEqual([["a"], ['b"c']]);
    expect(() => parseCsv('a\n"open,\nmore', ",")).toThrow(/isn't closed \(from line 2\)/);
  });

  it("finds the delimiter in the header row", () => {
    expect(csvDelimiter("a,b,c\n1;2")).toBe(",");
    expect(csvDelimiter("a;b;c\n1,5;2;3")).toBe(";");
    expect(csvDelimiter("a\tb\n1\t2")).toBe("\t");
    expect(csvDelimiter('"x;y",b\n')).toBe(",");
    expect(csvDelimiter("one\n")).toBe(",");
  });

  it("names empty headers by their place and makes names unique", () => {
    expect(csvHeader([" Name ", "", "name", "Name", "x"], 6)).toEqual(["Name", "Column 2", "name 2", "Name 3", "x", "Column 6"]);
  });
});

describe("csvRecords", () => {
  it("infers numbers, checkboxes and dates from text, decimal commas only off a comma delimiter", () => {
    const text = "id;price;ok;day;at;zip;when\n1;1,5;TRUE;2026-01-02;2026-01-02 10:00;01234;\n2;2;false;2026-01-03;2026-01-02T10:00:00+02:00;12345;x\n";
    const { records, options } = csvRecords(text);
    const t = tableOf(records, options);
    expect(t.columns.map((c) => [c.name, c.kind])).toEqual([
      ["id", "number"],
      ["price", "number"],
      ["ok", "checkbox"],
      ["day", "date"],
      ["at", "datetime"],
      ["zip", "string"],
      ["when", "string"],
    ]);
    expect(t.rows[0]).toMatchObject({ price: 1.5, ok: true, at: "2026-01-02T10:00:00.000Z", zip: "01234", when: null });
    expect(t.rows[1]).toMatchObject({ price: 2, ok: false, at: "2026-01-02T08:00:00.000Z" });
    expect(t.key).toBe("id");
    // With a comma delimiter "1,5" is text (it could be thousands); a dot is a decimal point.
    const comma = csvRecords('a,b\n"1,5",1.5\n2,2\n');
    expect(tableOf(comma.records, comma.options).columns.map((c) => c.kind)).toEqual(["string", "number", "number"]);
  });

  it("keys rows by their place without an id column, and warns", () => {
    const { records, options } = csvRecords("Name,Score\nAda,3\nBob,4\n");
    const t = tableOf(records, options);
    expect(t.key).toBe("_row");
    expect(t.rows.map((r) => r._row)).toEqual([1, 2]);
    expect(t.columns.find((c) => c.name === "_row")).toMatchObject({ hidden: true });
    expect(t.warnings.join()).toMatch(/links to it change/);
    // An id used twice isn't a key either.
    expect(tableOf(csvRecords("ID,x\n1,a\n1,b\n").records).key).toBe("_row");
    expect(tableOf(csvRecords("Key,x\nk1,a\nk2,b\n").records).key).toBe("Key");
  });
});

let server: Server;
let base = "";
const seen: IncomingMessage[] = [];
const SHEET = "Name,Score,Joined\r\nAda,3,2026-01-02\r\nBob,4,2026-02-03\r\nCyd,,\r\n";

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(req);
    const url = new URL(req.url ?? "/", "http://x");
    // A published Google Sheet answers with a redirect to where the CSV is.
    if (url.pathname === "/spreadsheets/d/e/SECRET-ID/pub") return res.writeHead(307, { Location: "/googleusercontent/sheet.csv" }).end();
    if (url.pathname === "/googleusercontent/sheet.csv") return res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" }).end(SHEET);
    if (url.pathname === "/param") return res.writeHead(url.searchParams.get("key") === "pw" ? 200 : 401, { "Content-Type": "text/plain" }).end("a\n1\n");
    if (url.pathname === "/header") return res.writeHead(req.headers["x-api-key"] === "pw" ? 200 : 401, { "Content-Type": "application/vnd.ms-excel" }).end("a\n1\n");
    if (url.pathname === "/bearer") return res.writeHead(req.headers.authorization === "Bearer pw" ? 200 : 401, { "Content-Type": "application/octet-stream" }).end("a\n1\n");
    if (url.pathname === "/paged") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const headers: Record<string, string> = { "Content-Type": "text/csv" };
      if (page < 3) headers.Link = `</paged?page=${page + 1}>; rel="next"`;
      return res.writeHead(200, headers).end(`id,page\n${page * 10},${page}\n${page * 10 + 1},${page}\n`);
    }
    if (url.pathname === "/page") return res.writeHead(200, { "Content-Type": "text/html" }).end("<html></html>");
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  forgetDocuments();
  seen.length = 0;
});

const config = (fields: Record<string, string>, password = ""): SourceConfig => ({ name: "Sheet", kind: "csv", fields, password, schemas: [], timeoutMs: 2000 });
const target = { table: { schema: null, name: "rows" } };
const query = (over: Partial<SourceQuery> = {}): SourceQuery => ({
  target,
  key: "_row",
  columns: ["Name", "Score"],
  title: ["Name"],
  untitled: "Row",
  filter: { and: [] },
  search: "",
  sort: [{ column: "Score", direction: "desc" }],
  groupBy: null,
  groupOrder: "asc",
  timeZone: "Europe/Amsterdam",
  offset: 0,
  limit: 50,
  counts: true,
  ...over,
});

describe("CsvConnector", () => {
  it("reads a published sheet: the secret in the address, redirects followed", async () => {
    const c = new CsvConnector(config({ address: `${base}/spreadsheets/d/e/{secret}/pub?output=csv` }, "SECRET-ID"));
    expect(await c.tables()).toEqual([{ schema: null, name: "rows", type: "table" }]);
    expect((await c.check()).join()).toMatch(/_row/);
    const d = await c.describe(target);
    expect(d.columns.map((x) => [x.name, x.kind])).toEqual([
      ["Name", "string"],
      ["Score", "number"],
      ["Joined", "date"],
      ["_row", "number"],
    ]);
    expect(d.key).toEqual(["_row"]);
    expect(d.columns.every((x) => !("value" in x))).toBe(true);
    const r = await c.query(query());
    expect(r.rows.map((x) => x.values)).toEqual([["Bob", 4], ["Ada", 3], ["Cyd", null]]);
    expect(r.total).toBe(3);
    expect(await c.row({ ...query(), keyValue: "2" })).toEqual({ key: "2", values: ["Bob", 4] });
    expect(await c.query(query({ filter: { and: [{ column: "Joined", operator: "after", value: "2026-01-15" }] } }))).toMatchObject({ total: 1 });
    // One read for all of it (the document is kept a minute).
    expect(seen.map((s) => s.url)).toEqual(["/spreadsheets/d/e/SECRET-ID/pub?output=csv", "/googleusercontent/sheet.csv"]);
    expect(seen.every((s) => s.method === "GET")).toBe(true);
    await expect(c.describe({ query: "select 1" })).rejects.toThrow(/one table/);
  });

  it("sends the password as the query parameter, the header, or Bearer", async () => {
    expect(await new CsvConnector(config({ address: `${base}/param`, param: "key" }, "pw")).check()).toHaveLength(1);
    expect(await new CsvConnector(config({ address: `${base}/header`, header: "X-Api-Key" }, "pw")).check()).toHaveLength(1);
    expect(await new CsvConnector(config({ address: `${base}/bearer` }, "pw")).check()).toHaveLength(1);
    await expect(new CsvConnector(config({ address: `${base}/bearer` }, "wrong")).check()).rejects.toThrow(/401/);
    expect(() => new CsvConnector(config({ address: `${base}/x/{secret}` }))).toThrow(/no password/);
    expect(() => new CsvConnector(config({ address: `${base}/x`, header: "Bad header" }, "pw"))).toThrow(/header name/);
  });

  it("reads every page by Link: rel=next", async () => {
    const c = new CsvConnector(config({ address: `${base}/paged` }));
    expect(await c.check()).toEqual([]);
    const r = await c.query(query({ key: "id", columns: ["id", "page"], title: [], sort: [] }));
    expect(r.rows.map((x) => x.values)).toEqual([[10, 1], [11, 1], [20, 2], [21, 2], [30, 3], [31, 3]]);
  });

  it("says when the address is a web page", async () => {
    await expect(new CsvConnector(config({ address: `${base}/page` })).check()).rejects.toThrow(/web page, not CSV/);
  });
});
