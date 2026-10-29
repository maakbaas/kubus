// Regions of a choropleth (domain/chart.ts): the areas of a map (amCharts' geodata: views/regionMaps.ts
// loads them) and which of them a category's label is. Storage-free and UI-free.
//
// A map is a GeoJSON FeatureCollection whose features carry a code (`id`: "NL", "NL-DR") and names
// (`name`, and in many maps `NAME_ENG`: "Drenthe", "North Denmark Region"). A label is a region when it
// is its code or one of its names, ignoring case, accents and punctuation ("noord holland" is
// "Noord-Holland", "Fryslân" is "fryslan").

/** The map a choropleth shows: an amCharts map by name ("worldLow", "netherlandsLow") and, when it isn't bundled, the stored file. */
export interface ChartRegions {
  map: string;
  /** The downloaded map as `files/<id>` (block_file_uses keeps it while the block names it); null for a bundled map. */
  file: string | null;
}

/** The world's countries, bundled (views/regionMaps.ts) like those of every continent and area below. */
export const WORLD_MAP = "worldLow";
/** Europe's countries. */
export const EUROPE_MAP = "europeLow";
/** The bundled maps, each its countries (app/src/geodata: `<map>.json`), in the order the Regions select lists them. */
export const BUNDLED_MAPS: { map: string; label: string }[] = [
  { map: WORLD_MAP, label: "World" },
  { map: "africaLow", label: "Africa" },
  { map: "asiaLow", label: "Asia" },
  { map: EUROPE_MAP, label: "Europe" },
  { map: "northAmericaLow", label: "North America" },
  { map: "southAmericaLow", label: "South America" },
  { map: "oceaniaLow", label: "Oceania" },
  { map: "centralAmericaLow", label: "Central America" },
  { map: "caribbeanLow", label: "Caribbean" },
  { map: "latinAmericaLow", label: "Latin America" },
  { map: "middleEastLow", label: "Middle East" },
];
export const isBundledMap = (map: string) => BUNDLED_MAPS.some((m) => m.map === map);

export const defaultRegions = (): ChartRegions => ({ map: WORLD_MAP, file: null });

const MAP_NAME = /^[A-Za-z0-9]+$/;
const FILE_SRC = /^files\/[0-9a-f]{64}$/;

/** Stored regions made valid: an unknown map is the world; a downloaded map without its file can't be shown (the world instead). */
export function normalizeRegions(raw: unknown): ChartRegions {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const map = typeof r.map === "string" && MAP_NAME.test(r.map) ? r.map : WORLD_MAP;
  const file = typeof r.file === "string" && FILE_SRC.test(r.file) ? r.file : null;
  if (!isBundledMap(map) && !file) return defaultRegions();
  return { map, file: isBundledMap(map) ? null : file };
}

/** One region of a map. */
export interface Region {
  /** Its name, unique in the map (a repeated one gets its code: "Georgia (GE)"): how the chart names it. */
  key: string;
  /** Its feature's place in the map's features. */
  feature: number;
  /** Its code, "" without one. */
  id: string;
  /** Its names and code as matched (`matchKey`). */
  names: string[];
}

/** A label as matched: lower case, without accents, every run of punctuation and spaces one space. */
export const matchKey = (label: string): string =>
  label
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

type Feature = { id?: unknown; properties?: Record<string, unknown> | null };

/** The regions of a map's features, in their order (a feature without a name or code is left out). */
export function regionsOf(features: Feature[]): Region[] {
  const taken = new Set<string>();
  const regions: Region[] = [];
  for (const [feature, f] of features.entries()) {
    const p = f.properties ?? {};
    const id = typeof p.id === "string" ? p.id : typeof f.id === "string" ? f.id : "";
    const name = typeof p.name === "string" && p.name.trim() ? p.name.trim() : id;
    if (!name) continue;
    let key = taken.has(name) && id ? `${name} (${id})` : name;
    for (let i = 2; taken.has(key); i++) key = `${name} (${i})`;
    taken.add(key);
    const names = [name, p.NAME_ENG, id].filter((n): n is string => typeof n === "string" && n.trim() !== "").map(matchKey);
    regions.push({ key, feature, id, names: [...new Set(names)] });
  }
  return regions;
}

/**
 * Finds a label's region: by its code first ("NL" is the Netherlands, not a region named "NL"), then by
 * a name; null when none is it.
 */
export function regionFinder(regions: Region[]): (label: string) => Region | null {
  const byCode = new Map<string, Region>();
  const byName = new Map<string, Region>();
  for (const r of regions) {
    if (r.id) byCode.set(matchKey(r.id), r);
    for (const n of r.names) if (!byName.has(n)) byName.set(n, r);
  }
  return (label) => {
    const key = matchKey(label);
    return byCode.get(key) ?? byName.get(key) ?? null;
  };
}

/**
 * The longitude a map is centred on: opposite the widest gap between its regions' longitudes, so a map
 * across 180° (the Aleutians, Chukotka, Fiji) is drawn whole rather than at both edges; 0 for a map
 * round the world (no gap of 30°).
 */
export function centreOf(longitudes: number[]): number {
  const degrees = [...new Set(longitudes.map((l) => Math.floor(((l % 360) + 540) % 360) - 180))].sort((a, b) => a - b);
  if (degrees.length === 0) return 0;
  let gap = 360 - degrees[degrees.length - 1] + degrees[0];
  let after = degrees[degrees.length - 1];
  for (let i = 1; i < degrees.length; i++) {
    if (degrees[i] - degrees[i - 1] > gap) {
      gap = degrees[i] - degrees[i - 1];
      after = degrees[i - 1];
    }
  }
  if (gap < 30) return 0;
  const centre = after + gap / 2 + 180;
  return ((centre + 540) % 360) - 180;
}
