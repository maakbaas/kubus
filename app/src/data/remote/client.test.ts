import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceQuery } from "../../../../shared/sources";
import { SourcesClient } from "./client";

const query = (over: Partial<SourceQuery> = {}): SourceQuery => ({
  target: { table: { schema: null, name: "people" } }, key: "id", columns: ["name"], title: ["name"], untitled: "Person",
  filter: { and: [] }, search: "", sort: [], groupBy: null, groupOrder: "asc", timeZone: "UTC", offset: 0, limit: 10, counts: true, ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("SourcesClient", () => {
  it("asks a query on its way once, and again once it is answered", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      asked.push(`${url} ${init.body}`);
      return Response.json({ rows: [], more: false, total: asked.length });
    });
    const client = new SourcesClient(() => ({ url: "https://kubus.example", token: "t" }) as never);
    const [a, b, other, elsewhere] = await Promise.all([
      client.query("db", query()),
      client.query("db", query()),
      client.query("db", query({ offset: 10 })),
      client.query("files", query()),
    ]);
    expect(a).toBe(b);
    expect(asked).toHaveLength(3);
    expect(other).not.toBe(a);
    expect(elsewhere).not.toBe(a);
    await client.query("db", query());
    expect(asked).toHaveLength(4);
  });
  it("forgets a query that failed", async () => {
    let fail = true;
    vi.stubGlobal("fetch", async () => (fail ? Response.json({ error: "down" }, { status: 502 }) : Response.json({ rows: [], more: false })));
    const client = new SourcesClient(() => ({ url: "https://kubus.example", token: "t" }) as never);
    await expect(client.query("db", query())).rejects.toThrow("down");
    fail = false;
    await expect(client.query("db", query())).resolves.toEqual({ rows: [], more: false });
  });
});
