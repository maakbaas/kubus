import { describe, expect, it } from "vitest";
import {
  BLEND_KINDS,
  blendItem,
  blendItemId,
  blendPath,
  blendRowItem,
  blendValue,
  canShow,
  hasRemotePart,
  mergeCandidates,
  mergeCollections,
  partConstants,
  partFields,
  partProjection,
  readKind,
  resolveBlend,
  SOURCE_COLUMN,
} from "./blend";
import { itemPath } from "./backlinks";
import { blankField, itemLabel, titleFields, type Collection, type FieldKind } from "./model";
import { isReadOnly, rowItemId, sourceShape } from "./sources";
import { COL, invoice, invoices, MERGES, revenue, shopSales, world } from "../test/blendWorld";

const ALL_KINDS: FieldKind[] = ["string", "markdown", "html", "number", "date", "datetime", "checkbox", "image", "item", "string_list", "checklist", "item_list", "component", "ai"];

describe("which part fields a column can show (the type matrix)", () => {
  // Rows: the column's type; the kinds it can show.
  const SHOWS: Record<string, FieldKind[]> = {
    string: ["string", "markdown", "html"],
    markdown: ["string", "markdown", "html"],
    html: ["string", "markdown", "html"],
    number: ["number"],
    date: ["date", "datetime"],
    datetime: ["datetime"],
    checkbox: ["checkbox"],
    string_list: ["string_list"],
  };

  it("is exactly this, for every pair of types", () => {
    for (const to of BLEND_KINDS) {
      for (const from of ALL_KINDS.filter((k) => k !== "ai")) {
        expect(canShow(to, readKind({ kind: from, output: null })), `${to} ← ${from}`).toBe(SHOWS[to].includes(from));
      }
    }
  });

  it("covers every type a column can have", () => {
    expect([...BLEND_KINDS].sort()).toEqual(Object.keys(SHOWS).sort());
  });

  it("never shows what has no plain value (references, images, checklists, component fields) or nothing", () => {
    for (const from of ["image", "item", "item_list", "checklist", "component"] as FieldKind[]) {
      expect(readKind({ kind: from, output: null })).toBeNull();
      for (const to of BLEND_KINDS) expect(canShow(to, readKind({ kind: from, output: null }))).toBe(false);
    }
    expect(canShow("string", null)).toBe(false);
  });

  it("reads an AI field as the text, number or Markdown it holds", () => {
    expect(readKind({ kind: "ai", output: "number" })).toBe("number");
    expect(readKind({ kind: "ai", output: "markdown" })).toBe("markdown");
    expect(readKind({ kind: "ai", output: "string" })).toBe("string");
    expect(canShow("number", readKind({ kind: "ai", output: "number" }))).toBe(true);
    expect(canShow("string", readKind({ kind: "ai", output: "number" }))).toBe(false);
  });

  it("turns a date & time into its day (the device's) for a date column, and leaves every other value as it is", () => {
    const noon = new Date(2026, 9, 5, 12, 0).toISOString();
    expect(blendValue("datetime", "date", noon)).toBe("2026-10-05");
    expect(blendValue("datetime", "date", new Date(2026, 9, 5, 23, 59).toISOString())).toBe("2026-10-05");
    expect(blendValue("datetime", "date", null)).toBeNull();
    expect(blendValue("datetime", "date", "")).toBe("");
    expect(blendValue("date", "date", "2026-10-05")).toBe("2026-10-05");
    expect(blendValue("datetime", "datetime", noon)).toBe(noon);
    expect(blendValue("string", "markdown", "# x")).toBe("# x");
    expect(blendValue("number", "number", 3)).toBe(3);
  });
});

