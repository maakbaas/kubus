import { describe, expect, it } from "vitest";
import type { SourceQuery } from "../../../shared/sources";
import { blendQueryResult, BlendCursor, nativeItems, nativeStream, remoteStream, type PartStream } from "./blendMerge";
import { resolveBlend } from "./blend";
import { applyQuery, defaultQuery, sortComparator, type FilterRule, type ViewQuery } from "./query";
import { COL, SHOP_COLUMNS, fakeSource, invoice, revenue, sale, shopSales, world, type Row } from "../test/blendWorld";
import type { Item } from "./model";

const ctx = { refLabel: () => "" };
const tz = "UTC";

const rule = (fieldId: string, operator: FilterRule["operator"], value = "", join?: "or"): FilterRule => ({ id: `${fieldId}-${operator}-${value}`, fieldId, operator, value, ...(join && { join }) });
const sorted = (fieldId: string, direction: "asc" | "desc" = "asc"): ViewQuery => ({ ...defaultQuery(), sort: [{ fieldId, direction }] });

const INVOICES: Item[] = [
  invoice(1, "Ada", 120, "2026-10-03"),
  invoice(2, "Bo", 80, "2026-10-12"),
  invoice(3, "Cy", 300, "2026-11-02"),
  invoice(4, "Di", 55, "2026-11-20"),
];
const SALES: Row[] = [
  sale(1, 20, "2026-10-01T09:00:00.000Z", "Eve"),
  sale(2, 35, "2026-10-12T20:00:00.000Z", "Fay", false),
  sale(3, 10, "2026-10-30T10:00:00.000Z", "Gus"),
  sale(4, 99, "2026-11-20T08:00:00.000Z", "Hal"),
  sale(5, 5, null, null),
];

/** The blend asked as a block asks it: every part's stream, merged by a cursor. */
function ask(opts: { query?: ViewQuery; search?: string; page?: number; items?: Item[]; sales?: Row[] } = {}) {
  const { query = sorted(COL.date), search = "", page = 100, items = INVOICES, sales = SALES } = opts;
  const source = fakeSource({ sales: { columns: SHOP_COLUMNS, key: "id", rows: sales } });
  const { parts } = resolveBlend(revenue, world);
  const streams: PartStream[] = parts.map((part) =>
    part.collection.source
      ? remoteStream(revenue, part, query, search, tz, source.ask)
      : nativeStream(revenue, nativeItems(revenue, part, items, new WeakMap()), query, search, ctx),
  );
  const groupField = query.groupBy ? revenue.fields.find((f) => f.id === query.groupBy) : undefined;
  const cursor = new BlendCursor(streams, sortComparator(revenue, query.sort, ctx), query, groupField, page);
  return { cursor, source };
}

/** All the rows' titles in the merged order (or `n` of them). */
async function names(opts: Parameters<typeof ask>[0] = {}, n = Infinity) {
  const { cursor, source } = ask(opts);
  await cursor.open();
  const rows = await cursor.take(n);
  return { who: rows.map((r) => r.item.values[COL.client] ?? null), rows, cursor, source };
}

