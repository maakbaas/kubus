import { topology } from "topojson-server";
import type { Topology } from "topojson-specification";
import type { Repository } from "../data";
import { fileIdFromSrc, fileSrc } from "../domain/files";
import { EUROPE_MAP, regionsOf, WORLD_MAP, type ChartRegions, type Region } from "../domain/regions";
import { MAX_FILE_BYTES } from "../../../shared/sync";
import maps from "../geodata/maps.json";

// The maps a choropleth shows: amCharts' geodata (@amcharts/amcharts5-geodata, its LICENSE in
// app/src/geodata). The world's and Europe's countries are bundled (app/src/geodata, each its own
// chunk, loaded when shown); a country's regions are downloaded once, when chosen, from jsDelivr at a
// pinned version and stored as a file (`ChartRegions.file`), so the chart looks the same offline and
// on every synced device. Carbon's choropleth takes TopoJSON with the regions in `objects.countries`,
// each named by `properties.NAME`: a map is made into that here, named by its regions' keys.

/** The geodata release maps are downloaded from: every device downloads the same bytes (one file id). */
export const GEODATA_VERSION = "5.1.6";
export const geodataUrl = (map: string) => `https://cdn.jsdelivr.net/npm/@amcharts/amcharts5-geodata@${GEODATA_VERSION}/json/${map}.json`;

/** A country's maps (a country can have several: "France · Departments"), in the order the Regions select lists them. */
export interface CountryMap {
  map: string;
  label: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  continent: string;
}
export const COUNTRY_MAPS: CountryMap[] = maps;
export const mapLabel = (map: string): string =>
  map === WORLD_MAP ? "World" : map === EUROPE_MAP ? "Europe" : (COUNTRY_MAPS.find((m) => m.map === map)?.label ?? map);

/** A map ready to draw: its regions and Carbon's TopoJSON of them. */
export interface RegionMap {
  regions: Region[];
  topology: Topology;
}

type FeatureCollection = { type: "FeatureCollection"; features: { type: "Feature"; id?: unknown; geometry: unknown; properties?: Record<string, unknown> | null }[] };

// As text (parsed when loaded): TypeScript would otherwise type every coordinate.
const BUNDLED: Record<string, () => Promise<unknown>> = {
  [WORLD_MAP]: () => import("../geodata/worldLow.json?raw").then((m) => JSON.parse(m.default)),
  [EUROPE_MAP]: () => import("../geodata/europeLow.json?raw").then((m) => JSON.parse(m.default)),
};

function asFeatures(json: unknown): FeatureCollection {
  const c = json as Partial<FeatureCollection> | null;
  if (!c || c.type !== "FeatureCollection" || !Array.isArray(c.features)) throw new Error("This is not a map (GeoJSON regions).");
  return c as FeatureCollection;
}

/** Made into Carbon's TopoJSON: every region a geometry named by its key (quantized: a smaller, faster drawing). */
function prepare(collection: FeatureCollection): RegionMap {
  const regions = regionsOf(collection.features);
  const countries = {
    type: "FeatureCollection",
    features: regions.map((r) => ({ type: "Feature", geometry: collection.features[r.feature].geometry, properties: { NAME: r.key } })),
  };
  return { regions, topology: topology({ countries } as Parameters<typeof topology>[0], 1e5) };
}

const loaded = new Map<string, Promise<RegionMap>>();

/** A choropleth's map, loaded once per session: bundled, or its stored file (fetched from the sync server when this device has no copy). */
export function loadRegionMap(repo: Repository, regions: ChartRegions): Promise<RegionMap> {
  const key = regions.file ?? regions.map;
  let pending = loaded.get(key);
  if (!pending) {
    pending = (async () => {
      const bundled = BUNDLED[regions.map];
      if (bundled) return prepare(asFeatures(await bundled()));
      const id = regions.file ? fileIdFromSrc(regions.file) : null;
      const file = id ? await repo.getFile(id) : null;
      if (!file) throw new Error(`The map of ${mapLabel(regions.map)} isn't on this device yet: it is downloaded with the next sync.`);
      return prepare(asFeatures(JSON.parse(new TextDecoder().decode(file.data))));
    })();
    // A failure (offline, no copy yet) is tried again the next time.
    pending.catch(() => loaded.delete(key));
    loaded.set(key, pending);
  }
  return pending;
}

/** Downloads a country's map and stores it; returns the regions that show it. Throws a user-facing error. */
export async function downloadRegionMap(repo: Repository, map: string): Promise<ChartRegions> {
  let response: Response;
  try {
    response = await fetch(geodataUrl(map));
  } catch {
    throw new Error(`The map of ${mapLabel(map)} couldn't be downloaded: is this device online?`);
  }
  if (!response.ok) throw new Error(`The map of ${mapLabel(map)} couldn't be downloaded (${response.status}).`);
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength > MAX_FILE_BYTES) throw new Error(`The map of ${mapLabel(map)} is too large to store.`);
  asFeatures(JSON.parse(new TextDecoder().decode(data)));
  const fileId = await repo.putFile(data, "application/geo+json");
  return { map, file: fileSrc(fileId) };
}
