import { describe, expect, it } from "vitest";
import { suggestSingular, valuesEqual } from "./model";

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
