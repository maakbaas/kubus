import { describe, expect, it } from "vitest";
import { blankField, type Collection } from "./model";
import {
  ASPECT_RATIOS,
  BLOCK_HEIGHT,
  BLOCK_LAYOUT,
  blockHeightCss,
  blockLimit,
  blockQuery,
  collapsedGroups,
  DEFAULT_ASPECT,
  DEFAULT_LIMIT,
  defaultViewState,
  newBlock,
  NO_FILTERS,
  normalizeAspect,
  normalizeBlockHeight,
  NOTHING_COLLAPSED,
  pageFilterScope,
  parseBlock,
  parseCollapsed,
  parseViewConfig,
  FULL_WIDTH_DEFAULT,
  isFullWidth,
  withBlockCollapsed,
  withGroupCollapsed,
  withQuery,
} from "./views";

describe("parseBlock", () => {
  it("needs an id and a kind", () => {
    for (const raw of [null, undefined, "x", 3, {}, { id: "a" }, { kind: "table" }, { id: 1, kind: "table" }, { id: "a", kind: 2 }]) expect(parseBlock(raw)).toBeNull();
  });

  it("fills in what is missing with the plain block", () => {
    expect(parseBlock({ id: "a", kind: "table" })).toEqual({ id: "a", title: "", kind: "table", filters: null, sort: [], groupBy: null, layout: BLOCK_LAYOUT, collectionId: null, options: null });
  });

  it("keeps what is stored when it is well formed, and drops what is not", () => {
    const stored = {
      id: "a", kind: "cards", title: "Reading", filters: [{ id: "r", fieldId: "f", operator: "is", value: "x" }], sort: [{ fieldId: "f", direction: "desc" }], groupBy: "g",
      layout: { fields: ["f"], editable: false, hiddenLabels: [], hideEmpty: true }, collectionId: "other", options: { x: 1 }, hideHeader: true, limit: 12, groupOrder: "count",
    };
    expect(parseBlock(stored)).toEqual(stored);
    expect(parseBlock({ id: "a", kind: "t", title: 3, filters: "x", sort: "x", groupBy: 4, collectionId: 5, hideHeader: "yes", limit: 1.5, groupOrder: "sideways" })).toEqual({
      id: "a", title: "", kind: "t", filters: null, sort: [], groupBy: null, layout: BLOCK_LAYOUT, collectionId: null, options: null,
    });
  });

  it("groupOrder 'asc' is the default, so it isn't kept", () => {
    expect(parseBlock({ id: "a", kind: "t", groupOrder: "asc" })).not.toHaveProperty("groupOrder");
    expect(parseBlock({ id: "a", kind: "t", groupOrder: "desc" })).toHaveProperty("groupOrder", "desc");
  });

  it("a new block shows all items by title, with the plain layout", () => {
    const b = newBlock("map", { z: 1 });
    expect(b).toMatchObject({ kind: "map", title: "", filters: null, groupBy: null, layout: BLOCK_LAYOUT, collectionId: null, options: { z: 1 } });
    expect(b.sort).toEqual([{ fieldId: "$title", direction: "asc" }]);
    expect(newBlock("map", null).id).not.toBe(newBlock("map", null).id);
  });
});

describe("parseViewConfig", () => {
  it("is empty and editable when unreadable", () => {
    for (const json of ["", "{not json", "null", "3"]) {
      expect(parseViewConfig(json)).toEqual({ filters: [], blocks: [], editable: true, collapsed: NOTHING_COLLAPSED });
    }
  });

  it("reads filters and blocks, dropping blocks that are unreadable; editable unless said otherwise", () => {
    const config = parseViewConfig(JSON.stringify({ filters: [{ id: "r", fieldId: "f", operator: "is", value: "x" }], blocks: [{ id: "a", kind: "table" }, { nope: 1 }], editable: false, collapsed: { blocks: ["a"] } }));
    expect(config.filters).toHaveLength(1);
    expect(config.blocks.map((b) => b.id)).toEqual(["a"]);
    expect(config.editable).toBe(false);
    expect(config.collapsed).toEqual({ blocks: ["a"], groups: {} });
  });

  it("reads \"Show filter bar\" only when it is on", () => {
    expect(parseViewConfig(JSON.stringify({ filters: [], blocks: [], filterBar: true })).filterBar).toBe(true);
    for (const filterBar of [false, "yes", 1, null]) expect("filterBar" in parseViewConfig(JSON.stringify({ filters: [], blocks: [], filterBar }))).toBe(false);
    expect("filterBar" in parseViewConfig(JSON.stringify({ filters: [], blocks: [] }))).toBe(false);
  });

  it("reads \"Full width\" when it is set, either way; absent is the place's default", () => {
    expect(parseViewConfig(JSON.stringify({ filters: [], blocks: [], fullWidth: false })).fullWidth).toBe(false);
    expect(parseViewConfig(JSON.stringify({ filters: [], blocks: [], fullWidth: true })).fullWidth).toBe(true);
    for (const fullWidth of ["yes", 1, null]) expect("fullWidth" in parseViewConfig(JSON.stringify({ filters: [], blocks: [], fullWidth }))).toBe(false);
    expect("fullWidth" in parseViewConfig(JSON.stringify({ filters: [], blocks: [] }))).toBe(false);
  });
});

