import { describe, expect, it } from "vitest";
import { blockSort, isDefaultBlockSort } from "./blockSort";
import { blankField, type Collection } from "./model";
import type { SortRule } from "./query";
import { newBlock, parseBlock, withQuery } from "./views";

const collection = { id: "c", name: "Book", pluralName: "Books", icon: null, description: "", itemViews: [], spaceIds: null, createdAt: "", updatedAt: "", fields: [] } as unknown as Collection;
const dated = { ...collection, fields: [blankField("d", "Day", "date"), blankField("t", "At", "datetime")] } as Collection;
const byTime: SortRule[] = [{ fieldId: "d", direction: "asc" }];
const byTitle: SortRule[] = [{ fieldId: "$title", direction: "asc" }];
const chosen = (kind: string, sort = byTitle) => ({ ...newBlock(kind, null), sort, sortChosen: true as const }) as ReturnType<typeof newBlock>;

describe("a block's default sort", () => {
  it("is time order for a chart and a map that has no chosen sort, by title for the other types", () => {
    for (const kind of ["chart", "map"]) {
      expect(blockSort(newBlock(kind, null), dated)).toEqual(byTime);
      expect(blockSort({ ...newBlock(kind, null), sort: [] }, dated)).toEqual(byTime);
    }
    for (const kind of ["table", "cards", "component", "markdown"]) expect(blockSort(newBlock(kind, null), dated)).toEqual(byTitle);
  });

  it("falls back to the title without a date field", () => {
    expect(blockSort(newBlock("chart", null), collection)).toEqual(byTitle);
    expect(isDefaultBlockSort(newBlock("chart", null), collection)).toBe(true);
  });

  it("honours an explicitly chosen Title on a chart or map", () => {
    for (const kind of ["chart", "map"]) expect(blockSort(chosen(kind), dated)).toEqual(byTitle);
  });

  it("reads a legacy block (exactly the title sort, no marker) as unset", () => {
    expect(blockSort(parseBlock({ id: "b", kind: "chart", sort: byTitle })!, dated)).toEqual(byTime);
  });

  it("keeps a sort that was set", () => {
    const set = [{ fieldId: "b", direction: "desc" }] as const;
    expect(blockSort({ ...newBlock("chart", null), sort: [...set] }, dated)).toEqual(set);
  });

  it("marks the Sort button for anything but the type's default, a chosen Title on a chart included", () => {
    expect(isDefaultBlockSort(newBlock("chart", null), dated)).toBe(true);
    expect(isDefaultBlockSort(chosen("chart", byTime), dated)).toBe(true);
    expect(isDefaultBlockSort(chosen("chart", [{ fieldId: "d", direction: "desc" }]), dated)).toBe(false);
    expect(isDefaultBlockSort(chosen("chart"), dated)).toBe(false);
    expect(isDefaultBlockSort(newBlock("table", null), dated)).toBe(true);
    expect(isDefaultBlockSort(chosen("table"), dated)).toBe(true);
    expect(isDefaultBlockSort({ ...newBlock("table", null), sort: byTime }, dated)).toBe(false);
  });
});

describe("withQuery and the chosen sort", () => {
  const block = newBlock("chart", null);
  it("marks a sort that differs from the one the editor showed (Title picked over the date default)", () => {
    const next = withQuery(block, { filters: [], sort: byTitle, groupBy: null }, byTime);
    expect(next.sortChosen).toBe(true);
    expect(blockSort(next, dated)).toEqual(byTitle);
  });
  it("leaves a grouping change alone, and keeps a mark once set", () => {
    expect(withQuery(block, { filters: [], sort: byTime, groupBy: "x" }, byTime)).not.toHaveProperty("sortChosen");
    expect(withQuery(chosen("chart"), { filters: [], sort: byTitle, groupBy: "x" }, byTitle).sortChosen).toBe(true);
  });
  it("is stored and parsed", () => {
    expect(parseBlock(JSON.parse(JSON.stringify(chosen("chart"))))!.sortChosen).toBe(true);
  });
});
