import { describe, expect, it } from "vitest";
import { centreOf, defaultRegions, matchKey, normalizeRegions, regionFinder, regionsOf } from "./regions";

describe("regions", () => {
  it("are a map's named features, a repeated name made unique by its code", () => {
    const regions = regionsOf([
      { properties: { name: "Drenthe", id: "NL-DR", NAME_ENG: "Drenthe" } },
      { properties: { name: "Georgia", id: "GE" } },
      { properties: { name: "Georgia", id: "US-GA" } },
      { id: "XX", properties: {} },
      { properties: {} },
    ]);
    expect(regions.map((r) => [r.key, r.feature, r.id])).toEqual([
      ["Drenthe", 0, "NL-DR"],
      ["Georgia", 1, "GE"],
      ["Georgia (US-GA)", 2, "US-GA"],
      ["XX", 3, "XX"],
    ]);
  });

  it("are found by code or name, ignoring case, accents and punctuation, a code first", () => {
    const find = regionFinder(
      regionsOf([
        { properties: { name: "Noord-Holland", id: "NL-NH" } },
        { properties: { name: "Fryslân", id: "NL-FR", NAME_ENG: "Friesland" } },
        { properties: { name: "NL-NH", id: "ZZ" } },
      ]),
    );
    expect(find("noord holland")?.id).toBe("NL-NH");
    expect(find("Fryslan")?.id).toBe("NL-FR");
    expect(find("FRIESLAND")?.id).toBe("NL-FR");
    expect(find("nl-nh")?.id).toBe("NL-NH");
    expect(find("Utrecht")).toBeNull();
    expect(matchKey("  São  Paulo! ")).toBe("sao paulo");
  });

  it("are stored as a map and its file; a downloaded map without its file is the world", () => {
    const file = `files/${"a".repeat(64)}`;
    expect(normalizeRegions(undefined)).toEqual(defaultRegions());
    expect(normalizeRegions({ map: "netherlandsLow", file })).toEqual({ map: "netherlandsLow", file });
    expect(normalizeRegions({ map: "netherlandsLow", file: null })).toEqual(defaultRegions());
    expect(normalizeRegions({ map: "europeLow", file })).toEqual({ map: "europeLow", file: null });
    expect(normalizeRegions({ map: "../evil", file })).toEqual(defaultRegions());
  });
});

describe("centreOf", () => {
  it("centres a map opposite its widest gap, a map across 180° whole, a world on 0", () => {
    expect(centreOf([3, 7])).toBeCloseTo(5, 0); // the Netherlands
    expect(Math.abs(centreOf([172, 179, -179, -160, -60]))).toBeGreaterThan(100); // North America with the Aleutians: on the Pacific side of its gap
    const fiji = centreOf([177, 179, -179]);
    expect(Math.abs(fiji)).toBeGreaterThan(170);
    expect(centreOf(Array.from({ length: 36 }, (_, i) => i * 10 - 180))).toBe(0);
    expect(centreOf([])).toBe(0);
  });
});
