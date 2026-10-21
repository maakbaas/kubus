import { describe, expect, it } from "vitest";
import { checklistItems, checklistProgress, itemString, parseItem } from "./checklist";

describe("checklist", () => {
  it("parses stored task lines", () => {
    expect(parseItem("[x] Buy milk")).toEqual({ done: true, text: "Buy milk" });
    expect(parseItem("[ ] Call Anna")).toEqual({ done: false, text: "Call Anna" });
  });

  it("reads text without a marker as not done", () => {
    expect(parseItem("plain")).toEqual({ done: false, text: "plain" });
  });

  it("round-trips through itemString", () => {
    for (const stored of ["[x] a", "[ ] b"]) expect(itemString(parseItem(stored))).toBe(stored);
  });

  it("shows progress as done/all, empty for no items", () => {
    expect(checklistProgress(["[x] a", "[ ] b", "[x] c"])).toBe("2/3");
    expect(checklistProgress([])).toBe("");
    expect(checklistProgress(null)).toBe("");
    expect(checklistItems("not a list")).toEqual([]);
  });
});
