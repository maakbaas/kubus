import { describe, expect, it } from "vitest";
import { nextName, suggestSingular, valuesEqual } from "./model";
import { orderFields } from "./fieldLayout";

describe("valuesEqual", () => {
  it("treats undefined and null alike", () => {
    expect(valuesEqual(undefined, null)).toBe(true);
    expect(valuesEqual("a", null)).toBe(false);
  });
  it("compares lists by content", () => {
    expect(valuesEqual(["a", "b"], ["a", "b"])).toBe(true);
    expect(valuesEqual(["a"], ["b"])).toBe(false);
  });
});

describe("suggestSingular", () => {
  it("takes the plural's ending off", () => {
    expect(["Authors", "Categories", "Boxes", "Glasses", "Matches", "Days", "People", " Books "].map(suggestSingular)).toEqual(["Author", "Category", "Box", "Glass", "Match", "Day", "People", "Book"]);
  });
});

describe("nextName", () => {
  it("numbers copies, continuing the series", () => {
    expect(nextName("View", ["View"])).toBe("View 2");
    expect(nextName("View", ["View", "View 2"])).toBe("View 3");
    expect(nextName("View 2", ["View", "View 2"])).toBe("View 3");
  });
});

describe("orderFields", () => {
  const all = [{ id: "a" }, { id: "$meta" }, { id: "b" }];
  it("null = all, in the collection's order, without meta fields", () => {
    expect(orderFields(all, null).map((f) => f.id)).toEqual(["a", "b"]);
  });
  it("follows the layout and skips unknown ids", () => {
    expect(orderFields(all, ["b", "gone", "a"]).map((f) => f.id)).toEqual(["b", "a"]);
  });
});
