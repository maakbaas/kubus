import { describe, expect, it } from "vitest";
import { codeProblem, componentUses, itemsInput, localComponents, placeProblem, render, unknownNames } from "./components";
import { parseLayout } from "./fieldLayout";
import type { Collection, FieldDef, Item } from "./model";
import { defaultQuery, filterPreset, PAGE_ITEM, pageItemField, resolvePageValues, type FilterRule } from "./query";
import { blockQuery, collapsedGroups, newBlock, NOTHING_COLLAPSED, parseViewConfig, sameView, withBlockCollapsed, withGroupCollapsed, withQuery } from "./views";

const code = (text: string) => ({ code: text, ai: false });
const field = (id: string, name: string, kind: FieldDef["kind"], targetCollectionId: string | null = null): FieldDef => ({
  id, collectionId: "b", name, kind, targetCollectionId, componentId: null, code: null, output: null, frameRatio: null, choiceFilter: [], toggleIcon: null, strikeThrough: false, position: 0,
});

const books: Collection = {
  id: "b", name: "Book", pluralName: "Books", icon: null, description: "", itemViews: [], spaceIds: null,
  fields: [field("title", "Title", "string"), field("pages", "Pages", "number"), field("author", "Author", "item", "a"), field("tags", "Tags", "item_list", "t")],
  createdAt: "", updatedAt: "",
};
const book = (id: string, title: string, pages: number, author: string | null): Item => ({
  id, collectionId: "b", spaceId: "default", values: { title, pages, author }, createdAt: "", updatedAt: "",
});
const rule = (fieldId: string, operator: FilterRule["operator"], value: string): FilterRule => ({ id: fieldId, fieldId, operator, value });

describe("parseViewConfig", () => {
  it("reads a view stored before blocks as one block", () => {
    const table = parseViewConfig(
      JSON.stringify({ query: { filters: [rule("pages", "gt", "100")], sort: [{ fieldId: "pages", direction: "desc" }], groupBy: "author" }, options: { columns: ["title"], titleLink: false } }),
      "table",
    );
    expect(table.filters).toEqual([rule("pages", "gt", "100")]);
    expect(table.blocks).toHaveLength(1);
    const [b] = table.blocks;
    expect(b).toMatchObject({ kind: "table", filters: null, sort: [{ fieldId: "pages", direction: "desc" }], groupBy: "author" });
    expect(b.layout.fields).toEqual(["title"]);
    expect((b.options as { titleLink: boolean }).titleLink).toBe(false);
  });

  it("takes the cards' fields, labels and empty-field choice into the block's layout", () => {
    const cards = parseViewConfig(JSON.stringify({ query: defaultQuery(), options: { fields: ["pages"], hiddenLabels: ["pages"], hideEmpty: true } }), "cards");
    expect(cards.blocks[0].layout).toEqual({ fields: ["pages"], editable: true, hiddenLabels: ["pages"], hideEmpty: true });
  });

  it("reads blocks as stored, and compares equal to what was stored", () => {
    const state = { filters: [rule("pages", "lt", "50")], blocks: [newBlock("table", {}, "x"), { ...newBlock("cards", {}, "y"), filters: [] }], editable: false };
    const read = parseViewConfig(JSON.stringify(state), "table");
    expect(sameView(read, state)).toBe(true);
  });
});

describe("blocks", () => {
  it("use the view's filter unless they have their own, which replaces it", () => {
    const view = [rule("pages", "gt", "100")];
    const inherit = newBlock("table", null);
    expect(blockQuery(view, inherit).filters).toBe(view);
    expect(blockQuery(view, { ...inherit, filters: [] }).filters).toEqual([]);
    expect(blockQuery(null, inherit).filters).toEqual([]);
  });

  it("take sort and grouping from a query, the default group order not stored", () => {
    const b = withQuery({ ...newBlock("table", null), groupOrder: "count" }, { filters: [], sort: [], groupBy: "author" });
    expect(b.groupBy).toBe("author");
    expect("groupOrder" in b).toBe(false);
  });

  it("on item pages: layouts keep their blocks", () => {
    const layout = parseLayout(JSON.stringify({ fields: ["title", "x"], blocks: [newBlock("table", null, "x"), { nonsense: true }] }));
    expect(layout?.blocks.map((b) => b.id)).toEqual(["x"]);
    expect(parseLayout(JSON.stringify({ fields: null }))?.blocks).toEqual([]);
  });
});

describe("page item filter values", () => {
  const page = book("p", "Page", 1, "a1");
  it("fill in the page's item, or what one of its reference fields points to", () => {
    const filters = [rule("author", "is", PAGE_ITEM), rule("tags", "is", pageItemField("author")), rule("title", "is", "x")];
    expect(resolvePageValues(filters, page).map((r) => r.value)).toEqual(["p", "a1", "x"]);
    expect(resolvePageValues(filters, null).map((r) => r.value)).toEqual(["", "", "x"]);
  });

  it("presets new items to pass reference rules", () => {
    const preset = filterPreset(books, [rule("author", "is", "a1"), rule("tags", "is", "t1"), rule("tags", "is", "t2"), rule("pages", "is", "3"), rule("author", "is", PAGE_ITEM)]);
    expect(preset).toEqual({ author: "a1", tags: ["t1", "t2"] });
  });
});

