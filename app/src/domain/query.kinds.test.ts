import { describe, expect, it } from "vitest";
import { blankField, type Collection, type FieldKind, type Item } from "./model";
import {
  applyQuery,
  defaultQuery,
  fieldText,
  filterFields,
  filterOf,
  filterPreset,
  filterValueProblem,
  groupKeysOf,
  groupPreset,
  isEmptyValue,
  isGroupable,
  isGrouped,
  operatorsFor,
  sortableFields,
  type FilterRule,
  type QueryContext,
  type ViewQuery,
} from "./query";

const fields = {
  s: blankField("s", "Text", "string"),
  md: blankField("md", "Notes", "markdown"),
  html: blankField("html", "Page", "html"),
  n: blankField("n", "Number", "number"),
  d: blankField("d", "Date", "date"),
  dt: blankField("dt", "Moment", "datetime"),
  cb: blankField("cb", "Done", "checkbox"),
  img: blankField("img", "Photo", "image"),
  ref: blankField("ref", "Author", "item", { targetCollectionId: "a" }),
  tags: blankField("tags", "Tags", "string_list"),
  chk: blankField("chk", "Steps", "checklist"),
  refs: blankField("refs", "Authors", "item_list", { targetCollectionId: "a" }),
  comp: blankField("comp", "Calc", "component", { code: "{{ 1 }}", output: "number" }),
  ai: blankField("ai", "Summary", "ai", { code: "x", output: "string" }),
};
const collection = (): Collection => ({
  id: "c", name: "Thing", pluralName: "Things", icon: null, description: "", itemViews: [], spaceIds: null, createdAt: "", updatedAt: "", fields: Object.values(fields),
});
const ctx: QueryContext = { refLabel: (_f, id) => ({ a1: "Ann", a2: "Bob" })[id] ?? "?" };
const item = (id: string, values: Item["values"], extra: Partial<Item> = {}): Item => ({ id, collectionId: "c", spaceId: "s", values, createdAt: `2026-01-0${id}T00:00:00.000Z`, updatedAt: `2026-02-0${id}T00:00:00.000Z`, ...extra });
const rule = (fieldId: string, operator: FilterRule["operator"], value = ""): FilterRule => ({ id: `${fieldId}-${operator}-${value}`, fieldId, operator, value });
const ids = (items: Item[]) => items.map((i) => i.id);

describe("operators per kind", () => {
  it("every kind offers some, and 'between' is only the date period's", () => {
    for (const kind of Object.keys(fieldsByKind()) as FieldKind[]) {
      const ops = operatorsFor(kind).map((o) => o.id);
      expect(ops.length, kind).toBeGreaterThan(0);
      expect(ops, kind).not.toContain("between");
    }
  });

  it("each kind its own", () => {
    expect(operatorsFor("number").map((o) => o.label)).toEqual(["=", "≠", ">", "<", "is empty", "is not empty"]);
    expect(operatorsFor("checkbox").map((o) => o.id)).toEqual(["isChecked", "isNotChecked", "is"]);
    expect(operatorsFor("date").map((o) => o.id)).toContain("before");
    expect(operatorsFor("datetime").find((o) => o.id === "is")?.label).toBe("is on");
    expect(operatorsFor("item_list").find((o) => o.id === "is")?.label).toBe("includes");
    expect(operatorsFor("image").map((o) => o.id)).toEqual(["isEmpty", "isNotEmpty"]);
    expect(operatorsFor("ai").map((o) => o.id)).toEqual(["contains", "notContains", "is", "isNot", "gt", "lt", "isEmpty", "isNotEmpty"]);
    expect(operatorsFor("string").find((o) => o.id === "isEmpty")?.needsValue).toBe(false);
  });
});
function fieldsByKind() {
  return Object.fromEntries(Object.values(fields).map((f) => [f.kind, f]));
}