describe("full width", () => {
  it("defaults to on for collection views and dashboard tabs, off for item views", () => {
    expect(FULL_WIDTH_DEFAULT).toEqual({ collection: true, item: false, dashboard: true });
    expect([isFullWidth("collection"), isFullWidth("item"), isFullWidth("dashboard")]).toEqual([true, false, true]);
  });

  it("is the view's own setting when stored", () => {
    expect(isFullWidth("collection", false)).toBe(false);
    expect(isFullWidth("dashboard", false)).toBe(false);
    expect(isFullWidth("item", true)).toBe(true);
    expect(isFullWidth("item", false)).toBe(false);
  });
});

describe("collapsed", () => {
  it("is read leniently", () => {
    expect(parseCollapsed(null)).toBe(NOTHING_COLLAPSED);
    expect(parseCollapsed("x")).toBe(NOTHING_COLLAPSED);
    expect(parseCollapsed({ blocks: ["a", 1, "b"], groups: { a: ["f/x", 2], b: [], c: "no" } })).toEqual({ blocks: ["a", "b"], groups: { a: ["f/x"] } });
    expect(parseCollapsed({})).toEqual({ blocks: [], groups: {} });
  });

  it("collapses and expands blocks, each once", () => {
    let c = withBlockCollapsed(NOTHING_COLLAPSED, "a", true);
    c = withBlockCollapsed(c, "a", true);
    c = withBlockCollapsed(c, "b", true);
    expect(c.blocks).toEqual(["a", "b"]);
    expect(withBlockCollapsed(c, "a", false).blocks).toEqual(["b"]);
    expect(NOTHING_COLLAPSED.blocks).toEqual([]); // the shared value is never changed
  });

  it("collapses groups by the field they're grouped by, and forgets a block with none left", () => {
    let c = withGroupCollapsed(NOTHING_COLLAPSED, "a", "g", "x", true);
    c = withGroupCollapsed(c, "a", "g", "y", true);
    c = withGroupCollapsed(c, "a", "g", "x", true);
    expect(c.groups).toEqual({ a: ["g/y", "g/x"] });
    expect(collapsedGroups(c, "a", "g")).toEqual(["y", "x"]);
    expect(collapsedGroups(c, "a", "other")).toEqual([]); // grouped by another field now
    expect(collapsedGroups(c, "a", null)).toEqual([]);
    expect(collapsedGroups(c, "nope", "g")).toEqual([]);
    c = withGroupCollapsed(c, "a", "g", "x", false);
    c = withGroupCollapsed(c, "a", "g", "y", false);
    expect(c.groups).toEqual({});
  });
});

