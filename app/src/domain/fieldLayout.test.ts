import { describe, expect, it } from "vitest";
import {
  FULL_LAYOUT,
  isRestricted,
  itemPageFields,
  itemViewOf,
  newItemViewId,
  parseFieldLayout,
  parseItemViews,
  parseLayout,
  sameLayout,
  withDefaultItemView,
  type ItemView,
} from "./fieldLayout";
import { blankField, type Collection, type Item } from "./model";
import { newBlock, NOTHING_COLLAPSED } from "./views";

const fields = [blankField("title", "Title", "string"), blankField("pages", "Pages", "number"), blankField("note", "Note", "string")];
const collection = (itemViews: ItemView[] = [], extra: Partial<Collection> = {}): Collection => ({
  id: "c", name: "Book", pluralName: "Books", icon: null, description: "", itemViews, spaceIds: null, createdAt: "", updatedAt: "", fields, ...extra,
});
const item = (extra: Partial<Item> = {}): Item => ({ id: "i", collectionId: "c", spaceId: "s", values: { title: "Dune" }, createdAt: "", updatedAt: "", ...extra });
const view = (id: string, extra: Partial<ItemView> = {}): ItemView => ({ id, name: id, layout: FULL_LAYOUT, isDefault: false, collapsed: NOTHING_COLLAPSED, ...extra });

describe("item views", () => {
  it("there is always one: without stored ones it is the standard page, named Default", () => {
    const [only] = withDefaultItemView([]);
    expect(only).toMatchObject({ id: "default", name: "Default", isDefault: true, layout: FULL_LAYOUT });
    const stored = [view("a")];
    expect(withDefaultItemView(stored)).toBe(stored);
  });

  it("an item opens with its pinned view, else the starred one, else the first, else none", () => {
    const views = [view("a"), view("b", { isDefault: true }), view("c")];
    expect(itemViewOf(collection(views), item({ itemViewId: "c" }))?.id).toBe("c");
    expect(itemViewOf(collection(views), item({ itemViewId: "gone" }))?.id).toBe("b");
    expect(itemViewOf(collection(views), item())?.id).toBe("b");
    expect(itemViewOf(collection([view("a"), view("b")]), item())?.id).toBe("a");
    expect(itemViewOf(collection([]), item())).toBeNull();
  });

  it("makes ids of its own", () => {
    expect(newItemViewId()).not.toBe(newItemViewId());
  });
});

describe("parseFieldLayout", () => {
  it("reads a stored layout, ignoring ids that aren't strings", () => {
    expect(parseFieldLayout({ fields: ["a", 2, "b"], editable: false, hiddenLabels: ["a", null], hideEmpty: true })).toEqual({ fields: ["a", "b"], editable: false, hiddenLabels: ["a"], hideEmpty: true });
  });

  it("anything missing is the plain layout; editable unless said otherwise", () => {
    expect(parseFieldLayout({})).toEqual({ fields: null, editable: true, hiddenLabels: [], hideEmpty: false });
    expect(parseFieldLayout({ fields: "x", editable: "no", hideEmpty: "yes" })).toEqual({ fields: null, editable: true, hiddenLabels: [], hideEmpty: false });
  });

  it("is null for nothing or a non-object", () => {
    for (const raw of [null, undefined, "x", 3, false]) expect(parseFieldLayout(raw)).toBeNull();
  });
});

describe("parseLayout", () => {
  it("reads blocks and filters, dropping blocks that are unreadable", () => {
    const good = newBlock("table", null, "b1");
    const json = JSON.stringify({ fields: ["title"], blocks: [good, { id: 1 }, null], filters: [{ id: "r", fieldId: "title", operator: "is", value: "x" }] });
    const layout = parseLayout(json)!;
    expect(layout.fields).toEqual(["title"]);
    expect(layout.blocks.map((b) => b.id)).toEqual(["b1"]);
    expect(layout.filters).toHaveLength(1);
  });

  it("blocks and filters default to none", () => {
    expect(parseLayout("{}")).toEqual({ ...FULL_LAYOUT });
    expect(parseLayout(JSON.stringify({ blocks: "x", filters: {} }))).toMatchObject({ blocks: [], filters: [] });
  });

  it("is null when absent or unreadable", () => {
    for (const json of [null, "", "{not json", "null", "3"]) expect(parseLayout(json)).toBeNull();
  });
});

