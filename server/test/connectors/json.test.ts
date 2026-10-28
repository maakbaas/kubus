// @vitest-environment node
// JSON over HTTP (server/src/connectors/json.ts, httpTable.ts): pointers, NDJSON, inference, and the connector against a stand-in server.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { atPointer, flatten, JsonConnector, jsonRecords, jsonTableName, pointerTokens } from "../../src/connectors/json.ts";
import { forgetDocuments, withSecret } from "../../src/connectors/httpDocument.ts";
import { httpRequest, inferColumn, MAX_PAGES, tableOf } from "../../src/connectors/httpTable.ts";
import type { SourceConfig } from "../../src/connectors/connector.ts";
import type { SourceQuery } from "../../../shared/sources.ts";

describe("JSON Pointer", () => {
  it("reads RFC 6901 tokens with ~0 and ~1", () => {
    expect(pointerTokens("")).toEqual([]);
    expect(pointerTokens("/")).toEqual([]);
    expect(pointerTokens("/data/items")).toEqual(["data", "items"]);
    expect(pointerTokens("data/a~1b/c~0d/~01")).toEqual(["data", "a/b", "c~d", "~1"]);
    const doc = { data: { "a/b": [{ x: 1 }, { x: 2 }] } };
    expect(atPointer(doc, "/data/a~1b/1")).toEqual({ x: 2 });
    expect(() => atPointer(doc, "/data/missing/x")).toThrow(/nothing at “\/data\/missing”/);
    expect(() => atPointer(doc, "/data/a~1b/x")).toThrow(/nothing at “\/data\/a~1b\/x”/);
  });

  it("names the table by the pointer's last token", () => {
    expect(jsonTableName("/data/items")).toBe("items");
    expect(jsonTableName("")).toBe("rows");
    expect(jsonTableName("/results/0")).toBe("rows");
  });
});

