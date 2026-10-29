// A small world for the blend's tests: a native collection (Invoices), a remote one (Shop sales) behind a stand-in source that
// filters, sorts, groups and pages as the server's connectors do, and the Revenue blend over both.

import { betweenBounds, TITLE_COLUMN, type SourceColumn, type SourceCondition, type SourceQuery, type SourceResult, type SourceValue } from "../../../shared/sources";
import { mergeCollections } from "../domain/blend";
import { blankField, type Collection, type Item } from "../domain/model";
import { naturalCompare } from "../domain/query";

const base = { icon: null, description: "", itemViews: [], spaceIds: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };

export const SHOP_COLUMNS: SourceColumn[] = [
  { name: "id", type: "integer", kind: "number" },
  { name: "total", type: "numeric", kind: "number" },
  { name: "ordered_at", type: "timestamptz", kind: "datetime" },
  { name: "customer", type: "text", kind: "string" },
  { name: "paid", type: "boolean", kind: "checkbox" },
  { name: "meta", type: "jsonb", kind: "string", plain: true },
];

/** Shop sales: remote, read from the source "Shop". */
export const shopSales: Collection = {
  ...base,
  id: "sales",
  name: "Shop sale",
  pluralName: "Shop sales",
  source: { name: "Shop", target: { table: { schema: "public", name: "sales" } }, key: "id", columns: SHOP_COLUMNS },
  fields: [
    blankField("s-total", "Total", "number", { collectionId: "sales", column: "total" }),
    blankField("s-at", "Date", "datetime", { collectionId: "sales", column: "ordered_at" }),
    blankField("s-customer", "Client", "string", { collectionId: "sales", column: "customer" }),
    blankField("s-paid", "Paid", "checkbox", { collectionId: "sales", column: "paid" }),
    blankField("s-meta", "Meta", "string", { collectionId: "sales", column: "meta" }),
  ],
};

/** Invoices: a native collection. */
export const invoices: Collection = {
  ...base,
  id: "invoices",
  name: "Invoice",
  pluralName: "Invoices",
  fields: [
    blankField("i-client", "Client", "string", { collectionId: "invoices" }),
    blankField("i-price", "Price", "number", { collectionId: "invoices" }),
    blankField("i-date", "Date", "date", { collectionId: "invoices" }),
    blankField("i-note", "Note", "markdown", { collectionId: "invoices" }),
    blankField("i-link", "Related", "item", { collectionId: "invoices", targetCollectionId: "invoices" }),
  ],
};

export const invoice = (n: number, client: string, price: number, date: string): Item => ({
  id: `inv${n}`,
  collectionId: "invoices",
  spaceId: "default",
  values: { "i-client": client, "i-price": price, "i-date": date },
  createdAt: `2026-02-0${n}T00:00:00.000Z`,
  updatedAt: `2026-02-0${n}T00:00:00.000Z`,
});

/** The columns of the two read as one: Amount (Total and Price merged by hand), Date and Client (merged by name), Paid, Meta, Note. */
export const MERGES = [{ id: "m1", name: "Amount", fields: ["sales/s-total", "invoices/i-price"] }];
export const revenue: Collection = mergeCollections(["sales", "invoices"], [shopSales, invoices], MERGES).collection;
/** The merged columns' ids. */
export const COL = { amount: "merged:m1", date: "merged:name:date", client: "merged:name:client", paid: "merged:name:paid", source: "merged:collection" };

export const world = [shopSales, invoices];

// --- The stand-in source ----------------------------------------------------------------------------

export type Row = Record<string, SourceValue>;

const day = (v: SourceValue) => (typeof v === "string" ? v.slice(0, 10) : "");
const text = (v: SourceValue) => (v === null || v === undefined ? "" : Array.isArray(v) ? v.join(", ") : String(v));

function holds(c: SourceCondition, row: Row, kinds: Map<string, string>): boolean {
  if ("and" in c) return c.and.every((x) => holds(x, row, kinds));
  if ("or" in c) return c.or.some((x) => holds(x, row, kinds));
  const v = row[c.column] ?? null;
  const kind = kinds.get(c.column);
  const empty = v === null || v === "" || (Array.isArray(v) && v.length === 0);
  switch (c.operator) {
    case "isEmpty": return empty;
    case "isNotEmpty": return !empty;
    case "isChecked": return v === true;
    case "isNotChecked": return v !== true;
    case "contains": return text(v).toLowerCase().includes(c.value.toLowerCase());
    case "notContains": return !text(v).toLowerCase().includes(c.value.toLowerCase());
    case "gt": return typeof v === "number" && v > Number(c.value);
    case "lt": return typeof v === "number" && v < Number(c.value);
    case "before": return !!day(v) && day(v) < c.value;
    case "after": return !!day(v) && day(v) > c.value;
    case "between": {
      const b = betweenBounds(c.value);
      return !!b && !!day(v) && day(v) >= b.start.slice(0, 10) && day(v) <= b.end.slice(0, 10);
    }
    case "is":
    case "isNot": {
      const equal = kind === "number" ? v === Number(c.value) : kind === "checkbox" ? (v === true) === (c.value === "true") : kind === "date" || kind === "datetime" ? day(v) === c.value : text(v).toLowerCase() === c.value.toLowerCase();
      return c.operator === "is" ? equal : !equal;
    }
  }
}