describe("components in blocks", () => {
  it("are classed by the built-ins they use", () => {
    expect(componentUses("{{ $item.Title }}").kind).toBe("field");
    expect(componentUses("{{ $items.length }} of {{ $all.length }}")).toEqual({ kind: "block", mixed: false, items: true, groups: false, fields: false });
    expect(componentUses("{{ $groups.length }}")).toEqual({ kind: "block", mixed: false, items: true, groups: true, fields: false });
    expect(componentUses("{{ $fields.map(f => f.name) }}")).toEqual({ kind: "block", mixed: false, items: false, groups: false, fields: true });
    expect(componentUses("Hello {{ $now.getFullYear() }}, '$items' in text").kind).toBe("static");
    expect(componentUses("Read **$items** carefully").kind).toBe("static");
    expect(componentUses("{{ $all.length }}").kind).toBe("block");
  });

  it("never mix $item with a block's names", () => {
    expect(componentUses("{{ $item.Name }}: {{ $items.length }}")).toMatchObject({ kind: "field", mixed: true });
    expect(placeProblem(code("{{ $item.Name }}: {{ $all.length }}"), "field")).toMatch(/both/);
    expect(placeProblem(code("{{ $item.Name }}: {{ $items.length }}"), "block")).toMatch(/both/);
  });

  it("fit their place: field components as fields, block components as blocks, static ones as blocks", () => {
    expect(placeProblem(code("Read me {{ $now.getDay() }}"), "field")).toMatch(/same for every item/);
    expect(placeProblem(code("{{ $item.Pages }}"), "field")).toBeNull();
    expect(placeProblem(code("{{ $item.Pages }}"), "block")).toMatch(/use it as a field/);
    expect(placeProblem(code("{{ $items.length }}"), "block")).toBeNull();
    expect(placeProblem(code("{{ $items.length }}"), "field")).toMatch(/use it as a block/);
    expect(placeProblem(code("Read me"), "block")).toBeNull();
    expect(placeProblem(code("{{ $now.getFullYear() }}"), "static")).toBeNull();
    expect(placeProblem(code("{{ $item.Pages }}"), "static")).toMatch(/same everywhere/);
    expect(placeProblem(code("{{ $items.length }}"), "static")).toMatch(/same everywhere/);
  });

  it("know no variables: any other $ name is a problem", () => {
    expect(unknownNames("{{ $items.length * $factor + $all.length + $groups.length + $fields.length }}")).toEqual(["factor"]);
    expect(codeProblem("{{ $pages / 40 }}")).toMatch(/\$pages isn't known/);
    expect(placeProblem(code("{{ $pages / 40 }}"), "field")).toMatch(/\$pages/);
    expect(render({ code: "{{ $pages / 40 }}" })).toMatch(/^⚠ \$pages/);
  });

  it("asking AI fill a field, without $now", () => {
    expect(placeProblem({ code: "{{ $item.Pages }}", ai: true }, "field")).toBeNull();
    expect(placeProblem({ code: "{{ $item.Pages }}", ai: true }, "block")).toMatch(/fills a field/);
    expect(placeProblem({ code: "{{ $now }}", ai: true }, "field")).toMatch(/\$now/);
  });

  it("see the block's items by field name", () => {
    const input = itemsInput(books, () => "");
    const items = [book("1", "A", 10, null), book("2", "B", 32, null)];
    const out = render({ code: "{{ $items.map(b => b.Title + ':' + b.pages).join(', ') }} / {{ $all.length }}" }, undefined, undefined, {
      items: items.map(input),
      groups: [],
      fields: [],
      all: items.map(input),
    });
    expect(out).toBe("A:10, B:32 / 2");
  });

  it("outside a block see empty lists", () => {
    expect(render({ code: "{{ $items.length }}" })).toBe(0);
  });
});

describe("local components", () => {
  it("are listed by where they are written: fields, component blocks and Markdown blocks with code", () => {
    const withLocal = {
      ...books,
      fields: [...books.fields, { ...field("r", "Reading", "component"), code: "{{ $item.Pages / 40 }}", output: "number" as const }],
    };
    const view = {
      id: "v",
      collectionId: books.id,
      name: "All",
      blocks: [
        { id: "b1", title: "", kind: "component", options: { componentId: null, local: { code: "{{ $items.length }}", output: "markdown" } } },
        { id: "b2", title: "Notes", kind: "markdown", options: { text: "Today: {{ $now.getDay() }}" } },
        { id: "b3", title: "", kind: "markdown", options: { text: "Plain text" } },
        { id: "b4", title: "", kind: "component", options: { componentId: "shared", local: null } },
      ],
    };
    const found = localComponents([withLocal], [view]);
    expect(found.map((l) => l.where)).toEqual(["Books › Reading", "Books › All › Component", "Books › All › Notes"]);
    expect(found[0].component).toMatchObject({ output: "number", ai: false });
    expect(found[2].owner).toMatchObject({ type: "view", markdown: true });
  });
});

describe("collapsed blocks and groups", () => {
  it("are stored with the view and read back", () => {
    let c = withBlockCollapsed(NOTHING_COLLAPSED, "x", true);
    c = withGroupCollapsed(c, "y", "author", "a1", true);
    const read = parseViewConfig(JSON.stringify({ filters: [], blocks: [newBlock("table", {}, "x")], collapsed: c }), "table");
    expect(read.collapsed).toEqual({ blocks: ["x"], groups: { y: ["author/a1"] } });
    expect(parseViewConfig(JSON.stringify({ filters: [], blocks: [] }), "table").collapsed).toEqual(NOTHING_COLLAPSED);
  });

  it("keep groups per grouped-by field, and drop what is expanded again", () => {
    let c = withGroupCollapsed(NOTHING_COLLAPSED, "y", "author", "a1", true);
    expect(collapsedGroups(c, "y", "author")).toEqual(["a1"]);
    expect(collapsedGroups(c, "y", "genre")).toEqual([]);
    c = withGroupCollapsed(c, "y", "author", "a1", false);
    expect(c.groups).toEqual({});
    expect(withBlockCollapsed(withBlockCollapsed(NOTHING_COLLAPSED, "x", true), "x", false).blocks).toEqual([]);
  });
});