describe("parseItemViews", () => {
  it("reads stored views, validating each", () => {
    const json = JSON.stringify([
      { id: "a", name: "Compact", layout: { fields: ["title"] }, isDefault: true, collapsed: { blocks: ["b"] } },
      { id: "b", layout: {} },
      { name: "no id", layout: {} },
      { id: "c" },
      { id: "d", name: "bad layout", layout: "x" },
    ]);
    const views = parseItemViews(json);
    expect(views.map((v) => v.id)).toEqual(["a", "b"]); // not those without an id or a readable layout
    expect(views[0]).toMatchObject({ name: "Compact", isDefault: true, collapsed: { blocks: ["b"], groups: {} } });
    expect(views[0].layout.fields).toEqual(["title"]);
    expect(views[1]).toMatchObject({ name: "", isDefault: false });
  });

  it("is empty when absent or unreadable", () => {
    expect(parseItemViews(null)).toEqual([]);
    expect(parseItemViews("")).toEqual([]);
    expect(parseItemViews("{not json")).toEqual([]);
    expect(parseItemViews('"x"')).toEqual([]);
  });
});

describe("sameLayout", () => {
  it("compares everything a layout shows", () => {
    expect(sameLayout(FULL_LAYOUT, { ...FULL_LAYOUT })).toBe(true);
    for (const change of [{ editable: false }, { hideEmpty: true }, { fields: ["title"] }, { hiddenLabels: ["title"] }, { blocks: [newBlock("table", null, "b")] }, { filters: [{ id: "r", fieldId: "t", operator: "is", value: "" }] }]) {
      expect(sameLayout(FULL_LAYOUT, { ...FULL_LAYOUT, ...change } as never)).toBe(false);
    }
  });
});

describe("itemPageFields", () => {
  it("by default every field but the page's title and created / updated", () => {
    const all = [...fields, blankField("$created", "Created", "datetime")];
    expect(itemPageFields(all, FULL_LAYOUT, "title").map((f) => f.id)).toEqual(["pages", "note"]);
    expect(itemPageFields(all, FULL_LAYOUT, undefined).map((f) => f.id)).toEqual(["title", "pages", "note"]);
  });

  it("a chosen layout shows what it names, the title too, and the created date when chosen", () => {
    const all = [...fields, blankField("$created", "Created", "datetime")];
    expect(itemPageFields(all, { ...FULL_LAYOUT, fields: ["note", "title", "$created", "gone"] }, "title").map((f) => f.id)).toEqual(["note", "title", "$created"]);
  });
});

describe("isRestricted", () => {
  it("the standard page holds nothing back", () => {
    expect(isRestricted(collection(), item(), FULL_LAYOUT)).toBe(false);
  });

  it("read-only or hiding empty fields is a restriction", () => {
    expect(isRestricted(collection(), item(), { ...FULL_LAYOUT, editable: false })).toBe(true);
    expect(isRestricted(collection(), item(), { ...FULL_LAYOUT, hideEmpty: true })).toBe(true);
  });

  it("leaving a field out is, but not the one shown as the page's title", () => {
    expect(isRestricted(collection(), item(), { ...FULL_LAYOUT, fields: ["pages", "note"] })).toBe(false); // the title is the heading
    expect(isRestricted(collection(), item(), { ...FULL_LAYOUT, fields: ["pages"] })).toBe(true);
    expect(isRestricted(collection(), item({ values: {} }), { ...FULL_LAYOUT, fields: ["pages", "note"] })).toBe(true); // no title value: the title field is an ordinary one
  });
});
