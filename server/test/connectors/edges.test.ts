// @vitest-environment node
// The rows just outside a date period (server/src/sources.ts queryWithEdges), asked of any connector beside a page.
import { describe, expect, it } from "vitest";
import { queryWithEdges } from "../../src/sources.ts";
import { queryRows, type MemoryRow } from "../../src/connectors/memory.ts";
import type { Connector } from "../../src/connectors/connector.ts";
import type { SourceColumn, SourceQuery } from "../../../shared/sources.ts";

const columns = new Map<string, SourceColumn>(
  [
    { name: "id", type: "id", kind: "number" },
    { name: "kg", type: "number", kind: "number" },
    { name: "at", type: "date", kind: "date" },
  ].map((c) => [c.name, c as SourceColumn]),
);
const rows: MemoryRow[] = [
  { id: 1, kg: 80, at: "2026-08-20" },
  { id: 2, kg: 79, at: "2026-09-25" },
  { id: 3, kg: 78, at: "2026-10-10" },
  { id: 4, kg: 77, at: "2026-11-03" },
  { id: 5, kg: 76, at: "2026-12-01" },
];
let asked = 0;
const connector = (fail = false) =>
  ({
    query: async (q: SourceQuery) => {
      asked++;
      if (fail && q.limit === 1) throw new Error("no");
      return queryRows(rows, columns, q);
    },
  }) as unknown as Connector;
const october = { column: "at", operator: "between" as const, value: "2026-10-01..2026-10-31" };
const query = (over: Partial<SourceQuery> = {}): SourceQuery => ({
  target: { table: { schema: null, name: "weights" } },
  key: "id",
  columns: ["kg", "at"],
  title: [],
  untitled: "Weight",
  filter: october,
  search: "",
  sort: [{ column: "at", direction: "asc" }],
  groupBy: null,
  groupOrder: "asc",
  timeZone: "UTC",
  offset: 0,
  limit: 100,
  counts: true,
  edges: {
    column: "at",
    before: { ...october, value: "1700-01-01..2026-09-30" },
    after: { ...october, value: "2026-11-01..2261-12-31" },
  },
  ...over,
});

describe("queryWithEdges", () => {
  it("gives the page and the nearest row before and after the period", async () => {
    const r = await queryWithEdges(connector(), query());
    expect(r.rows.map((x) => x.key)).toEqual(["3"]);
    expect(r.edges).toEqual({ before: expect.objectContaining({ key: "2" }), after: expect.objectContaining({ key: "4" }) });
  });

  it("asks only with the first page, and an edge the source can't give is none", async () => {
    asked = 0;
    expect((await queryWithEdges(connector(), query({ offset: 100 }))).edges).toBeUndefined();
    expect(asked).toBe(1);
    expect((await queryWithEdges(connector(true), query())).edges).toEqual({ before: null, after: null });
    expect((await queryWithEdges(connector(), query({ edges: undefined }))).edges).toBeUndefined();
  });
});