describe("filtering by kind", () => {
  const items = [
    item("1", { s: "Alpha", md: "# Heading\n\nsome **bold**", html: "<p>Hello <b>world</b></p>", n: 5, d: "2026-03-10", dt: "2026-03-10T23:30:00.000Z", cb: true, img: "f1", ref: "a1", tags: ["x", "y"], chk: ["[x] one", "[ ] two"], refs: ["a1", "a2"], comp: 7, ai: "sum" }),
    item("2", { s: "beta", n: 20, d: "2026-04-01", cb: false, ref: "a2", tags: ["z"], chk: ["[ ] three"], refs: ["a2"], comp: "text" }),
    item("3", {}),
  ];
  const run = (...rules: FilterRule[]) => ids(items.filter(filterOf(collection(), rules, ctx)));

  it("text compares case-insensitively", () => {
    expect(run(rule("s", "contains", "ALP"))).toEqual(["1"]);
    expect(run(rule("s", "notContains", "alp"))).toEqual(["2", "3"]);
    expect(run(rule("s", "is", "BETA"))).toEqual(["2"]);
    expect(run(rule("s", "isNot", "beta"))).toEqual(["1", "3"]);
    expect(run(rule("s", "isEmpty"))).toEqual(["3"]);
    expect(run(rule("s", "isNotEmpty"))).toEqual(["1", "2"]);
  });

  it("Markdown and HTML are read as what they show", () => {
    expect(run(rule("md", "contains", "bold"))).toEqual(["1"]);
    expect(run(rule("md", "contains", "**"))).toEqual([]);
    expect(run(rule("html", "contains", "hello world"))).toEqual(["1"]);
    expect(run(rule("html", "contains", "<b>"))).toEqual([]);
  });

  it("numbers compare as numbers", () => {
    expect(run(rule("n", "is", "5"))).toEqual(["1"]);
    expect(run(rule("n", "isNot", "5"))).toEqual(["2", "3"]);
    expect(run(rule("n", "gt", "5"))).toEqual(["2"]);
    expect(run(rule("n", "lt", "10"))).toEqual(["1"]);
    expect(run(rule("n", "gt", "abc"))).toEqual([]); // can't be compared: nothing
  });

  it("dates compare by day, a date & time by the day it falls on here", () => {
    expect(run(rule("d", "is", "2026-04-01"))).toEqual(["2"]);
    expect(run(rule("d", "before", "2026-04-01"))).toEqual(["1"]);
    expect(run(rule("d", "after", "2026-03-10"))).toEqual(["2"]);
    expect(run(rule("d", "after", "20260310"))).toEqual([]);
    const local = (iso: string) => {
      const d = new Date(iso);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    expect(run(rule("dt", "is", local("2026-03-10T23:30:00.000Z")))).toEqual(["1"]);
    expect(run(rule("dt", "isEmpty"))).toEqual(["2", "3"]);
  });

  it("checkboxes", () => {
    expect(run(rule("cb", "isChecked"))).toEqual(["1"]);
    expect(run(rule("cb", "isNotChecked"))).toEqual(["2", "3"]);
    expect(run(rule("cb", "is", "false"))).toEqual(["2", "3"]);
    expect(run(rule("cb", "is", "TRUE"))).toEqual(["1"]);
    expect(run(rule("cb", "is", "maybe"))).toEqual([]);
  });

  it("references by id, lists by what they hold, by the labels for text", () => {
    expect(run(rule("ref", "is", "a2"))).toEqual(["2"]);
    expect(run(rule("ref", "isNot", "a2"))).toEqual(["1", "3"]);
    expect(run(rule("ref", "isEmpty"))).toEqual(["3"]);
    expect(run(rule("refs", "is", "a1"))).toEqual(["1"]);
    expect(run(rule("refs", "isNot", "a1"))).toEqual(["2", "3"]);
    expect(run(rule("tags", "contains", "y"))).toEqual(["1"]);
    expect(run(rule("tags", "isEmpty"))).toEqual(["3"]);
    expect(run(rule("chk", "contains", "three"))).toEqual(["2"]);
    expect(run(rule("img", "isNotEmpty"))).toEqual(["1"]);
  });

  it("computed and AI values are compared as they came out", () => {
    expect(run(rule("comp", "is", "7"))).toEqual(["1"]);
    expect(run(rule("comp", "contains", "tex"))).toEqual(["2"]);
    expect(run(rule("ai", "contains", "sum"))).toEqual(["1"]);
    expect(run(rule("ai", "isEmpty"))).toEqual(["2", "3"]);
  });

  it("created and updated can be filtered like dates", () => {
    expect(run(rule("$created", "is", "2026-01-02"))).toEqual(["2"]);
    expect(run(rule("$updated", "after", "2026-01-30"))).toEqual(["1", "2", "3"]);
  });

  it("a rule without its value doesn't filter yet; one on a field that's gone neither", () => {
    expect(run(rule("s", "contains", "  "))).toEqual(["1", "2", "3"]);
    expect(run(rule("gone", "is", "x"))).toEqual(["1", "2", "3"]);
  });

  it("reads text of any kind for search", () => {
    const c = collection();
    expect(fieldText(fields.ref, items[0], ctx)).toBe("Ann");
    expect(fieldText(fields.refs, items[0], ctx)).toBe("Ann, Bob");
    expect(fieldText(fields.cb, items[0], ctx)).toBe("yes");
    expect(fieldText(fields.cb, items[2], ctx)).toBe("no");
    expect(fieldText(fields.tags, items[0], ctx)).toBe("x, y");
    expect(fieldText(fields.chk, items[0], ctx)).toBe("one, two");
    expect(fieldText(fields.n, items[0], ctx)).toBe("5");
    expect(fieldText(fields.dt, items[2], ctx)).toBe("");
    expect(fieldText(fields.comp, items[2], ctx)).toBe("");
    expect(c.fields).toHaveLength(14);
  });
});

describe("sorting by kind", () => {
  const sorted = (field: string, direction: "asc" | "desc" = "asc") => {
    const items = [item("1", { s: "b", n: 20, d: "2026-02-01", cb: true, ref: "a2", tags: ["b"], chk: ["[x] a", "[ ] b"], refs: ["a2"], comp: "b", ai: "b", md: "B", html: "<p>b</p>", img: "f", dt: "2026-02-01T10:00:00.000Z" }), item("2", { s: "A", n: 10, d: "2026-01-01", cb: false, ref: "a1", tags: ["a"], chk: ["[x] a"], refs: ["a1"], comp: 5, ai: "a", md: "a", html: "<p>A</p>", dt: "2026-01-01T10:00:00.000Z" }), item("3", {})];
    return ids(applyQuery(collection(), items, { filters: [], sort: [{ fieldId: field, direction }], groupBy: null }, ctx).groups[0].items);
  };

  it("each kind by its own key, empty values last whichever way", () => {
    for (const field of ["s", "n", "d", "dt", "ref", "tags", "refs", "md", "html", "ai"]) {
      expect(sorted(field, "asc"), field).toEqual(["2", "1", "3"]);
      expect(sorted(field, "desc"), field).toEqual(["1", "2", "3"]);
    }
  });

  it("a checkbox sorts unchecked first (empty counts as unchecked)", () => {
    expect(sorted("cb")).toEqual(["2", "3", "1"]);
  });

  it("a checklist sorts by how far along it is, empty last", () => {
    expect(sorted("chk")).toEqual(["1", "2", "3"]); // 1/2 before 1/1
  });

  it("an image sorts by whether there is one", () => {
    expect(sorted("img")).toEqual(["2", "3", "1"]);
  });

  it("a computed value sorts as a number when it is one, else as text; numbers before text", () => {
    const out = sorted("comp");
    expect(out.slice(-1)).toEqual(["3"]);
  });

  it("created, updated and title", () => {
    expect(sorted("$created", "desc")).toEqual(["3", "2", "1"]);
    expect(sorted("$updated")).toEqual(["1", "2", "3"]);
    expect(sorted("$title")).toEqual(["2", "1", "3"]); // "A", "b", then the untitled one by its collection's name, Thing
  });

  it("sorting by a field that's gone keeps the order", () => {
    expect(sorted("gone")).toEqual(["1", "2", "3"]);
  });

  it("sorts on several fields in turn", () => {
    const items = [item("1", { s: "x", n: 2 }), item("2", { s: "x", n: 1 }), item("3", { s: "a", n: 9 })];
    const q: ViewQuery = { filters: [], sort: [{ fieldId: "s", direction: "asc" }, { fieldId: "n", direction: "asc" }], groupBy: null };
    expect(ids(applyQuery(collection(), items, q, ctx).groups[0].items)).toEqual(["3", "2", "1"]);
  });
});

describe("grouping", () => {
  const groupBy = (field: string, items: Item[], extra: Partial<ViewQuery> = {}) => applyQuery(collection(), items, { ...defaultQuery(), groupBy: field, ...extra }, ctx);

  it("by a text field: a group per value, the empty group last", () => {
    const r = groupBy("s", [item("1", { s: "b" }), item("2", { s: "a" }), item("3", {}), item("4", { s: "b" })]);
    expect(r.groups.map((g) => [g.key, g.label, ids(g.items)])).toEqual([["a", "a", ["2"]], ["b", "b", ["1", "4"]], ["", "(empty)", ["3"]]]);
    expect(r.total).toBe(4);
    expect(isGrouped(r)).toBe(true);
  });

  it("groups can be ordered Z to A, or the largest first (ties by name), the empty group still last", () => {
    const items = [item("1", { s: "a" }), item("2", { s: "b" }), item("3", { s: "b" }), item("4", { s: "c" }), item("5", {})];
    expect(groupBy("s", items, { groupOrder: "desc" }).groups.map((g) => g.key)).toEqual(["c", "b", "a", ""]);
    expect(groupBy("s", items, { groupOrder: "count" }).groups.map((g) => g.key)).toEqual(["b", "a", "c", ""]);
  });

  it("an item of a list falls in a group per value", () => {
    const r = groupBy("tags", [item("1", { tags: ["x", "y"] }), item("2", { tags: ["y"] }), item("3", { tags: [] })]);
    expect(r.groups.map((g) => [g.key, ids(g.items)])).toEqual([["x", ["1"]], ["y", ["1", "2"]], ["", ["3"]]]);
    expect(r.total).toBe(3); // an item in several groups counts once
  });

  it("by reference: the label names the group, the id keys it", () => {
    const r = groupBy("ref", [item("1", { ref: "a2" }), item("2", { ref: "a1" })]);
    expect(r.groups.map((g) => [g.key, g.label])).toEqual([["a1", "Ann"], ["a2", "Bob"]]);
    expect(groupBy("refs", [item("1", { refs: ["a1", "a2"] })]).groups.map((g) => g.label)).toEqual(["Ann", "Bob"]);
  });

  it("by checkbox, number, date, date & time and computed value", () => {
    expect(groupBy("cb", [item("1", { cb: true }), item("2", {})]).groups.map((g) => g.label)).toEqual(["Checked", "Not checked"].sort());
    expect(groupBy("n", [item("1", { n: 3 }), item("2", {})]).groups.map((g) => g.key)).toEqual(["3", ""]);
    expect(groupBy("d", [item("1", { d: "2026-01-01" })]).groups[0].key).toBe("2026-01-01");
    expect(groupBy("dt", [item("1", { dt: "not a date" }), item("2", {})]).groups.map((g) => g.key)).toEqual(["not a date", ""]);
    expect(groupBy("comp", [item("1", { comp: 7 }), item("2", {})]).groups.map((g) => g.key)).toEqual(["7", ""]);
    expect(groupBy("ai", [item("1", { ai: "x" })]).groups[0].key).toBe("x");
  });

  it("a field that can't group, or isn't there, gives one unnamed group", () => {
    for (const field of ["md", "chk", "img", "gone"]) {
      const r = groupBy(field, [item("1", {})]);
      expect(r.groups).toHaveLength(1);
      expect(r.groups[0]).toMatchObject({ key: "", label: "" });
      expect(isGrouped(r)).toBe(false);
    }
  });

  it("knows which kinds group, and what groups an item falls in", () => {
    expect(isGroupable("string")).toBe(true);
    expect(isGroupable("markdown")).toBe(false);
    expect(isGroupable("checklist")).toBe(false);
    expect(groupKeysOf(fields.tags, item("1", { tags: ["x"] }), ctx)).toEqual([{ key: "x", label: "x" }]);
    expect(groupKeysOf(fields.md, item("1", {}), ctx)).toEqual([]);
    expect(groupKeysOf({ ...fields.s, id: "$created" }, item("1", {}), ctx)).toEqual([{ key: "2026-01-01T00:00:00.000Z", label: "2026-01-01T00:00:00.000Z" }]);
  });

  it("a new item in a group takes the group's value", () => {
    const q = (groupBy: string): ViewQuery => ({ ...defaultQuery(), groupBy });
    const c = collection();
    expect(groupPreset(c, q("s"), "Alpha")).toEqual({ s: "Alpha" });
    expect(groupPreset(c, q("n"), "3")).toEqual({ n: 3 });
    expect(groupPreset(c, q("cb"), "yes")).toEqual({ cb: true });
    expect(groupPreset(c, q("cb"), "no")).toEqual({ cb: false });
    expect(groupPreset(c, q("ref"), "a1")).toEqual({ ref: "a1" });
    expect(groupPreset(c, q("tags"), "x")).toEqual({ tags: ["x"] });
    expect(groupPreset(c, q("refs"), "a1")).toEqual({ refs: ["a1"] });
    expect(groupPreset(c, q("d"), "2026-01-01")).toEqual({ d: "2026-01-01" });
    // None for the "(empty)" group, a date & time (a day is not a moment), or when not grouped.
    expect(groupPreset(c, q("s"), "")).toEqual({});
    expect(groupPreset(c, q("dt"), "2026-01-01")).toEqual({});
    expect(groupPreset(c, defaultQuery(), "x")).toEqual({});
    expect(groupPreset(c, q("gone"), "x")).toEqual({});
  });
});

describe("searching", () => {
  it("looks in every field's text, case-insensitively, and combines with the filter", () => {
    const items = [item("1", { s: "Dune", ref: "a1" }), item("2", { s: "Emma", ref: "a2" }), item("3", { md: "about dune" })];
    const find = (search: string, filters: FilterRule[] = []) => ids(applyQuery(collection(), items, { ...defaultQuery(), filters }, ctx, search).groups[0].items);
    expect(find("DUNE")).toEqual(["1", "3"]);
    expect(find("bob")).toEqual(["2"]); // the label of a reference
    expect(find("  ")).toEqual(["1", "2", "3"]);
    expect(find("dune", [rule("s", "isNotEmpty")])).toEqual(["1"]);
    expect(find("zzz")).toEqual([]);
  });
});

describe("filter values", () => {
  const field = (kind: FieldKind) => blankField("f", "F", kind);

  it("can't be compared when they don't fit the field: said at the input", () => {
    expect(filterValueProblem(field("checkbox"), "is", "maybe")).toBe("A checkbox is true or false");
    expect(filterValueProblem(field("number"), "gt", "abc")).toBe("Not a number");
    expect(filterValueProblem(field("date"), "before", "10 March")).toBe("A date is yyyy-mm-dd");
    expect(filterValueProblem(field("datetime"), "is", "2026-3-1")).toBe("A date is yyyy-mm-dd");
    expect(filterValueProblem(field("string"), "between", "x")).toMatch(/period is/i);
    expect(filterValueProblem(field("date"), "between", "nonsense")).toMatch(/period is/i);
  });

  it("fit when they do, or are not compared (text, empty, from the page)", () => {
    expect(filterValueProblem(field("checkbox"), "is", "TRUE")).toBeUndefined();
    expect(filterValueProblem(field("number"), "is", "1.5")).toBeUndefined();
    expect(filterValueProblem(field("date"), "after", "2026-03-10")).toBeUndefined();
    expect(filterValueProblem(field("date"), "between", "2026-03-01..2026-03-31")).toBeUndefined();
    expect(filterValueProblem(field("string"), "contains", "anything")).toBeUndefined();
    expect(filterValueProblem(field("number"), "gt", "")).toBeUndefined();
    expect(filterValueProblem(field("number"), "gt", "$item.n")).toBeUndefined();
    expect(filterValueProblem(field("number"), "isEmpty", "junk")).toBeUndefined();
  });

  it("a failing {{ }} result is its message", () => {
    expect(filterValueProblem(field("number"), "is", "⚠ boom")).toBe("boom");
  });
});

describe("presets from a filter", () => {
  it("a new item gets the references the filter requires", () => {
    const c = collection();
    expect(filterPreset(c, [rule("ref", "is", "a1"), rule("refs", "is", "a1"), rule("refs", "is", "a2"), rule("s", "is", "x"), rule("ref", "isNot", "a2")])).toEqual({ ref: "a1", refs: ["a1", "a2"] });
  });

  it("not from the page's item, a gone field or an empty value; the view's filter counts too", () => {
    const c = collection();
    expect(filterPreset(c, [rule("ref", "is", "$item"), rule("gone", "is", "x"), rule("ref", "is", "")])).toEqual({});
    expect(filterPreset(c, [], [rule("ref", "is", "a2")])).toEqual({ ref: "a2" });
  });
});

describe("the lists a query works from", () => {
  it("empty means no value; an unchecked box is a value", () => {
    for (const v of [null, undefined, "", []]) expect(isEmptyValue(v as never)).toBe(true);
    for (const v of [false, 0, "x", ["a"]]) expect(isEmptyValue(v as never)).toBe(false);
  });

  it("sortable fields: title, the fields, then updated and created", () => {
    expect(sortableFields(collection()).map((f) => f.id)).toEqual(["$title", ...Object.values(fields).map((f) => f.id), "$updated", "$created"]);
  });

  it("filter fields add the item itself", () => {
    expect(filterFields(collection()).map((f) => f.id).slice(-3)).toEqual(["$created", "$updated", "$id"]);
  });
});