describe("merging the parts' rows", () => {
  it("lists both parts' rows in the order of the sort, whichever part they come from", async () => {
    const { who, cursor } = await names();
    // Dates: Eve 10-01, Ada 10-03, Fay/Bo 10-12, Gus 10-30, Cy 11-02, Hal/Di 11-20, the empty date last. On the same day the
    // earlier part (the shop) comes first.
    expect(who).toEqual(["Eve", "Ada", "Fay", "Bo", "Gus", "Cy", "Hal", "Di", null]);
    expect(cursor.total).toBe(9);
    expect(cursor.done).toBe(true);
  });

  it("sorts the other way round, empty values last in both directions", async () => {
    expect((await names({ query: sorted(COL.date, "desc") })).who).toEqual(["Hal", "Di", "Cy", "Gus", "Fay", "Bo", "Ada", "Eve", null]);
  });

  it("sorts by a number across the parts", async () => {
    expect((await names({ query: sorted(COL.amount) })).who).toEqual([null, "Gus", "Eve", "Fay", "Di", "Bo", "Hal", "Ada", "Cy"]);
  });

  it("gives its rows a page at a time, asking a part for more only when its rows are used up", async () => {
    const { cursor, source } = ask({ page: 2 });
    await cursor.open();
    // The first pages of both parts: two rows each (counts asked with the first page only).
    expect(source.calls.map((c) => [c.offset, c.limit, c.counts])).toEqual([[0, 2, true]]);
    const first = await cursor.take(3);
    expect(first.map((r) => r.item.values[COL.client])).toEqual(["Eve", "Ada", "Fay"]);
    // The shop's first page held Eve and Fay: nothing more was asked yet.
    expect(source.calls).toHaveLength(1);
    expect(cursor.done).toBe(false);
    const second = await cursor.take(3);
    expect(second.map((r) => r.item.values[COL.client])).toEqual(["Bo", "Gus", "Cy"]);
    // The shop's rows 3 and 4 were needed for Gus and Hal, not before.
    expect(source.calls.map((c) => [c.offset, c.limit, c.counts])).toEqual([[0, 2, true], [2, 2, false]]);
    const rest = await cursor.take(10);
    expect(rest.map((r) => r.item.values[COL.client])).toEqual(["Hal", "Di", undefined]);
    expect(cursor.done).toBe(true);
    expect(source.calls.map((c) => c.offset)).toEqual([0, 2, 4]);
  });

  it("does not ask a part again for rows it has already given when only the other part's are used", async () => {
    // Only the invoices are in November: the shop's first page covers the first three rows asked for.
    const { cursor, source } = ask({ page: 5, query: sorted(COL.date, "desc") });
    await cursor.open();
    await cursor.take(2);
    expect(source.calls).toHaveLength(1);
  });

  it("is done as soon as the last row is given, and gives nothing more", async () => {
    const { cursor } = ask();
    await cursor.open();
    expect(await cursor.take(9)).toHaveLength(9);
    expect(cursor.done).toBe(true);
    expect(await cursor.take(5)).toEqual([]);
  });

  it("is empty when no part has a matching row", async () => {
    const { rows, cursor } = await names({ query: { ...defaultQuery(), filters: [rule(COL.client, "is", "Nobody")] } });
    expect(rows).toEqual([]);
    expect(cursor.total).toBe(0);
    expect(cursor.done).toBe(true);
  });

  it("works with a part that has no rows, or none at all", async () => {
    expect((await names({ sales: [] })).who).toEqual(["Ada", "Bo", "Cy", "Di"]);
    expect((await names({ items: [] })).who).toEqual(["Eve", "Fay", "Gus", "Hal", null]);
    expect((await names({ items: [], sales: [] })).who).toEqual([]);
  });
});

