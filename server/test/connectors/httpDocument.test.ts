// @vitest-environment node
// One document over HTTP (server/src/connectors/httpDocument.ts) against a stand-in server.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DOCUMENT_TTL_MS, documentAddress, fetchDocument, forgetDocuments, hasSecretPlace, nextLink, withSecret } from "../../src/connectors/httpDocument.ts";

let server: Server;
let base = "";
const seen: IncomingMessage[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(req);
    const path = req.url ?? "/";
    if (path === "/doc.json") {
      if (req.headers["if-none-match"] === '"v1"') return res.writeHead(304).end();
      return res.writeHead(200, { "Content-Type": "application/json", ETag: '"v1"' }).end('﻿{"a":1}');
    }
    if (path === "/login") return res.writeHead(200, { "Content-Type": "text/html" }).end("<html></html>");
    if (path === "/private") return res.writeHead(req.headers.authorization === "Bearer pw" ? 200 : 401, { "Content-Type": "text/plain" }).end("ok");
    if (path === "/big") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write("x".repeat(600));
      return res.end("x".repeat(600));
    }
    if (path === "/slow") return setTimeout(() => res.writeHead(200).end("late"), 500);
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

const json = { what: "JSON", timeoutMs: 2000, accepts: (t: string) => t.includes("json") };

describe("fetchDocument", () => {
  it("reads a document, keeps it a while, then revalidates it", async () => {
    const t = Date.now();
    const doc = await fetchDocument(`${base}/doc.json`, json, t);
    expect(doc).toMatchObject({ status: 200, contentType: "application/json", text: '{"a":1}' });
    expect(await fetchDocument(`${base}/doc.json`, json, t + 1000)).toBe(doc);
    expect(seen).toHaveLength(1);
    expect(await fetchDocument(`${base}/doc.json`, json, t + DOCUMENT_TTL_MS + 1)).toBe(doc);
    expect(seen).toHaveLength(2);
    expect(seen[1].headers["if-none-match"]).toBe('"v1"');
    expect(seen.every((r) => r.method === "GET")).toBe(true);
  });

  it("reads once when asked twice at once", async () => {
    await Promise.all([fetchDocument(`${base}/doc.json`, json), fetchDocument(`${base}/doc.json`, json)]);
    expect(seen).toHaveLength(1);
  });

  it("says what is wrong in words", async () => {
    await expect(fetchDocument(`${base}/login`, json)).rejects.toThrow(/web page, not JSON/);
    await expect(fetchDocument(`${base}/nothing`, json)).rejects.toThrow(/no JSON at the address \(404\)/);
    await expect(fetchDocument(`${base}/private`, { what: "a calendar", timeoutMs: 2000 })).rejects.toThrow(/401.*password/);
    expect((await fetchDocument(`${base}/private`, { what: "a calendar", timeoutMs: 2000, headers: { Authorization: "Bearer pw" } })).text).toBe("ok");
    await expect(fetchDocument(`${base}/big`, { what: "CSV", timeoutMs: 2000, maxBytes: 1000 })).rejects.toThrow(/larger than/);
    await expect(fetchDocument(`${base}/slow`, { what: "CSV", timeoutMs: 100 })).rejects.toThrow(/within/);
    await expect(fetchDocument("http://127.0.0.1:1/x", { what: "CSV", timeoutMs: 2000 })).rejects.toThrow(/Can't reach/);
  });
});

describe("documentAddress", () => {
  it("reads webcal over https, and https unless it says http", () => {
    expect(documentAddress("webcal://cal.example.com/a.ics").toString()).toBe("https://cal.example.com/a.ics");
    expect(documentAddress("webcals://cal.example.com/a.ics").protocol).toBe("https:");
    expect(documentAddress("example.com/x.csv").toString()).toBe("https://example.com/x.csv");
    expect(documentAddress("http://example.com/x").protocol).toBe("http:");
    expect(() => documentAddress("ftp://example.com/x")).toThrow(/https/);
    expect(() => documentAddress("")).toThrow(/no address/);
  });
});

describe("withSecret", () => {
  it("fills {secret} in, encoded, as typed or as a URL writes it", () => {
    const typed = "https://calendar.google.com/calendar/ical/me%40gmail.com/{secret}/basic.ics";
    expect(withSecret(typed, "private-a/b c")).toBe("https://calendar.google.com/calendar/ical/me%40gmail.com/private-a%2Fb%20c/basic.ics");
    expect(withSecret(documentAddress("webcal://cal.example.com/{secret}.ics?k={secret}"), "s&1")).toBe("https://cal.example.com/s%261.ics?k=s%261");
    expect(withSecret("https://cal.example.com/a.ics", "s")).toBe("https://cal.example.com/a.ics");
    expect(hasSecretPlace(documentAddress("cal.example.com/{secret}"))).toBe(true);
    expect(hasSecretPlace("https://cal.example.com/a.ics")).toBe(false);
  });
});

describe("nextLink", () => {
  it("finds rel=next among the links", () => {
    const doc = (link: string) => ({ url: "https://api.example.com/items?page=1", headers: new Headers({ link }) }) as Parameters<typeof nextLink>[0];
    expect(nextLink(doc('<https://api.example.com/items?page=1>; rel="prev", </items?page=2>; rel="next"'))).toBe("https://api.example.com/items?page=2");
    expect(nextLink(doc('<https://x/2>; rel="first last"'))).toBeNull();
    expect(nextLink(doc("<https://x/3>; rel=next"))).toBe("https://x/3");
  });
});
