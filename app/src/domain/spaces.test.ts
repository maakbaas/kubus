import { describe, expect, it } from "vitest";
import { DEFAULT_SPACE_ID, inSpace, withDefaultSpace } from "./spaces";

describe("spaces", () => {
  it("always include the default space, first, until it has a row of its own", () => {
    const work = { id: "w", name: "Work", icon: null, position: 0 };
    expect(withDefaultSpace([]).map((s) => s.id)).toEqual([DEFAULT_SPACE_ID]);
    expect(withDefaultSpace([work]).map((s) => s.id)).toEqual([DEFAULT_SPACE_ID, "w"]);
    const renamed = { id: DEFAULT_SPACE_ID, name: "Private", icon: null, position: -1 };
    expect(withDefaultSpace([renamed, work])).toEqual([renamed, work]);
  });

  it("show a collection everywhere unless it names its spaces", () => {
    expect(inSpace({ spaceIds: null }, "w")).toBe(true);
    expect(inSpace({ spaceIds: ["w"] }, "w")).toBe(true);
    expect(inSpace({ spaceIds: ["w"] }, DEFAULT_SPACE_ID)).toBe(false);
  });
});
