import { describe, expect, it } from "vitest";
import { codeProblem, componentUses, itemsInput, localComponents, placeProblem, render, unknownNames } from "./components";
import { parseLayout } from "./fieldLayout";
import type { Collection, FieldDef, Item } from "./model";
import { filterPreset, PAGE_ITEM, pageItemField, resolvePageValues, type FilterRule } from "./query";
import { blockLimit, blockQuery, collapsedGroups, newBlock, NOTHING_COLLAPSED, pageFilterScope, pageFiltersFor, parseBlock, parseViewConfig, sameView, withBlockCollapsed, withGroupCollapsed, withQuery } from "./views";

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
  it("keeps a block's Limit (0: all); without one a chart shows all, other blocks 100 at a time", () => {
    const blocks = [{ ...newBlock("table", {}, "a"), limit: 25 }, { ...newBlock("table", {}, "b"), limit: 0 }, { ...newBlock("table", {}, "c"), limit: -1 }];
    const read = parseViewConfig(JSON.stringify({ filters: [], blocks })).blocks;
    expect(read.map((b) => b.limit)).toEqual([25, 0, undefined]);
    expect([blockLimit(read[0], false), blockLimit(read[1], false), blockLimit(read[2], false), blockLimit(read[2], true)]).toEqual([25, 0, 100, 0]);
  });

  it("reads blocks as stored, and compares equal to what was stored", () => {
    const state = { filters: [rule("pages", "lt", "50")], blocks: [newBlock("table", {}, "x"), { ...newBlock("cards", {}, "y"), filters: [] }], editable: false };
    const read = parseViewConfig(JSON.stringify(state));
    expect(sameView(read, state)).toBe(true);
  });
});