describe("a filter reaches every part, through its mapping", () => {
  it("filters on a mapped field in both: the native part's items, the remote part's source", async () => {
    const q = { ...defaultQuery(), sort: [{ fieldId: COL.date, direction: "asc" as const }], filters: [rule(COL.amount, "gt", "50")] };
    const { who, source } = await names({ query: q });
    expect(who).toEqual(["Ada", "Bo", "Cy", "Hal", "Di"]);
    // The source was asked for the column, not the merged field.
    expect(source.calls[0].filter).toEqual({ column: "total", operator: "gt", value: "50" });
  });

  it("filters by a date period: the date in the part's own type (a date & time by its day)", async () => {
    const q = { ...defaultQuery(), sort: [{ fieldId: COL.date, direction: "asc" as const }], filters: [rule(COL.date, "between", "2026-10-12..2026-11-02")] };
    const { who, source } = await names({ query: q });
    expect(who).toEqual(["Fay", "Bo", "Gus", "Cy"]);
    expect(source.calls[0].filter).toEqual({ column: "ordered_at", operator: "between", value: "2026-10-12..2026-11-02" });
  });

  it("counts a rule on a field a part doesn't map as not matching there, unless it matches an empty value", async () => {
    // Paid is mapped by the shop only: invoices have no value, so "is checked" matches no invoice...
    const checked = await names({ query: { ...defaultQuery(), filters: [rule(COL.paid, "isChecked")] } });
    expect(checked.who.sort()).toEqual(["Eve", "Gus", "Hal", null].sort());
    expect(checked.source.calls[0].filter).toEqual({ column: "paid", operator: "isChecked", value: "" });
    // ...while "is not checked" matches every invoice (an empty value isn't checked) and the unpaid sales.
    const unchecked = await names({ query: { ...defaultQuery(), filters: [rule(COL.paid, "isNotChecked")] } });
    expect(unchecked.who.sort()).toEqual(["Ada", "Bo", "Cy", "Di", "Fay"]);
  });

  it("asks the source nothing about a rule on a field it doesn't map: settled here for all its rows", async () => {
    // Invoices map no Paid: a part that maps nothing of the rule's field is the remote shop of a blend without it.
    const [sales] = resolveBlend({ ...revenue, blend: { ...revenue.blend!, parts: [{ collectionId: "sales", map: { [COL.amount]: "s-total" } }] } }, world).parts;
    const source = fakeSource({ sales: { columns: SHOP_COLUMNS, key: "id", rows: SALES } });
    const stream = (filters: FilterRule[]) =>
      remoteStream({ ...revenue, blend: { ...revenue.blend!, parts: [sales.part] } }, sales, { ...defaultQuery(), filters }, "", tz, source.ask).open(10);
    // "Who contains x" can't hold for rows with no Who: no row, and the source need not be asked (it is, with a filter that keeps none).
    expect((await stream([rule(COL.client, "contains", "e")])).rows).toEqual([]);
    expect(source.calls[0].filter).toEqual({ or: [] });
    // "Who is not Eve" holds for all.
    expect((await stream([rule(COL.client, "isNot", "Eve")])).rows).toHaveLength(5);
    expect(source.calls[1].filter).toEqual({ and: [] });
  });

  it("joins the rules as the app does: and narrows, or lets more in", async () => {
    const q = { ...defaultQuery(), sort: [{ fieldId: COL.date, direction: "asc" as const }], filters: [rule(COL.amount, "gt", "200"), rule(COL.client, "is", "Eve", "or")] };
    expect((await names({ query: q })).who).toEqual(["Eve", "Cy"]);
  });

  it("filters on the Source: a rule holds for all of a part's rows or none", async () => {
    const q = { ...defaultQuery(), sort: [{ fieldId: COL.date, direction: "asc" as const }], filters: [rule(COL.source, "is", "Invoices")] };
    const only = await names({ query: q });
    expect(only.who).toEqual(["Ada", "Bo", "Cy", "Di"]);
    expect(only.source.calls[0].filter).toEqual({ or: [] });
    const other = await names({ query: { ...q, filters: [rule(COL.source, "contains", "shop")] } });
    expect(other.who).toEqual(["Eve", "Fay", "Gus", "Hal", null]);
    expect(other.source.calls[0].filter).toEqual({ and: [] });
  });

  it("searches both parts' mapped text, and a search for a part's name finds all its rows", async () => {
    expect((await names({ search: "ada" })).who).toEqual(["Ada"]);
    expect((await names({ search: "gus" })).who).toEqual(["Gus"]);
    expect((await names({ search: "shop" })).who).toEqual(["Eve", "Fay", "Gus", "Hal", null]);
    expect((await names({ search: "invoices" })).who).toEqual(["Ada", "Bo", "Cy", "Di"]);
  });

  it("drops a sort on a field the part can't sort by or doesn't map, keeping the key order", async () => {
    const { source } = await names({ query: { ...defaultQuery(), sort: [{ fieldId: COL.source, direction: "asc" }, { fieldId: COL.amount, direction: "desc" }] } });
    expect(source.calls[0].sort).toEqual([{ column: "total", direction: "desc" }]);
  });
});