describe("block sizes", () => {
  it("heights are whole rem within the limits; old size names mean their rem; nonsense is the initial", () => {
    expect(normalizeBlockHeight(20.4)).toBe(20);
    expect(normalizeBlockHeight(1)).toBe(BLOCK_HEIGHT.min);
    expect(normalizeBlockHeight(1000)).toBe(BLOCK_HEIGHT.max);
    expect([normalizeBlockHeight("s"), normalizeBlockHeight("m"), normalizeBlockHeight("l")]).toEqual([16, 24, 32]);
    for (const raw of ["xl", null, undefined, NaN, Infinity, {}]) expect(normalizeBlockHeight(raw)).toBe(BLOCK_HEIGHT.initial);
  });

  it("aspect ratios are the known ones, else the default", () => {
    for (const a of ASPECT_RATIOS) expect(normalizeAspect(a)).toBe(a);
    for (const raw of ["5:4", null, 3, undefined]) expect(normalizeAspect(raw)).toBe(DEFAULT_ASPECT);
  });

  it("a block is as tall as the less of its height and its width at its aspect ratio", () => {
    expect(blockHeightCss(24, "none")).toBe("24rem");
    expect(blockHeightCss(24, "4:3")).toBe("min(24rem, calc(100cqi * 3 / 4))");
    expect(blockHeightCss(10, "16:9")).toBe("min(10rem, calc(100cqi * 9 / 16))");
  });
});

describe("limits and queries", () => {
  it("shows 100 at a time unless the block says, or needs everything", () => {
    expect(DEFAULT_LIMIT).toBe(100);
    expect(blockLimit({}, false)).toBe(100);
    expect(blockLimit({}, true)).toBe(0);
    expect(blockLimit({ limit: 7 }, true)).toBe(7);
    expect(blockLimit({ limit: 0 }, false)).toBe(0);
  });

  it("a block's query: its filter on the inherited one, no filter as the shared empty list", () => {
    const block = newBlock("table", null, "b");
    const q = blockQuery(null, block);
    expect(q.filters).toBe(NO_FILTERS);
    expect(q.inherited).toBe(NO_FILTERS);
    expect(q).not.toHaveProperty("groupOrder");
    const rules = [{ id: "r", fieldId: "f", operator: "is" as const, value: "x" }];
    const withOrder = blockQuery(rules, { ...block, filters: rules, groupBy: "g", groupOrder: "desc" });
    expect(withOrder).toMatchObject({ filters: rules, inherited: rules, groupBy: "g", groupOrder: "desc" });
  });

  it("a query put in a block replaces its sort and grouping, and a default group order is not kept", () => {
    const block = { ...newBlock("table", null, "b"), groupOrder: "desc" as const };
    const next = withQuery(block, { filters: [], sort: [{ fieldId: "f", direction: "desc" }], groupBy: "g" });
    expect(next).toMatchObject({ sort: [{ fieldId: "f", direction: "desc" }], groupBy: "g" });
    expect(next).not.toHaveProperty("groupOrder");
    expect(withQuery(block, { filters: [], sort: [], groupBy: null, groupOrder: "count" })).toHaveProperty("groupOrder", "count");
  });

  it("the view a collection starts with is a table of everything, editable unless read-only", () => {
    const view = defaultViewState({ cols: 1 });
    expect(view.blocks).toHaveLength(1);
    expect(view.blocks[0]).toMatchObject({ id: "main", kind: "table", options: { cols: 1 } });
    expect(view).toMatchObject({ filters: [], editable: true });
    const remote = defaultViewState(null, ["a", "b"], false, [{ id: "r", fieldId: "f", operator: "is", value: "x" }]);
    expect(remote.blocks[0].layout.fields).toEqual(["a", "b"]);
    expect(remote).toMatchObject({ editable: false });
    expect(remote.filters).toHaveLength(1);
  });
});

describe("pageFilterScope", () => {
  const c = (id: string, name: string, fieldNames: string[], source = false): Collection => ({
    id, name, pluralName: `${name}s`, icon: null, description: "", itemViews: [], spaceIds: null, createdAt: "", updatedAt: "",
    fields: fieldNames.map((n) => blankField(`${id}-${n}`, n, "string")),
    ...(source && { source: { name: "CRM", target: { table: { schema: "p", name: id } }, key: "id", columns: [] } }),
  });

  it("is native (Created and Updated offered) unless every collection is remote", () => {
    expect(pageFilterScope([c("a", "A", ["x"]), c("b", "B", ["y"], true)]).source).toBeNull();
    expect(pageFilterScope([c("a", "A", ["x"], true), c("b", "B", ["y"], true)]).source).toBeTruthy();
  });

  it("names a field that several collections have after its collection", () => {
    const scope = pageFilterScope([c("a", "Book", ["Title", "Year"]), c("b", "Film", ["Title"])]);
    expect(scope.fields.map((f) => f.name)).toEqual(["Title (Book)", "Year", "Title (Film)"]);
  });
});
