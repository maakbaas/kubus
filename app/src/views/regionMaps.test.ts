import { describe, expect, it } from "vitest";
import { BUNDLED_MAPS } from "../domain/regions";
import { COUNTRY_MAPS, geodataUrl, mapLabel } from "./regionMaps";

describe("region maps", () => {
  it("list every country map once, none of them a bundled one", () => {
    const names = COUNTRY_MAPS.map((m) => m.map);
    expect(new Set(names).size).toBe(names.length);
    expect(names.some((n) => BUNDLED_MAPS.some((b) => b.map === n))).toBe(false);
    expect(names.every((n) => /^[A-Za-z0-9]+Low$/.test(n))).toBe(true);
  });

  it("are downloaded from one pinned release, and named for people", () => {
    expect(geodataUrl("netherlandsLow")).toBe("https://cdn.jsdelivr.net/npm/@amcharts/amcharts5-geodata@5.1.6/json/netherlandsLow.json");
    expect(mapLabel("netherlandsLow")).toBe("Netherlands");
    expect(mapLabel("worldLow")).toBe("World");
  });
});