describe("groups across the parts", () => {
  const byWho = (order?: "asc" | "desc" | "count"): ViewQuery => ({ ...sorted(COL.amount), groupBy: COL.source, ...(order && { groupOrder: order }) });

  it("groups by the Source: one group per part, sized by its rows, the rows in sort order in each", async () => {
    const { rows, cursor, source } = await names({ query: byWho() });
    expect(cursor.groups.map((g) => [g.key, g.label, g.count])).toEqual([["Invoices", "Invoices", 4], ["Shop sales", "Shop sales", 5]]);
    expect(rows.map((r) => [r.group, r.item.values[COL.client]])).toEqual([
      ["Invoices", "Di"], ["Invoices", "Bo"], ["Invoices", "Ada"], ["Invoices", "Cy"],
      ["Shop sales", undefined], ["Shop sales", "Gus"], ["Shop sales", "Eve"], ["Shop sales", "Fay"], ["Shop sales", "Hal"],
    ]);
    // The source isn't asked to group by what it doesn't have.
    expect(source.calls[0].groupBy).toBeNull();
  });

  it("orders the groups by value either way, or the largest first", async () => {
    expect((await names({ query: byWho("desc") })).cursor.groups.map((g) => g.key)).toEqual(["Shop sales", "Invoices"]);
    expect((await names({ query: byWho("count") })).cursor.groups.map((g) => g.key)).toEqual(["Shop sales", "Invoices"]);
  });

  it("sums a group's size over the parts when both have it, and lists a group only one has", async () => {
    const items = [invoice(1, "Eve", 10, "2026-10-01"), invoice(2, "Zed", 10, "2026-10-01")];
    const { cursor, rows } = await names({ items, query: { ...sorted(COL.amount), groupBy: COL.client } });
    // Eve in both parts (a sale and an invoice), the rest in one; the empty group (a sale without a customer) last.
    expect(cursor.groups.map((g) => [g.key, g.count])).toEqual([["Eve", 2], ["Fay", 1], ["Gus", 1], ["Hal", 1], ["Zed", 1], ["", 1]]);
    expect(rows.filter((r) => r.group === "Eve").map((r) => r.item.values[COL.source])).toEqual(["Invoices", "Shop sales"]);
    expect(cursor.total).toBe(7);
  });

  it("orders groups by their size summed over the parts, not each part's own", async () => {
    // Invoices list "b" first, the shop "a" first; together "b" (3 + 1) is the larger.
    const items = [invoice(1, "b", 1, "2026-10-01"), invoice(2, "b", 1, "2026-10-01"), invoice(3, "b", 1, "2026-10-01"), invoice(4, "a", 1, "2026-10-01")];
    const sales = [sale(1, 1, null, "a"), sale(2, 1, null, "a"), sale(3, 1, null, "b")];
    const { cursor, rows } = await names({ items, sales, query: { ...sorted(COL.amount), groupBy: COL.client, groupOrder: "count" } });
    expect(cursor.groups.map((g) => [g.key, g.count])).toEqual([["b", 4], ["a", 3]]);
    // Rows come group by group in that order though the shop lists its own groups the other way round.
    expect(rows.map((r) => r.group)).toEqual(["b", "b", "b", "b", "a", "a", "a"]);
  });

  it("groups by a field a part doesn't map into the empty group of that part's rows", async () => {
    const { cursor, rows } = await names({ query: { ...sorted(COL.amount), groupBy: COL.paid } });
    // The invoices have no Paid: their rows are in "Not checked", as a native item without a value is.
    expect(cursor.groups.map((g) => [g.key, g.count])).toEqual([["yes", 4], ["no", 5]]);
    expect(rows.filter((r) => r.item.values[COL.source] === "Invoices").every((r) => r.group === "no")).toBe(true);
  });

  it("gives a page of a grouped list group by group: a group's rows from every part before the next group's", async () => {
    const { cursor } = ask({ page: 2, query: byWho("asc") });
    await cursor.open();
    const first = await cursor.take(5);
    expect(first.map((r) => r.group)).toEqual(["Invoices", "Invoices", "Invoices", "Invoices", "Shop sales"]);
    const rest = await cursor.take(10);
    expect(rest).toHaveLength(4);
    expect(cursor.done).toBe(true);
  });

  it("groups a date field by day across a date & time and a date", async () => {
    const items = [invoice(1, "Ada", 1, "2026-10-12")];
    const { cursor } = await names({ items, query: { ...sorted(COL.amount), groupBy: COL.date } });
    const keys = cursor.groups.map((g) => g.key);
    // The shop's two sales on 12 October (UTC) and the invoice share a day; every key is a day, the empty one last.
    expect(keys.slice(0, 4)).toEqual(["2026-10-01", "2026-10-12", "2026-10-30", "2026-11-20"]);
    expect(cursor.groups.find((g) => g.key === "2026-10-12")).toMatchObject({ count: 2, label: "12 Oct 2026" });
    expect(keys.at(-1)).toBe("");
  });
});