describe("merging collections into the one a block reads", () => {
  const merged = (ids: string[], collections: Collection[] = world, merges = MERGES) => mergeCollections(ids, collections, merges);
  const columns = (c: Collection) => c.fields.map((f) => [f.id, f.name, f.kind]);

  it("merges fields of one name (case aside) whose types fit, by hand merges first, and adds the Collection column", () => {
    const { collection, problems } = merged(["sales", "invoices"]);
    expect(problems).toEqual([]);
    expect(columns(collection)).toEqual([
      // A date & time and a date: a date column (the day).
      [COL.date, "Date", "date"],
      [COL.client, "Client", "string"],
      [COL.paid, "Paid", "checkbox"],
      ["merged:name:meta", "Meta", "string"],
      ["merged:name:note", "Note", "markdown"],
      // The columns merged by hand after the others, Collection last.
      [COL.amount, "Amount", "number"],
      [SOURCE_COLUMN, "Collection", "string"],
    ]);
    // Which field of each part every column shows: a field only one has is empty for the other.
    expect(collection.blend!.parts).toEqual([
      { collectionId: "sales", map: { [COL.amount]: "s-total", [COL.date]: "s-at", [COL.client]: "s-customer", [COL.paid]: "s-paid", "merged:name:meta": "s-meta" } },
      { collectionId: "invoices", map: { [COL.amount]: "i-price", [COL.date]: "i-date", [COL.client]: "i-client", "merged:name:note": "i-note" } },
    ]);
    expect(collection.pluralName).toBe("Shop sales + Invoices");
    expect(isReadOnly(collection)).toBe(true);
  });

  it("keeps the same ids for the same collections, however the others change (blocks keep them in their layout)", () => {
    expect(merged(["sales", "invoices"]).collection.fields.map((f) => f.id)).toEqual(merged(["sales", "invoices"]).collection.fields.map((f) => f.id));
    const without = merged(["sales", "invoices"], world, []);
    expect(without.collection.fields.map((f) => f.id)).toContain("merged:name:total");
    expect(without.collection.fields.map((f) => f.id)).toContain("merged:name:price");
  });

  it("makes separate columns of fields with one name that can't be shown alike, the later named with their collection", () => {
    const text = { ...invoices, fields: invoices.fields.map((f) => (f.id === "i-price" ? { ...f, name: "Total" } : f)) };
    const { collection } = mergeCollections(["sales", "invoices"], [shopSales, text], []);
    const totals = collection.fields.filter((f) => f.name.startsWith("Total"));
    expect(totals.map((f) => [f.id, f.name, f.kind])).toEqual([["merged:name:total", "Total", "number"]]);
    const clash = { ...invoices, fields: [blankField("i-total", "total", "string", { collectionId: "invoices" })] };
    const split = mergeCollections(["sales", "invoices"], [shopSales, clash], []).collection;
    expect(split.fields.filter((f) => f.name.toLowerCase().startsWith("total")).map((f) => [f.id, f.name, f.kind])).toEqual([
      ["merged:name:total", "Total", "string"],
      ["merged:name:total#1", "Total (Shop sales)", "number"],
    ]);
  });

  it("leaves out fields that can't be in a column (references)", () => {
    expect(merged(["invoices"]).collection.fields.map((f) => f.name)).not.toContain("Related");
  });

  it("names a collection that is gone and a merged column that lost a field, and merges the rest", () => {
    const gone = merged(["sales", "invoices"], [invoices]);
    expect(gone.problems).toEqual([{ part: "sales", message: "A collection this block listed was deleted." }]);
    expect(gone.collection.blend!.parts.map((p) => p.collectionId)).toEqual(["invoices"]);
    expect(gone.collection.blend!.problems).toEqual(gone.problems);
    const lost = merged(["sales", "invoices"], [shopSales, { ...invoices, fields: invoices.fields.filter((f) => f.id !== "i-price") }]);
    expect(lost.problems.map((p) => p.message)).toEqual(["The merged column “Amount” lost a field of Invoices."]);
    // The column stays with the field that is left.
    expect(lost.collection.blend!.parts[0].map[COL.amount]).toBe("s-total");
    expect(lost.collection.blend!.parts[1].map[COL.amount]).toBeUndefined();
  });

  it("refuses to merge by hand fields that can't be shown alike", () => {
    const odd = [{ id: "x", name: "Odd", fields: ["sales/s-total", "invoices/i-client"] }];
    const { problems } = mergeCollections(["sales", "invoices"], world, odd);
    expect(problems.map((p) => p.message)).toEqual(["The merged column “Odd” has fields that can't be shown alike."]);
  });

  it("offers for a hand merge the other collections' fields that can be shown alike", () => {
    const total = shopSales.fields.find((f) => f.id === "s-total")!;
    expect(mergeCandidates(total, "sales", world).map((c) => c.field.name)).toEqual(["Price"]);
    const client = shopSales.fields.find((f) => f.id === "s-customer")!;
    expect(mergeCandidates(client, "sales", world).map((c) => c.field.name)).toEqual(["Client", "Note"]);
  });
});