const sortKey = (v: SourceValue): string | number | null => (v === null || v === "" ? null : typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : text(v).toLowerCase());
const compare = (a: string | number | null, b: string | number | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : typeof a === "number" && typeof b === "number" ? a - b : naturalCompare(String(a), String(b)));

const groupKeyOf = (v: SourceValue, kind: string | undefined): string[] => {
  if (kind === "checkbox") return [v === true ? "yes" : "no"];
  if (kind === "date" || kind === "datetime") return [day(v)];
  if (Array.isArray(v)) return v.length ? v : [""];
  return [text(v)];
};

/**
 * A source answering a query as the connectors do (filter tree, search, sort with empty last and the key as tie-break, group,
 * page, counts). `calls` records every query it was asked.
 */
export function fakeSource(tables: Record<string, { columns: SourceColumn[]; key: string; rows: Row[] }>) {
  const calls: SourceQuery[] = [];
  const ask = async (_source: string, q: SourceQuery): Promise<SourceResult> => {
    calls.push(q);
    const name = "table" in q.target ? q.target.table.name : "";
    const table = tables[name];
    const kinds = new Map(table.columns.map((c) => [c.name, c.kind]));
    let rows = table.rows.filter((r) => holds(q.filter, r, kinds));
    if (q.search) rows = rows.filter((r) => table.columns.some((c) => c.kind === "string" && text(r[c.name]).toLowerCase().includes(q.search.toLowerCase())));
    const titleOf = (r: Row) => {
      for (const c of q.title) if (text(r[c]).trim()) return text(r[c]).toLowerCase();
      return null;
    };
    const keyed = (r: Row, s: { column: string }) => (s.column === TITLE_COLUMN ? titleOf(r) : sortKey(r[s.column] ?? null));
    const bySort = (a: Row, b: Row) => {
      for (const s of q.sort) {
        const ka = keyed(a, s);
        const kb = keyed(b, s);
        const c = ka === null || kb === null ? compare(ka, kb) : compare(ka, kb) * (s.direction === "desc" ? -1 : 1);
        if (c !== 0) return c;
      }
      return compare(sortKey(a[q.key]), sortKey(b[q.key]));
    };
    rows = [...rows].sort(bySort);
    const out: { row: Row; group?: string }[] = rows.map((row) => ({ row }));
    let groups: { key: string; count: number }[] | undefined;
    if (q.groupBy) {
      const kind = kinds.get(q.groupBy);
      const by = new Map<string, Row[]>();
      for (const r of rows) for (const key of groupKeyOf(r[q.groupBy] ?? null, kind)) by.set(key, [...(by.get(key) ?? []), r]);
      const keys = [...by.keys()].sort((a, b) => {
        if (a === "" || b === "") return a === "" ? 1 : -1;
        if (q.groupOrder === "count" && by.get(a)!.length !== by.get(b)!.length) return by.get(b)!.length - by.get(a)!.length;
        return compare(a, b) * (q.groupOrder === "desc" ? -1 : 1);
      });
      groups = keys.map((key) => ({ key, count: by.get(key)!.length }));
      out.length = 0;
      for (const key of keys) for (const row of by.get(key)!) out.push({ row, group: key });
    }
    const page = out.slice(q.offset, q.offset + q.limit);
    return {
      rows: page.map(({ row, group }) => ({ key: text(row[q.key]), values: q.columns.map((c) => row[c] ?? null), ...(group !== undefined && { group }) })),
      more: q.offset + q.limit < out.length,
      ...(q.counts && { total: rows.length, ...(groups && { groups }) }),
    };
  };
  return { ask, calls };
}

/** Shop sales' rows: `n` sales on consecutive days from `from`. */
export const sale = (id: number, total: number | null, at: string | null, customer: string | null, paid = true): Row => ({ id, total, ordered_at: at, customer, paid, meta: null });
