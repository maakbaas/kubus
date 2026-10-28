import { describe, expect, it } from "vitest";
import {
  blankField,
  canBeTitle,
  countLabel,
  editableField,
  editedTitleField,
  fieldValue,
  isMetaField,
  isStruckThrough,
  itemLabel,
  labelField,
  META_FIELDS,
  newId,
  newName,
  NO_TITLE,
  now,
  observeStamp,
  pickableFields,
  selfField,
  SELF_FIELD,
  suggestPlural,
  titleFields,
  titleText,
  untitledLabel,
  type Collection,
  type Item,
} from "./model";

const collection = (fields: Collection["fields"], extra: Partial<Collection> = {}): Collection => ({
  id: "c", name: "Book", pluralName: "Books", icon: null, description: "", itemViews: [], spaceIds: null, createdAt: "", updatedAt: "", fields, ...extra,
});
const item = (values: Item["values"], extra: Partial<Item> = {}): Item => ({ id: "i1", collectionId: "c", spaceId: "s", values, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-02-02T00:00:00.000Z", ...extra });

const title = blankField("title", "Title", "string");
const subtitle = blankField("sub", "Subtitle", "string");
const year = blankField("year", "Year", "number");
const published = blankField("pub", "Published", "date");
const seen = blankField("seen", "Seen", "datetime");

describe("titles", () => {
  it("come from the string fields in order unless a field is chosen", () => {
    expect(titleFields(collection([title, year, subtitle])).map((f) => f.id)).toEqual(["title", "sub"]);
    expect(titleFields(collection([title, year], { titleField: "year" })).map((f) => f.id)).toEqual(["year"]);
  });

  it("a chosen field that can't be a title or is gone falls back to the text fields", () => {
    const tags = blankField("tags", "Tags", "string_list");
    expect(titleFields(collection([title, tags], { titleField: "tags" })).map((f) => f.id)).toEqual(["title"]);
    expect(titleFields(collection([title], { titleField: "gone" })).map((f) => f.id)).toEqual(["title"]);
  });

  it("a collection can have items without a title", () => {
    expect(titleFields(collection([title], { titleField: NO_TITLE }))).toEqual([]);
    expect(itemLabel(collection([title], { titleField: NO_TITLE }), item({ title: "Dune" }))).toBe("Book");
  });

  it("only one-line kinds can be a title", () => {
    expect(["string", "number", "date", "datetime"].map((kind) => canBeTitle({ kind } as never))).toEqual([true, true, true, true]);
    expect(["markdown", "checkbox", "item", "image"].map((kind) => canBeTitle({ kind } as never))).toEqual([false, false, false, false]);
  });

  it("titleText is the text, a number, or a date as shown; blank is nothing", () => {
    expect(titleText(title, "Dune")).toBe("Dune");
    expect(titleText(title, "   ")).toBe("");
    expect(titleText(title, undefined)).toBe("");
    expect(titleText(title, 3 as never)).toBe("");
    expect(titleText(year, 1965)).toBe("1965");
    expect(titleText(year, Infinity)).toBe("");
    expect(titleText(year, "x")).toBe("");
    expect(titleText(published, "2026-01-02")).toBe("2026-01-02");
    expect(titleText(seen, new Date(2026, 0, 2, 3, 4).toISOString())).toBe("2026-01-02 03:04");
  });
});

describe("labels", () => {
  const c = collection([title, subtitle, year]);

  it("an item is called by its first filled title field", () => {
    expect(itemLabel(c, item({ title: "Dune", sub: "Part one" }))).toBe("Dune");
    expect(itemLabel(c, item({ title: " ", sub: "Part one" }))).toBe("Part one");
    expect(labelField(c, item({ sub: "x" }))?.id).toBe("sub");
  });

  it("with no title it is called by its collection", () => {
    expect(itemLabel(c, item({}))).toBe("Book");
    expect(untitledLabel(c)).toBe("Book");
    expect(labelField(c, item({}))).toBeUndefined();
  });

  it("only a text title is edited as the page's title; a number or date title is edited among the fields", () => {
    expect(editedTitleField(c, item({ title: "Dune" }))?.id).toBe("title");
    expect(editedTitleField(collection([title, year], { titleField: "year" }), item({ year: 1965 }))).toBeUndefined();
    expect(editedTitleField(c, item({}))).toBeUndefined();
  });

  it("a checked box with 'strike through' strikes the item", () => {
    const done = blankField("done", "Done", "checkbox", { strikeThrough: true });
    const plain = blankField("plain", "Plain", "checkbox");
    const withBoxes = collection([title, done, plain]);
    expect(isStruckThrough(withBoxes, item({ done: true }))).toBe(true);
    expect(isStruckThrough(withBoxes, item({ done: false }))).toBe(false);
    expect(isStruckThrough(withBoxes, item({ plain: true }))).toBe(false);
    expect(isStruckThrough(c, item({ title: "x" }))).toBe(false);
  });

  it("counts with the singular or the plural name", () => {
    expect(countLabel(c, 1)).toBe("1 Book");
    expect(countLabel(c, 0)).toBe("0 Books");
    expect(countLabel(c, 3)).toBe("3 Books");
  });
});

describe("pseudo fields", () => {
  it("created and updated can be picked and read, but are not fields of the collection", () => {
    const c = collection([title]);
    expect(pickableFields(c).map((f) => f.id)).toEqual(["title", "$created", "$updated"]);
    expect(META_FIELDS.every(isMetaField)).toBe(true);
    expect(isMetaField(title)).toBe(false);
    const i = item({ title: "Dune" });
    expect(fieldValue(i, META_FIELDS[0])).toBe(i.createdAt);
    expect(fieldValue(i, META_FIELDS[1])).toBe(i.updatedAt);
    expect(fieldValue(i, title)).toBe("Dune");
    expect(fieldValue(i, year)).toBeNull();
  });

  it("a remote collection's rows have neither", () => {
    const remote = collection([title], { source: { name: "CRM", target: { table: { schema: "p", name: "t" } }, key: "id", columns: [] } });
    expect(pickableFields(remote).map((f) => f.id)).toEqual(["title"]);
  });

  it("the item itself is a reference to its own collection, valued with its id", () => {
    const f = selfField(collection([title]));
    expect(f).toMatchObject({ id: SELF_FIELD, kind: "item", targetCollectionId: "c", collectionId: "c" });
    expect(fieldValue(item({}), f)).toBe("i1");
  });
});

describe("editableField", () => {
  it("an AI field is edited as the kind of its output", () => {
    const ai = (output: string | null) => blankField("ai", "AI", "ai", { output: output as never });
    expect(editableField(ai("number"))).toMatchObject({ kind: "number", editedAi: true });
    expect(editableField(ai("markdown"))).toMatchObject({ kind: "markdown", editedAi: true });
    expect(editableField(ai("string"))).toMatchObject({ kind: "string", editedAi: true });
    expect(editableField(ai(null))).toMatchObject({ kind: "string", editedAi: true });
  });

  it("other fields are as they are", () => {
    expect(editableField(title)).toBe(title);
  });
});

describe("names", () => {
  it("suggests a plural, and not twice", () => {
    expect(["Book", "Category", "Box", "Bus", "Match", "Dish", "Day", " Pet ", ""].map(suggestPlural)).toEqual(["Books", "Categories", "Boxes", "Buses", "Matches", "Dishes", "Days", "Pets", ""]);
  });

  it("a new view is called New, then New 2, 3 … the first free", () => {
    expect(newName([])).toBe("New");
    expect(newName(["New"])).toBe("New 2");
    expect(newName(["New", "New 2", "New 4"])).toBe("New 3");
    expect(newName(["Other"])).toBe("New");
  });
});

describe("ids and stamps", () => {
  it("ids are unique", () => {
    expect(new Set(Array.from({ length: 50 }, newId)).size).toBe(50);
  });

  it("stamps always increase, also within a millisecond", () => {
    const stamps = Array.from({ length: 20 }, now);
    for (let i = 1; i < stamps.length; i++) expect(stamps[i] > stamps[i - 1]).toBe(true);
  });

  it("a stamp seen from a device whose clock runs ahead keeps later local ones after it", () => {
    const ahead = new Date(Date.now() + 3_600_000).toISOString();
    observeStamp(ahead);
    expect(now() > ahead).toBe(true);
  });

  it("an older stamp changes nothing", () => {
    const before = now();
    observeStamp("2000-01-01T00:00:00.000Z");
    observeStamp("garbage");
    expect(now() > before).toBe(true);
  });
});