describe("the block's result", () => {
  it("is one group of the rows so far, with the total over the parts", async () => {
    const { rows, cursor } = await names();
    const { result, items } = blendQueryResult(rows.slice(0, 3), cursor.groups, cursor.total, false);
    expect(result.total).toBe(9);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].items.map((i) => i.values[COL.client])).toEqual(["Eve", "Ada", "Fay"]);
    expect(items).toEqual(result.groups[0].items);
  });

  it("is a group per key with rows in, in the groups' order, each item once in the list of all", async () => {
    const { rows, cursor } = await names({ query: { ...sorted(COL.amount), groupBy: COL.source } });
    const { result, items } = blendQueryResult(rows.slice(0, 5), cursor.groups, cursor.total, true);
    expect(result.groups.map((g) => [g.key, g.items.length])).toEqual([["Invoices", 4], ["Shop sales", 1]]);
    expect(items).toHaveLength(5);
  });
});

describe("the same as a native collection would give", () => {
  it("lists native parts exactly as applyQuery lists the blend's items", async () => {
    const [, inv] = resolveBlend(revenue, world).parts;
    const made = nativeItems(revenue, inv, INVOICES, new WeakMap());
    for (const query of [sorted(COL.amount), sorted(COL.date, "desc"), { ...sorted(COL.client), filters: [rule(COL.amount, "lt", "100")] }]) {
      const expected = applyQuery(revenue, made, query, ctx).groups.flatMap((g) => g.items);
      const cursor = new BlendCursor([nativeStream(revenue, made, query, "", ctx)], sortComparator(revenue, query.sort, ctx), query, undefined, 2);
      await cursor.open();
      expect(await cursor.take(100)).toEqual(expected.map((item) => ({ item, group: "" })));
    }
  });

  it("keeps a blend item once made for an item that didn't change", () => {
    const [, inv] = resolveBlend(revenue, world).parts;
    const memo = new WeakMap();
    const first = nativeItems(revenue, inv, INVOICES, memo);
    const again = nativeItems(revenue, inv, [...INVOICES.slice(0, 3), { ...INVOICES[3], values: { ...INVOICES[3].values, "i-price": 56 } }], memo);
    expect(again.slice(0, 3).every((item, i) => item === first[i])).toBe(true);
    expect(again[3]).not.toBe(first[3]);
    expect(again[3].values[COL.amount]).toBe(56);
  });
});

describe("a failing part", () => {
  it("fails the open, not the rows of the others silently", async () => {
    const { parts } = resolveBlend(revenue, world);
    const failing: PartStream = { open: () => Promise.reject(new Error("The Kubus server can't be reached")), next: () => Promise.reject(new Error("no")) };
    const cursor = new BlendCursor([failing, nativeStream(revenue, nativeItems(revenue, parts[1], INVOICES, new WeakMap()), defaultQuery(), "", ctx)], () => 0, defaultQuery(), undefined, 10);
    await expect(cursor.open()).rejects.toThrow("can't be reached");
  });
});

// The source's own order differs from the app's only by collation; a note for the docs, pinned here.
describe("the remote request", () => {
  it("is the blend's query in the part's columns: filter tree, sort, search and time zone", async () => {
    const source = fakeSource({ sales: { columns: SHOP_COLUMNS, key: "id", rows: SALES } });
    const [sales] = resolveBlend(revenue, world).parts;
    const query: ViewQuery = { ...sorted(COL.amount, "desc"), filters: [rule(COL.client, "contains", "e")], inherited: [rule(COL.date, "between", "2026-10-01..2026-10-31")] };
    await remoteStream(revenue, sales, query, "x", "Europe/Amsterdam", source.ask).open(7);
    const call = source.calls[0] as SourceQuery;
    expect(call).toMatchObject({
      target: shopSales.source!.target,
      key: "id",
      columns: ["ordered_at", "customer", "paid", "meta", "total"],
      title: ["customer", "meta"],
      filter: { and: [{ column: "ordered_at", operator: "between", value: "2026-10-01..2026-10-31" }, { column: "customer", operator: "contains", value: "e" }] },
      search: "x",
      sort: [{ column: "total", direction: "desc" }],
      groupBy: null,
      timeZone: "Europe/Amsterdam",
      offset: 0,
      limit: 7,
      counts: true,
    });
  });
});
