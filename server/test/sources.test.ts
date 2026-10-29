// @vitest-environment node
// The server's remote sources (src/sources.ts): routing, validation and errors, with connectors
// that answer as told (the real ones have tests of their own: ./connectors, and ./http.test.ts
// end to end).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "../../shared/router.ts";
import type { SourceConfig } from "../src/connectors/connector.ts";
import { SourceError } from "../src/connectors/connector.ts";
import { Sources } from "../src/sources.ts";
import { apiRequest } from "./request.ts";

/** What the stand-in connector does: set per test. */
const behaviour = vi.hoisted(() => ({
  made: [] as { config: { name: string; kind: string }; connector: Record<string, unknown> }[],
  check: async (): Promise<string[]> => [],
  work: async (_call: string, _arg: unknown): Promise<unknown> => ({ ok: true }),
}));

vi.mock("../src/connectors/index.ts", () => ({
  connectorFor: (config: { name: string; kind: string }) => {
    if (config.kind === "unknown") return { problem: `No connector reads “${config.kind}” sources` };
    const closed = { value: false };
    const connector = {
      kind: config.kind,
      closed,
      check: () => behaviour.check(),
      tables: () => behaviour.work("tables", undefined),
      describe: (target: unknown) => behaviour.work("describe", target),
      query: (query: unknown) => behaviour.work("query", query),
      row: (request: unknown) => behaviour.work("row", request),
      close: async () => {
        closed.value = true;
      },
    };
    behaviour.made.push({ config, connector });
    return connector;
  },
}));

const config = (name: string, over: Partial<SourceConfig> = {}): SourceConfig => ({ name, kind: "postgres", fields: {}, password: "", schemas: [], timeoutMs: 1000, ...over });

const shape = { target: { table: { schema: "public", name: "books" } }, key: "id", columns: ["id", "title"], title: ["title"], untitled: "Untitled" };
const query = { ...shape, filter: { and: [] }, search: "", sort: [], groupBy: null, groupOrder: "asc", timeZone: "UTC", offset: 0, limit: 10, counts: true };