describe("blocks", () => {
  it("always build on the view's filter, their own rules after it", () => {
    const view = [rule("pages", "gt", "100")];
    const own = [rule("title", "contains", "a")];
    const block = { ...newBlock("table", null), filters: own };
    expect(blockQuery(view, block)).toMatchObject({ inherited: view, filters: own });
    expect(blockQuery(view, newBlock("table", null))).toMatchObject({ inherited: view, filters: [] });
    expect(blockQuery(null, block).inherited).toEqual([]);
    // No rules: the same array each time (what is memoized on it stays).
    expect(blockQuery(null, newBlock("table", null)).filters).toBe(blockQuery(null, newBlock("table", null)).filters);
  });

  it("take sort and grouping from a query, the default group order not stored", () => {
    const b = withQuery({ ...newBlock("table", null), groupOrder: "count" }, { filters: [], sort: [], groupBy: "author" });
    expect(b.groupBy).toBe("author");
    expect("groupOrder" in b).toBe(false);
  });

  it("keep a date grouping (not the default day) from query to block and back, and read it from storage", () => {
    const b = withQuery(newBlock("table", null), { filters: [], sort: [], groupBy: "when", groupDate: "week", groupOrder: "desc" });
    expect(b).toMatchObject({ groupDate: "week", groupOrder: "desc" });
    expect(Object.keys(b).slice(-2)).toEqual(["groupDate", "groupOrder"]);
    expect(blockQuery(null, b)).toMatchObject({ groupBy: "when", groupDate: "week", groupOrder: "desc" });
    expect(parseBlock(JSON.parse(JSON.stringify(b)))?.groupDate).toBe("week");
    expect(parseBlock({ ...b, groupDate: "day" })).not.toHaveProperty("groupDate");
    expect(parseBlock({ ...b, groupDate: "decade" })).not.toHaveProperty("groupDate");
    expect("groupDate" in withQuery(b, { filters: [], sort: [], groupBy: "when" })).toBe(false);
    expect(blockQuery(null, newBlock("table", null))).not.toHaveProperty("groupDate");
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

  it("work out a period counted from the page's item's date: its days up to it, else nothing matches", () => {
    const dated = { ...page, values: { ...page.values, read: "2026-03-10" } };
    const week = [rule("read", "between", "day-6..day+0@$item.read")];
    expect(resolvePageValues(week, dated).map((r) => r.value)).toEqual(["2026-03-04..2026-03-10"]);
    expect(resolvePageValues([rule("read", "between", "month+0@$item.read")], dated)[0].value).toBe("2026-03-01..2026-03-31");
    expect(resolvePageValues(week, page)[0].value).toMatch(/^⚠/);
    expect(resolvePageValues(week, null)[0].value).toMatch(/^⚠/);
    // Counted from today: as it is.
    expect(resolvePageValues([rule("read", "between", "day-6..day+0")], dated)[0].value).toBe("day-6..day+0");
  });

  it("count a period that ends now (last n, so far) up to the page's item's date or time, not to the end of its month", () => {
    const dated = { ...page, values: { ...page.values, read: "2026-03-10" } };
    expect(resolvePageValues([rule("read", "between", "month-1..month+0@$item.read")], dated)[0].value).toBe("2026-02-01..2026-03-10");
    expect(resolvePageValues([rule("read", "between", "year+0..day+0@$item.read")], dated)[0].value).toBe("2026-01-01..2026-03-10");
    // A date & time: the period in minutes, ending at its minute (the same day's later weigh-in is not in it).
    const moment = new Date(2026, 2, 10, 7, 45);
    const timed = { ...page, values: { ...page.values, read: moment.toISOString() } };
    expect(resolvePageValues([rule("read", "between", "month-1..month+0@$item.read")], timed)[0].value).toBe("2026-02-01T00:00..2026-03-10T07:45");
    expect(resolvePageValues([rule("read", "between", "day-6..day+0@$item.read")], timed)[0].value).toBe("2026-03-04T00:00..2026-03-10T07:45");
    expect(resolvePageValues([rule("read", "between", "hour-1..hour+0@$item.read")], timed)[0].value).toBe("2026-03-10T06:00..2026-03-10T07:45");
    // This period alone (not "last n") is the whole period around its date.
    expect(resolvePageValues([rule("read", "between", "month+0@$item.read")], timed)[0].value).toBe("2026-03-01..2026-03-31");
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
    const read = parseViewConfig(JSON.stringify({ filters: [], blocks: [newBlock("table", {}, "x")], collapsed: c }));
    expect(read.collapsed).toEqual({ blocks: ["x"], groups: { y: ["author/a1"] } });
    expect(parseViewConfig(JSON.stringify({ filters: [], blocks: [] })).collapsed).toEqual(NOTHING_COLLAPSED);
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

describe("page-wide filter", () => {
  const films: Collection = { ...books, id: "f", name: "Film", fields: [{ ...field("title", "Title", "string"), id: "ftitle", collectionId: "f" }, { ...field("year", "Year", "number"), collectionId: "f" }] };
  it("takes a collection's own rules and the pseudo fields, leaving others' alone", () => {
    const filters = [rule("pages", "gt", "100"), rule("year", "gt", "1990"), rule("$updated", "gt", "2020-01-01")];
    expect(pageFiltersFor(books, filters).map((r) => r.fieldId)).toEqual(["pages", "$updated"]);
    expect(pageFiltersFor(films, filters).map((r) => r.fieldId)).toEqual(["year", "$updated"]);
  });
  it("gives a remote collection its columns' rules (no Created / Updated: remote rows have none)", () => {
    const remote: Collection = { ...films, source: { name: "db" } as unknown as Collection["source"] };
    expect(pageFiltersFor(remote, [rule("year", "gt", "1990"), rule("$updated", "gt", "2020-01-01")]).map((r) => r.fieldId)).toEqual(["year"]);
  });
  it("edits against all the collections' fields, naming a clash by its collection", () => {
    const names = pageFilterScope([books, films]).fields.map((f) => f.name);
    expect(names).toContain("Pages");
    expect(names).toContain("Year");
  });
  it("is part of a stored item layout", () => {
    const layout = parseLayout(JSON.stringify({ fields: null, blocks: [], filters: [rule("pages", "gt", "1")] }));
    expect(layout?.filters).toEqual([rule("pages", "gt", "1")]);
    expect(parseLayout(JSON.stringify({ fields: null }))?.filters).toEqual([]);
  });
});
