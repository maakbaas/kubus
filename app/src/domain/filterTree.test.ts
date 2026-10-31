import { describe, expect, it } from "vitest";
import { filterTree } from "./filterTree";
import type { FilterRule } from "./query";

const rule = (id: string, operator: FilterRule["operator"] = "is", join?: "or"): FilterRule => ({ id, fieldId: "f", operator, value: "x", ...(join && { join }) });
const ids = (tree: unknown): unknown =>
  tree && typeof tree === "object" && !("id" in tree) ? Object.fromEntries(Object.entries(tree).map(([k, v]) => [k, (v as unknown[]).map(ids)])) : (tree as FilterRule).id;

describe("a filter's date period", () => {
  const view = [rule("v")];
  it("frames its filter and what it builds on (And)", () => {
    expect(ids(filterTree([view, [rule("p", "between"), rule("b")]]))).toEqual({ and: ["p", "v", "b"] });
  });
  it("joined with Or, lets in what the filter it builds on doesn't, the block's rules following", () => {
    expect(ids(filterTree([view, [rule("p", "between", "or"), rule("b")]]))).toEqual({ and: [{ or: ["v", "p"] }, "b"] });
    expect(ids(filterTree([view, [rule("p", "between", "or")]]))).toEqual({ or: ["v", "p"] });
    // Building on nothing, there is nothing to or it with.
    expect(ids(filterTree([[], [rule("p", "between", "or"), rule("b")]]))).toEqual({ and: ["p", "b"] });
  });
});
