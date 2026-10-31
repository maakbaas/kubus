// MapLibre GL (the Map block's vector map), loaded on demand: it is large, and only a page with a
// map needs it. Its worker is bundled like the rest of the app (Vite's `?worker&url`), so the map
// code works offline; the map itself (style, tiles, label fonts) comes from OpenFreeMap.

import type { MapStyleId } from "../../../shared/settings";

type MapLibre = typeof import("maplibre-gl");

let loading: Promise<MapLibre> | null = null;

export function loadMapLibre(): Promise<MapLibre> {
  loading ??= Promise.all([
    import("maplibre-gl"),
    import("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"),
    import("maplibre-gl/dist/maplibre-gl.css"),
    // A map's dots and routes are coloured as a chart's series (MapView's chartPalette reads its tokens).
    import("@carbon/charts-react/styles.css"),
  ]).then(
    ([lib, worker]) => {
      lib.setWorkerUrl(worker.default);
      return lib;
    },
    (e) => {
      loading = null; // not cached, so a later map retries
      throw e;
    },
  );
  return loading;
}

/** OpenFreeMap's styles (https://openfreemap.org): free, no key, OpenStreetMap data. */
const STYLE_BASE = "https://tiles.openfreemap.org/styles/";

/** One style for every map (Settings → Display, app/settings.ts). */
export type MapStyle = MapStyleId;
export const MAP_STYLES: { value: MapStyle; text: string }[] = [
  { value: "auto", text: "Automatic" },
  { value: "positron", text: "Light" },
  { value: "dark", text: "Dark" },
  { value: "liberty", text: "Liberty" },
  { value: "bright", text: "Bright" },
];

/** The style's URL; "auto" follows the theme with the quiet styles, so the dots stand out. */
export const styleUrl = (style: MapStyle, dark: boolean) => STYLE_BASE + (style === "auto" ? (dark ? "dark" : "positron") : style);
