import { describe, expect, it } from "vitest";
import { blankField, type Collection } from "./model";
import type { FilterRule } from "./query";
import { DASHBOARD_DATE, dashboardBlockCollection, dashboardFiltersFor, dashboardScope, dashboardViewsIn, isVirtualTab, newDashboardBlock, type DashboardView } from "./dashboards";
import { mergeCollections } from "./mergedCollection";
import { NOTHING_COLLAPSED } from "./views";
import { inSpace } from "./spaces";

const collection = (id: string, fields: Collection["fields"], source: Collection["source"] = null): Collection => ({
  id, name: id, pluralName: `${id}s`, icon: null, description: "", fields: fields.map((f) => ({ ...f, collectionId: id })), itemViews: [], spaceIds: null, source, createdAt: "", updatedAt: "",
});
const books = collection("Book", [blankField("title", "Title", "string"), blankField("read", "Read", "date"), blankField("done", "Done", "datetime")]);
const people = collection("Person", [blankField("name", "Title", "string"), blankField("born", "Born", "datetime")]);
const notes = collection("Note", [blankField("text", "Text", "markdown")]);

const rule = (fieldId: string, extra: Partial<FilterRule> = {}): FilterRule => ({ id: `r-${fieldId}`, fieldId, operator: "between", value: "2026-01-01..2026-12-31", ...extra });

describe("a dashboard's filter", () => {
  it("is edited against its blocks' fields, Date first (where the filter bar's period goes)", () => {
    const scope = dashboardScope([books, people]);
    expect(scope.fields.map((f) => [f.id, f.name, f.kind])).toEqual([
      [DASHBOARD_DATE, "Date", "date"], ["title", "Title (Book)", "string"], ["read", "Read", "date"], ["done", "Done", "datetime"], ["name", "Title (Person)", "string"], ["born", "Born", "datetime"],
    ]);
    // A dashboard without blocks still has Date.
    expect(dashboardScope([]).fields.map((f) => f.id)).toEqual([DASHBOARD_DATE]);
  });

  it("gives each block its Date rules on its own first date field, and its fields' rules; a block without a date field is left alone", () => {
    const filters = [rule(DASHBOARD_DATE), rule("title", { operator: "contains", value: "x", join: "or" }), rule("born", { operator: "isNotEmpty", value: "" }), rule("$updated", { operator: "isNotEmpty", value: "" })];
    expect(dashboardFiltersFor(books, filters)).toEqual([{ ...filters[0], fieldId: "read" }, filters[1], filters[3]]);
    expect(dashboardFiltersFor(people, filters)).toEqual([{ ...filters[0], fieldId: "born" }, filters[2], filters[3]]);
    expect(dashboardFiltersFor(notes, filters)).toEqual([filters[3]]);
    // A remote collection's rows have no Created / Updated.
    const remote = { ...books, source: { name: "CRM", target: { table: { schema: null, name: "b" } }, key: "id", columns: [] } } as Collection;
    expect(dashboardFiltersFor(remote, filters)).toEqual([{ ...filters[0], fieldId: "read" }, filters[1]]);
  });

  it("gives a block of several collections its Date on the first date column", () => {
    const { collection: merged } = mergeCollections([books.id, people.id], [books, people]);
    const dates = merged.fields.filter((f) => f.kind === "date" || f.kind === "datetime");
    expect(dashboardFiltersFor(merged, [rule(DASHBOARD_DATE)])).toEqual([{ ...rule(DASHBOARD_DATE), fieldId: dates[0].id }]);
  });

  it("gives a block of several collections a rule on one of their fields on the column showing it; others' fields leave it alone", () => {
    const { collection: merged } = mergeCollections([books.id, people.id], [books, people]);
    const columnOf = (collectionId: string, fieldId: string) => Object.entries(merged.mergedFrom!.parts.find((p) => p.collectionId === collectionId)!.map).find(([, f]) => f === fieldId)![0];
    const born = rule("born", { operator: "isNotEmpty", value: "" });
    expect(dashboardFiltersFor(merged, [born, rule("text", { operator: "contains", value: "x" })])).toEqual([{ ...born, fieldId: columnOf("Person", "born") }]);
  });

});

describe("a dashboard's blocks", () => {
  it("always name their collection", () => {
    const block = newDashboardBlock("table", { x: 1 }, books);
    expect(block).toMatchObject({ kind: "table", collectionId: "Book", options: { x: 1 }, filters: null, title: "" });
    expect(dashboardBlockCollection(block)).toBe("Book");
    expect(dashboardBlockCollection({ collectionId: null, collectionIds: ["Person", "Book"] })).toBe("Person");
    expect(dashboardBlockCollection({ collectionId: null })).toBeNull();
  });
});

describe("a dashboard's tabs", () => {
  const tab = (id: string, spaceId: string, position: number, createdAt: string, dashboardId = "d"): DashboardView => ({
    id, dashboardId, spaceId, name: id, position, isDefault: false, filters: [], blocks: [], editable: true, collapsed: NOTHING_COLLAPSED, createdAt, updatedAt: createdAt,
  });

  it("are a space's own, in their order", () => {
    const all = [tab("b", "work", 1, "2026-01-02"), tab("a", "work", 0, "2026-01-03"), tab("x", "default", 0, "2026-01-01"), tab("o", "work", 0, "2026-01-01", "other")];
    expect(dashboardViewsIn(all, "d", "work").map((v) => [v.id, v.virtual])).toEqual([["a", undefined], ["b", undefined]]);
  });

  it("are, in a space without its own, copies of the tabs of the space with the oldest tab", () => {
    const all = [tab("w1", "work", 0, "2026-01-02"), tab("p2", "private", 1, "2026-01-05"), tab("p1", "private", 0, "2026-01-01")];
    const copies = dashboardViewsIn(all, "d", "default");
    expect(copies.map((v) => [v.id, v.spaceId, v.virtual])).toEqual([["virtual:p1", "default", true], ["virtual:p2", "default", true]]);
    expect(copies.every((v) => isVirtualTab(v.id))).toBe(true);
    // The first space's tabs gone (its space deleted): the next oldest.
    expect(dashboardViewsIn(all.filter((v) => v.spaceId !== "private"), "d", "default").map((v) => v.id)).toEqual(["virtual:w1"]);
    expect(dashboardViewsIn([], "d", "default")).toEqual([]);
  });

  it("are shown in the spaces the dashboard is", () => {
    expect(inSpace({ spaceIds: ["work"] }, "work")).toBe(true);
    expect(inSpace({ spaceIds: ["work"] }, "default")).toBe(false);
  });
});
