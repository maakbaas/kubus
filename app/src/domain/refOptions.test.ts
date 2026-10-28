import { describe, expect, it, vi } from "vitest";
import type { Component } from "./components";
import { blankField, type Collection, type Item, type ItemLabel } from "./model";
import { buildTargetOptions, isFullTarget, labelOf, refLabelForSpace, refLabelOf, referenceTargets, type RefOption } from "./refOptions";

const collection = (id: string, name: string, fields: Collection["fields"]): Collection => ({
  id, name, pluralName: `${name}s`, icon: null, description: "", itemViews: [], spaceIds: null, createdAt: "", updatedAt: "", fields,
});
const item = (id: string, collectionId: string, values: Item["values"], spaceId = "s1"): Item => ({ id, collectionId, spaceId, values, createdAt: "", updatedAt: "" });
const label = (id: string, text: string | null, spaceId = "s1"): ItemLabel => ({ id, label: text, spaceId });

const authors = collection("author", "Author", [blankField("aname", "Name", "string"), blankField("country", "Country", "string", { position: 1 })]);
const rule = (fieldId: string, operator: string, value: string) => ({ id: `${fieldId}-${operator}`, fieldId, operator, value }) as never;
const books = collection("book", "Book", [
  blankField("btitle", "Title", "string"),
  blankField("bauthor", "Author", "item", { targetCollectionId: "author", choiceFilter: [rule("country", "is", "NL")] }),
  blankField("bco", "Co-author", "item_list", { targetCollectionId: "author" }),
  blankField("bseries", "Series", "item", { targetCollectionId: "series" }),
]);

describe("references", () => {
  it("referenceTargets lists each target once, with the fields whose choice filter limits it", () => {
    const targets = referenceTargets(books);
    expect(targets.map((t) => t.id)).toEqual(["author", "series"]);
    expect(targets[0].limited.map((f) => f.id)).toEqual(["bauthor"]);
    expect(targets[1].limited).toEqual([]);
    expect(isFullTarget(targets[0])).toBe(true);
    expect(isFullTarget(targets[1])).toBe(false);
    expect(referenceTargets(authors)).toEqual([]);
  });

  it("labelOf finds a label, and is undefined for a deleted item or options not loaded", () => {
    const options: RefOption[] = [{ id: "a", label: "Ann" }];
    expect(labelOf(options, "a")).toBe("Ann");
    expect(labelOf(options, "x")).toBeUndefined();
    expect(labelOf(undefined, "a")).toBeUndefined();
  });

  it("refLabelOf reads the target of the field, and says what a missing one is", () => {
    const refs = { author: [{ id: "a", label: "Ann" }] };
    const field = books.fields[1];
    expect(refLabelOf(refs)(field, "a")).toBe("Ann");
    expect(refLabelOf(refs)(field, "gone")).toBe("");
    expect(refLabelOf(refs, "(deleted)")(field, "gone")).toBe("(deleted)");
    expect(refLabelOf(refs, "?")(books.fields[3], "a")).toBe("?"); // its target isn't loaded
    expect(refLabelOf(refs, "?")(books.fields[0], "a")).toBe("?"); // not a reference
  });
});

describe("buildTargetOptions", () => {
  const args = { target: authors, limited: [], spaceId: "s1", collections: [authors, books], components: [] as Component[], labelsOf: () => [] as ItemLabel[] };

  it("plain: the labels as stored, an unlabelled item named by its collection, other spaces marked", () => {
    const options = buildTargetOptions({ ...args, full: false, items: [label("a", "Ann"), label("b", null), label("c", "Cy", "s2")] });
    expect(options).toEqual([
      { id: "a", label: "Ann" },
      { id: "b", label: expect.stringContaining("Author") },
      { id: "c", label: "Cy", elsewhere: true },
    ]);
    expect(options[1].label).not.toBe("");
  });

  it("full: marks the items the field's choice filter leaves out", () => {
    const limited = [books.fields[1]];
    const items = [item("a", "author", { aname: "Ann", country: "NL" }), item("b", "author", { aname: "Bob", country: "BE" }), item("c", "author", { aname: "Cy" })];
    const options = buildTargetOptions({ ...args, limited, full: true, items });
    expect(options).toEqual([
      { id: "a", label: "Ann" },
      { id: "b", label: "Bob", excludedBy: ["bauthor"] },
      { id: "c", label: "Cy", excludedBy: ["bauthor"] },
    ]);
  });

  it("full: a filter on a reference of the target reads the labels of what it points to", () => {
    const publishers = collection("pub", "Publisher", [blankField("pname", "Name", "string")]);
    const imprint = collection("imprint", "Imprint", [
      blankField("iname", "Name", "string"),
      blankField("ipub", "Publisher", "item", { targetCollectionId: "pub" }),
    ]);
    const limited = [blankField("limited", "Imprint", "item", { targetCollectionId: "imprint", choiceFilter: [rule("ipub", "contains", "Acm")] })];
    const labelsOf = vi.fn((id: string) => (id === "pub" ? [label("p1", "Acme"), label("p2", "Zeta")] : []));
    const items = [item("i1", "imprint", { iname: "One", ipub: "p1" }), item("i2", "imprint", { iname: "Two", ipub: "p2" })];
    const options = buildTargetOptions({ ...args, target: imprint, limited, full: true, items, collections: [imprint, publishers], labelsOf });
    expect(options.map((o) => [o.id, o.excludedBy])).toEqual([["i1", undefined], ["i2", ["limited"]]]);
    expect(labelsOf).toHaveBeenCalledWith("pub");
  });
});

describe("refLabelForSpace", () => {
  const authorLabels = [label("a", "Ann"), label("b", "Bob")];
  const source = () => ({
    listLabels: vi.fn(async (c: Collection) => (c.id === "author" ? authorLabels : [])),
    listItems: vi.fn(async (c: Collection, space: string) => (c.id === "author" ? [item("a", "author", { aname: "Ann", country: "NL" }, space)] : [])),
  });
  const world = (collections: Collection[]) => ({ collections, components: [] as Component[] });

  it("reads referenced items by their stored labels", async () => {
    const src = source();
    const plain = collection("book", "Book", [blankField("bauthor", "Author", "item", { targetCollectionId: "author" })]);
    const labelFor = await refLabelForSpace(src, plain, "s1", world([authors, plain]));
    expect(labelFor(plain.fields[0], "a")).toBe("Ann");
    expect(labelFor(plain.fields[0], "zz")).toBe("");
    expect(src.listItems).not.toHaveBeenCalled(); // labels alone are enough
  });

  it("reads the items themselves where a choice filter needs them, in the given space", async () => {
    const src = source();
    const labelFor = await refLabelForSpace(src, books, "s9", world([authors, books]));
    expect(src.listItems).toHaveBeenCalledWith(authors, "s9");
    expect(labelFor(books.fields[1], "a")).toBe("Ann");
  });

  it("skips targets that don't exist, and shares the labels it has read between calls", async () => {
    const src = source();
    const shared = new Map<string, ItemLabel[]>();
    await refLabelForSpace(src, books, "s1", world([authors, books]), shared); // 'series' is not a collection here
    expect(src.listLabels).toHaveBeenCalledTimes(1);
    expect([...shared.keys()]).toEqual(["author"]);
    await refLabelForSpace(src, books, "s1", world([authors, books]), shared);
    expect(src.listLabels).toHaveBeenCalledTimes(1);
  });
});