describe("jsonRecords", () => {
  it("takes the rows at the pointer, flattening objects one level", () => {
    const text = JSON.stringify({ data: { items: [{ id: 1, address: { city: "Delft", geo: { lat: 52 } } }, 7] } });
    expect(jsonRecords(text, "application/json", "/data/items")).toEqual([{ id: 1, "address.city": "Delft", "address.geo": { lat: 52 } }, { value: 7 }]);
    expect(flatten({ a: { b: 1 }, c: [1] })).toEqual({ "a.b": 1, c: [1] });
  });

  it("reads NDJSON by its content type or its lines", () => {
    expect(jsonRecords('{"a":1}\n\n{"a":2}\n', "application/x-ndjson", "")).toEqual([{ a: 1 }, { a: 2 }]);
    expect(jsonRecords('{"a":1}\n', "application/x-ndjson", "")).toEqual([{ a: 1 }]);
    expect(jsonRecords('{"a":1}\r\n{"a":2}', "text/plain", "/ignored")).toEqual([{ a: 1 }, { a: 2 }]);
    expect(() => jsonRecords("{nope", "application/json", "")).toThrow(/isn't JSON/);
    expect(() => jsonRecords("", "application/json", "")).toThrow(/empty/);
  });

  it("says where the rows likely are when an object holds them; else an object is one row", () => {
    expect(() => jsonRecords(JSON.stringify({ meta: {}, data: { items: [{ a: 1 }] }, tags: ["x"] }), "application/json", "")).toThrow(
      /“\/” is an object, not a list of rows: set Rows at to one of its lists \(\/data\/items\)/,
    );
    expect(jsonRecords(JSON.stringify({ status: "ok", tags: ["x"] }), "application/json", "")).toEqual([{ status: "ok", tags: ["x"] }]);
    expect(() => jsonRecords("3", "application/json", "")).toThrow(/a number, not a list/);
  });
});

describe("inferColumn", () => {
  it("reads numbers, checkboxes, dates, dates & times, lists and nested JSON", () => {
    expect(inferColumn("n", [1, null, 2.5])).toMatchObject({ kind: "number" });
    expect(inferColumn("b", [true, false, undefined])).toMatchObject({ kind: "checkbox" });
    expect(inferColumn("d", ["2026-01-02", ""])).toMatchObject({ kind: "date" });
    const at = inferColumn("t", ["2026-01-02T10:00:00Z", "2026-01-02T12:00"]);
    expect(at.kind).toBe("datetime");
    expect(at.value("2026-01-02T12:00")).toBe("2026-01-02T12:00:00.000Z");
    const list = inferColumn("l", [["a", 1], []]);
    expect(list.kind).toBe("string_list");
    expect(list.value(["a", 1, null])).toEqual(["a", "1"]);
    expect(inferColumn("j", [{ a: 1 }, [{ b: 2 }]])).toMatchObject({ kind: "string", plain: true, hidden: true });
    expect(inferColumn("j", [{ a: 1 }]).value({ a: 1 })).toBe('{"a":1}');
    // Mixed, or numbers as JSON strings: text.
    const mixed = inferColumn("m", [1, "two"]);
    expect(mixed.kind).toBe("string");
    expect(mixed.value(1)).toBe("1");
    expect(inferColumn("s", ["12", "13"])).toMatchObject({ kind: "string" });
    expect(inferColumn("e", [null])).toMatchObject({ kind: "string" });
  });

  it("keys rows by id, uuid or key when each row has its own", () => {
    expect(tableOf([{ UUID: "a" }, { UUID: "b" }]).key).toBe("UUID");
    expect(tableOf([{ id: 1, uuid: "a" }, { id: 1, uuid: "b" }]).key).toBe("uuid");
    expect(tableOf([{ id: 1 }, { name: "no id" }]).key).toBe("_row");
    expect(tableOf([{ _row: 1 }]).key).toBe("__row");
  });
});

describe("httpRequest", () => {
  it("puts the password in {secret}, else the query parameter, the header or Bearer", () => {
    expect(withSecret("https://x.example/a/{secret}/b?k=%7Bsecret%7D", "p/w&")).toBe("https://x.example/a/p%2Fw%26/b?k=p%2Fw%26");
    expect(httpRequest({ address: "x.example/a/{secret}/pub", header: "X-Key" }, "s/1")).toEqual({ url: new URL("https://x.example/a/s%2F1/pub"), headers: {}, param: "" });
    expect(httpRequest({ address: "https://x.example/a?b=1", param: "api_key" }, "pw").url.toString()).toBe("https://x.example/a?b=1&api_key=pw");
    expect(httpRequest({ address: "https://x.example/a", header: "X-Key" }, "pw").headers).toEqual({ "X-Key": "pw" });
    expect(httpRequest({ address: "https://x.example/a" }, "pw").headers).toEqual({ Authorization: "Bearer pw" });
    expect(httpRequest({ address: "https://x.example/a", param: "k" }, "").url.search).toBe("");
  });
});

let server: Server;
let base = "";
let other = "";
const seen: IncomingMessage[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(req);
    const url = new URL(req.url ?? "/", "http://x");
    const send = (body: unknown, headers: Record<string, string> = {}) => res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", ...headers }).end(JSON.stringify(body));
    if (url.pathname === "/api/items") {
      if (req.headers["x-api-key"] !== "pw") return res.writeHead(401).end();
      const page = Number(url.searchParams.get("page") ?? "1");
      const items = [1, 2].map((i) => ({ id: `p${page}-${i}`, name: `Item ${page}.${i}`, tags: page === 1 ? ["a", "b"] : ["c"], owner: { name: "Ada", meta: { x: 1 } }, done: i === 1, at: "2026-03-01T10:00:00Z" }));
      return send({ data: { items } }, page < 2 ? { Link: `<${base}/api/items?page=${page + 1}>; rel="next", <${base}/api/items?page=1>; rel="first"` } : {});
    }
    if (url.pathname === "/keyed") {
      if (url.searchParams.get("token") !== "pw") return res.writeHead(401).end();
      return send([{ n: url.searchParams.get("page") ?? "1" }], url.searchParams.get("page") ? {} : { Link: `</keyed?page=2>; rel="next"` });
    }
    // A next page on another origin gets no password.
    if (url.pathname === "/leaky") return send([{ n: 1 }], { Link: `<${other}/elsewhere>; rel="next"` });
    if (url.pathname === "/elsewhere") return send([{ n: 2, auth: req.headers.authorization ?? null }]);
    if (url.pathname === "/forever") return send([{ n: Number(url.searchParams.get("p") ?? 0) }], { Link: `</forever?p=${Number(url.searchParams.get("p") ?? 0) + 1}>; rel="next"` });
    if (url.pathname === "/ndjson") return res.writeHead(200, { "Content-Type": "application/x-ndjson" }).end('{"id":1}\n{"id":2}\n');
    if (url.pathname === "/page") return res.writeHead(200, { "Content-Type": "text/html" }).end("<html></html>");
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
  other = `http://localhost:${port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  forgetDocuments();
  seen.length = 0;
});

const config = (fields: Record<string, string>, password = ""): SourceConfig => ({ name: "API", kind: "json", fields, password, schemas: [], timeoutMs: 2000 });
const target = { table: { schema: null, name: "items" } };
const query = (over: Partial<SourceQuery> = {}): SourceQuery => ({
  target,
  key: "id",
  columns: ["name", "tags"],
  title: ["name"],
  untitled: "Item",
  filter: { and: [] },
  search: "",
  sort: [],
  groupBy: null,
  groupOrder: "asc",
  timeZone: "Europe/Amsterdam",
  offset: 0,
  limit: 50,
  counts: true,
  ...over,
});

describe("JsonConnector", () => {
  it("reads the rows at Rows at, page by page, with the password under its header", async () => {
    const c = new JsonConnector(config({ address: `${base}/api/items`, rows: "/data/items", header: "X-Api-Key" }, "pw"));
    expect(await c.tables()).toEqual([{ schema: null, name: "items", type: "table" }]);
    expect(await c.check()).toEqual([]);
    const d = await c.describe(target);
    expect(d.key).toEqual(["id"]);
    expect(d.columns.map((x) => [x.name, x.kind, x.hidden ?? false])).toEqual([
      ["id", "string", false],
      ["name", "string", false],
      ["tags", "string_list", false],
      ["owner.name", "string", false],
      ["owner.meta", "string", true],
      ["done", "checkbox", false],
      ["at", "datetime", false],
    ]);
    const r = await c.query(query({ filter: { and: [{ column: "tags", operator: "contains", value: "c" }] } }));
    expect(r.rows).toEqual([
      { key: "p2-1", values: ["Item 2.1", ["c"]] },
      { key: "p2-2", values: ["Item 2.2", ["c"]] },
    ]);
    expect(await c.row({ ...query(), keyValue: "p1-2" })).toEqual({ key: "p1-2", values: ["Item 1.2", ["a", "b"]] });
    expect(await c.query(query({ groupBy: "tags", columns: ["name"] }))).toMatchObject({ total: 4, groups: [{ key: "a", count: 2 }, { key: "b", count: 2 }, { key: "c", count: 2 }] });
    expect(seen.map((s) => s.url)).toEqual(["/api/items", "/api/items?page=2"]);
    expect(seen.every((s) => s.method === "GET" && s.headers["x-api-key"] === "pw")).toBe(true);
    await expect(new JsonConnector(config({ address: `${base}/api/items`, header: "X-Api-Key" }, "wrong")).check()).rejects.toThrow(/401/);
  });

  it("keeps the query parameter on next pages of the same origin, and sends no password to another", async () => {
    const keyed = await new JsonConnector(config({ address: `${base}/keyed`, param: "token" }, "pw")).query(query({ key: "_row", columns: ["n"], title: [] }));
    expect(keyed.rows.map((x) => x.values)).toEqual([["1"], ["2"]]);
    const leaky = await new JsonConnector(config({ address: `${base}/leaky` }, "pw")).query(query({ key: "_row", columns: ["n", "auth"], title: [] }));
    expect(leaky.rows.map((x) => x.values)).toEqual([[1, null], [2, null]]);
    expect(seen.find((s) => s.url === "/leaky")?.headers.authorization).toBe("Bearer pw");
  });

  it("bounds the pages", async () => {
    await expect(new JsonConnector(config({ address: `${base}/forever` })).check()).rejects.toThrow(new RegExp(`More than ${MAX_PAGES} pages`));
    expect(seen).toHaveLength(MAX_PAGES);
  });

  it("reads NDJSON, and says when the address is a web page", async () => {
    const c = new JsonConnector(config({ address: `${base}/ndjson`, rows: "/x" }));
    expect((await c.query(query({ columns: ["id"], title: [] }))).rows.map((x) => x.key)).toEqual(["1", "2"]);
    await expect(new JsonConnector(config({ address: `${base}/page` })).check()).rejects.toThrow(/web page, not JSON/);
  });
});