describe("remote sources", () => {
  let sources: Sources;
  let router: Router;
  let log: string[];
  const logger = (message: string) => log.push(message);

  beforeEach(async () => {
    behaviour.made.length = 0;
    behaviour.check = async () => [];
    behaviour.work = async () => ({ ok: true });
    log = [];
    sources = new Sources();
    router = sources.routes(new Router());
    await sources.replace([config("CRM"), config("Stats", { kind: "influxdb" })], logger);
  });
  afterEach(() => vi.restoreAllMocks());

  const call = async (method: string, path: string, body?: unknown) => {
    const answer = await router.handle(apiRequest(method, path, body));
    return { status: answer.status, body: answer.json as never };
  };

  it("lists the sources by name and connector, never their address or password", async () => {
    await sources.replace([config("CRM", { password: "secret", fields: { host: "db.internal" }, formerNames: ["Old CRM"] }), config("Odd", { kind: "unknown" })], logger);
    const answer = await call("GET", "/api/sources");
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([
      { name: "CRM", formerNames: ["Old CRM"], connector: "postgres" },
      { name: "Odd", connector: "none", problem: "No connector reads “unknown” sources" },
    ]);
    expect(JSON.stringify(answer.body)).not.toMatch(/secret|db\.internal/);
  });

  it("checks each source once, logging its warnings and what is wrong", async () => {
    behaviour.check = async () => ["the user can write"];
    log.length = 0;
    await sources.replace([config("A"), config("Odd", { kind: "unknown" })], logger);
    expect(log).toContain("[source A] warning: the user can write");
    expect(log).toContain("[source A] ready (postgres)");
    expect(log).toContain("[source Odd] No connector reads “unknown” sources");
    expect(sources.status("A")).toEqual({ connector: "postgres", warnings: ["the user can write"] });
    expect(sources.status("Odd")).toEqual({ problem: "No connector reads “unknown” sources" });
    expect(sources.status("Nobody")).toEqual({});
  });

  it("keeps a source whose connection fails, with its problem", async () => {
    behaviour.check = async () => {
      throw new Error("ECONNREFUSED");
    };
    await sources.replace([config("Down")], logger);
    expect(log).toContain("[source Down] Can't connect: ECONNREFUSED");
    expect(sources.status("Down")).toEqual({ connector: "postgres", problem: "Can't connect: ECONNREFUSED" });
    expect((await call("GET", "/api/sources")).body).toEqual([{ name: "Down", connector: "postgres", problem: "Can't connect: ECONNREFUSED" }]);
  });

  it("closes the connectors it replaces, also when closing fails", async () => {
    const [crm, stats] = behaviour.made.map((m) => m.connector as { closed: { value: boolean }; close: () => Promise<void> });
    stats.close = async () => {
      throw new Error("already closed");
    };
    await sources.replace([], logger);
    expect(crm.closed.value).toBe(true);
    expect((await call("GET", "/api/sources")).body).toEqual([]);
  });

  it("answers the tables, a description, a page of rows and a row from the connector", async () => {
    const seen: [string, unknown][] = [];
    behaviour.work = async (name, arg) => {
      seen.push([name, arg]);
      return name === "row" ? { key: "1", values: ["1", "Dune"] } : name === "tables" ? [{ schema: "public", name: "books" }] : { rows: [] };
    };
    expect(await call("GET", "/api/sources/CRM/tables")).toEqual({ status: 200, body: [{ schema: "public", name: "books" }] });
    expect(await call("POST", "/api/sources/CRM/describe", { target: shape.target })).toEqual({ status: 200, body: { rows: [] } });
    expect((await call("POST", "/api/sources/CRM/query", query)).status).toBe(200);
    expect(await call("POST", "/api/sources/CRM/row", { ...shape, keyValue: "1" })).toEqual({ status: 200, body: { row: { key: "1", values: ["1", "Dune"] } } });
    expect(seen.map(([name]) => name)).toEqual(["tables", "describe", "query", "row"]);
    expect(seen[1][1]).toEqual(shape.target);
  });

  it("fills in a query's search and group order when a device leaves them out", async () => {
    let asked: Record<string, unknown> = {};
    behaviour.work = async (_name, arg) => (asked = arg as Record<string, unknown>);
    const { search: _s, groupOrder: _g, ...older } = query;
    await call("POST", "/api/sources/CRM/query", older);
    expect(asked).toMatchObject({ search: "", groupOrder: "asc" });
    await call("POST", "/api/sources/CRM/query", { ...query, search: "dune", groupOrder: "count" });
    expect(asked).toMatchObject({ search: "dune", groupOrder: "count" });
  });

  it("describes a query as a target as well as a table", async () => {
    expect((await call("POST", "/api/sources/CRM/describe", { target: { query: "SELECT 1" } })).status).toBe(200);
  });

  it("refuses requests that aren't valid, before any connector sees them", async () => {
    const work = vi.fn(async () => ({}));
    behaviour.work = work;
    const { filter: _f, ...noFilter } = query;
    const bad: [string, unknown][] = [
      ["describe", undefined], ["describe", {}], ["describe", { target: {} }], ["describe", { target: { table: {} } }], ["describe", "[1]"], ["describe", "null"],
      ["query", { ...query, filter: { column: "x" } }], ["query", noFilter], ["query", { ...query, sort: "title" }], ["query", { ...query, timeZone: 3 }],
      ["query", { ...query, offset: "0" }], ["query", { ...query, limit: null }], ["query", { ...query, columns: "id" }], ["query", { ...query, key: 1 }], ["query", { ...query, untitled: undefined }],
      ["row", shape], ["row", { ...shape, keyValue: 1 }], ["row", {}],
    ];
    for (const [route, body] of bad) {
      const answer = await call("POST", `/api/sources/CRM/${route}`, body);
      expect([route, answer.status, answer.body]).toEqual([route, 400, { error: "Not a valid request" }]);
    }
    expect((await call("POST", "/api/sources/CRM/query", "{oops")).body).toEqual({ error: "The body isn't valid JSON" });
    expect((await call("POST", "/api/sources/CRM/query", new Uint8Array(1024 * 1024 + 1))).status).toBe(413);
    expect(work).not.toHaveBeenCalled();
  });

  it("answers 404 for a source it doesn't have, and 405 for the wrong method", async () => {
    expect(await call("GET", "/api/sources/Nope/tables")).toEqual({ status: 404, body: { error: "The server has no source “Nope”" } });
    expect((await call("POST", "/api/sources/Nope/row", { ...shape, keyValue: "1" })).status).toBe(404);
    expect((await call("DELETE", "/api/sources/CRM/tables")).status).toBe(405);
    expect((await call("GET", "/api/sources/CRM/query")).status).toBe(405);
  });

  it("reads a renamed source by a name it had, the new name winning if both exist", async () => {
    await sources.replace([config("Customers", { formerNames: ["CRM"] }), config("CRM2")], logger);
    expect((await call("GET", "/api/sources/CRM/tables")).status).toBe(200);
    expect((await call("GET", "/api/sources/Customers/tables")).status).toBe(200);
    await sources.replace([config("CRM"), config("Customers", { formerNames: ["CRM"] })], logger);
    behaviour.made.length = 0;
    const seen: string[] = [];
    behaviour.work = async () => seen.push("x");
    await call("GET", "/api/sources/CRM/tables");
    expect(seen).toHaveLength(1); // one connector asked, the one called CRM
    expect(sources.list().find((s) => s.name === "Customers")?.formerNames).toEqual(["CRM"]);
  });

  it("answers 502 for a source with no connector, saying why", async () => {
    await sources.replace([config("Odd", { kind: "unknown" })], logger);
    expect(await call("GET", "/api/sources/Odd/tables")).toEqual({ status: 502, body: { error: "No connector reads “unknown” sources" } });
  });

  it("answers 400 for what the source can't answer as asked, and leaves the source as it is", async () => {
    behaviour.work = async () => {
      throw new SourceError("There is no column “x”");
    };
    expect(await call("POST", "/api/sources/CRM/query", query)).toEqual({ status: 400, body: { error: "There is no column “x”" } });
    expect(sources.status("CRM")).toEqual({ connector: "postgres" });
  });

  it("passes on an HTTP error a connector throws", async () => {
    const { HttpError } = await import("../../shared/router.ts");
    behaviour.work = async () => {
      throw new HttpError(504, "Too slow");
    };
    expect(await call("GET", "/api/sources/CRM/tables")).toEqual({ status: 504, body: { error: "Too slow" } });
  });

  it("answers 502 for a source it can't read, notes it as its problem, and clears that once it reads again", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    behaviour.work = async () => {
      throw new Error("connection reset");
    };
    expect(await call("GET", "/api/sources/CRM/tables")).toEqual({ status: 502, body: { error: "CRM: connection reset" } });
    expect(errors).toHaveBeenCalled();
    expect(sources.status("CRM")).toEqual({ connector: "postgres", problem: "Can't read it: connection reset" });
    expect(sources.list()[0]).toMatchObject({ name: "CRM", problem: "Can't read it: connection reset" });
    behaviour.work = async () => [];
    expect((await call("GET", "/api/sources/CRM/tables")).status).toBe(200);
    expect(sources.status("CRM")).toEqual({ connector: "postgres" });
  });

  it("reports a thrown value that isn't an Error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    behaviour.work = async () => {
      throw "plain text";
    };
    expect((await call("GET", "/api/sources/CRM/tables")).body).toEqual({ error: "CRM: plain text" });
  });
});