describe("a merged collection's parts", () => {
  it("reads the fields a part can offer: a native one's, a remote one's columns", () => {
    expect(partFields(invoices).map((f) => f.name)).toEqual(["Client", "Price", "Date", "Note"]);
    expect(partFields(shopSales).map((f) => f.name)).toEqual(["Total", "Date", "Client", "Paid", "Meta"]);
  });

  it("knows whether it has a remote part", () => {
    expect(hasRemotePart(revenue, world)).toBe(true);
    expect(hasRemotePart(revenue, [invoices])).toBe(false);
    expect(hasRemotePart({ blend: null }, world)).toBe(false);
  });

  it("resolves its parts with the fields they show", () => {
    const { parts, problems } = resolveBlend(revenue, world);
    expect(problems).toEqual([]);
    expect(parts.map((p) => [p.collection.id, p.label])).toEqual([["sales", "Shop sales"], ["invoices", "Invoices"]]);
    expect([...parts[1].fields.keys()]).toEqual([COL.date, COL.client, "merged:name:note", COL.amount]);
  });

  it("opens a row's own item or remote row", () => {
    expect(itemPath(revenue, { id: blendItemId("invoices", "inv1") })).toBe("/collections/invoices/items/inv1");
    expect(itemPath(revenue, { id: blendItemId("sales", rowItemId("7")) })).toBe(`/collections/sales/items/${rowItemId("7")}`);
    expect(blendPath("a:b:c")).toBe("/collections/a/items/b:c");
  });
});

describe("a merged collection's rows", () => {
  const [sales, inv] = resolveBlend(revenue, world).parts;

  it("are a native part's items through the mapping, with the part's name in Collection", () => {
    const item = blendItem(revenue, inv, invoice(1, "Ada", 120, "2026-02-03"));
    expect(item).toEqual({
      id: "invoices:inv1",
      collectionId: revenue.id,
      spaceId: "default",
      values: { [COL.amount]: 120, [COL.date]: "2026-02-03", [COL.client]: "Ada", [COL.source]: "Invoices" },
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(item.values).not.toHaveProperty(COL.paid);
    expect(blendItem(revenue, inv, { ...invoice(2, "Bo", 1, "2026-02-04"), values: {} }).values).toEqual({ [COL.source]: "Invoices" });
  });

  it("are a remote part's rows through the same mapping, a date & time shown as a date", () => {
    const projection = partProjection(revenue, sales);
    const shape = sourceShape(projection);
    expect(shape.columns).toEqual(["ordered_at", "customer", "paid", "meta", "total"]);
    const at = new Date(2026, 9, 5, 12, 0).toISOString();
    const item = blendRowItem(revenue, sales, projection, shape, { key: "42", values: [at, "Bo", true, null, 99.5] });
    expect(item).toMatchObject({ id: `sales:${rowItemId("42")}`, values: { [COL.amount]: 99.5, [COL.date]: "2026-10-05", [COL.client]: "Bo", [COL.paid]: true, [COL.source]: "Shop sales" } });
  });

  it("are called by the first text field with a value, never Collection unless it is chosen; Created and Updated are there", () => {
    expect(titleFields(revenue).map((f) => f.id)).toEqual([COL.client, "merged:name:meta"]);
    const item = blendItem(revenue, inv, invoice(1, "Ada", 120, "2026-02-03"));
    expect(itemLabel(revenue, item)).toBe("Ada");
    expect(itemLabel(revenue, { ...item, values: { ...item.values, [COL.client]: "" } })).toBe("Item");
    expect(itemLabel({ ...revenue, titleField: COL.source }, item)).toBe("Invoices");
  });
});

describe("a remote part as a collection of the merged columns", () => {
  const [sales] = resolveBlend(revenue, world).parts;

  it("has the columns it shows, each on the part's source column", () => {
    const projection = partProjection(revenue, sales);
    expect(projection.fields.map((f) => [f.id, f.kind, f.column])).toEqual([
      [COL.date, "date", "ordered_at"],
      [COL.client, "string", "customer"],
      [COL.paid, "checkbox", "paid"],
      ["merged:name:meta", "string", "meta"],
      [COL.amount, "number", "total"],
    ]);
    expect(projection.source).toBe(shopSales.source);
  });

  it("has no title where the chosen title field isn't one of its columns", () => {
    expect(partProjection(revenue, sales).titleField).toBeNull();
    expect(partProjection({ ...revenue, titleField: COL.client }, sales).titleField).toBe(COL.client);
    expect(partProjection({ ...revenue, titleField: COL.source }, sales).titleField).toBe("none");
  });

  it("has the same value on every row for Collection (the part's name), for the columns it has no field for and for Created and Updated (none)", () => {
    const constants = partConstants(revenue, sales);
    expect([...constants].map(([id, c]) => [id, c.value])).toEqual([["merged:name:note", null], [COL.source, "Shop sales"], ["$created", null], ["$updated", null]]);
  });
});
