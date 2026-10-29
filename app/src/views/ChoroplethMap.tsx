import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { IconButton } from "@carbon/react";
import { CenterToFit, ZoomIn, ZoomOut } from "@carbon/icons-react";
import { scaleLinear, scaleQuantize } from "d3-scale";
import type { GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent, StyleSpecification } from "maplibre-gl";
import { formatValue, type ChartOptions } from "../domain/chart";
import { WORLD_MAP } from "../domain/regions";
import { blockHeightCss } from "../domain/views";
import { loadMapLibre } from "./mapLibre";
import { wholeMap, type RegionMap } from "./regionMaps";

// A choropleth drawn with MapLibre GL instead of Carbon Charts (the A/B candidate: ChartBlock picks one), in
// Carbon's choropleth's look: its colour scale and tokens (a value range from 0, made nice, in 11 steps of
// --cds-charts-mono-1-n, 17 of the diverging palette when it runs from below 0 to above), its region borders,
// its linear colour legend and its tooltip. Unlike Carbon's, a region without a value is drawn on its own
// (its border kept) in the page's background, not merged with the others under hatching; the whole map is
// always shown. No tiles or labels: the map is its regions on the page's background, so it works offline.

const SOURCE = "kubus-regions";
const FILL = "kubus-region-fill";
const LINE = "kubus-region-line";

/** Carbon's colour scale for a choropleth's values (color-scale-utils.ts getDomain / getColorScale). */
export function carbonColorScale(values: number[]) {
  const [lo, hi] = values.length ? [Math.min(...values), Math.max(...values)] : [0, 1];
  const domain = scaleLinear().domain([lo, hi]).nice().domain();
  if (domain[0] > 0) domain[0] = 0;
  else if (domain[0] === 0 && domain[1] === 0) domain[1] = 1;
  if (domain[0] < 0 && domain[1] > 0) {
    if (Math.abs(domain[0]) > domain[1]) domain[1] = Math.abs(domain[0]);
    else domain[0] = -domain[1];
  }
  const scheme = domain[0] < 0 && domain[1] > 0 ? "diverge" : "mono";
  const steps = scheme === "diverge" ? 17 : 11;
  const step = scaleQuantize<number>().domain(domain as [number, number]).range(Array.from({ length: steps }, (_, i) => i + 1));
  return { domain: domain as [number, number], scheme, steps, step };
}

/** The theme's values of Carbon Charts' tokens (MapLibre can't read CSS variables), read from an element Carbon Charts styles. */
function chartTokens(el: HTMLElement, dark: boolean, names: string[]): string[] {
  const holder = document.createElement("div");
  holder.className = "cds--chart-holder";
  holder.hidden = true;
  if (dark) holder.dataset.carbonTheme = "g100";
  el.appendChild(holder);
  const style = getComputedStyle(holder);
  const values = names.map((n) => style.getPropertyValue(n).trim());
  holder.remove();
  return values;
}

type Ring = [number, number][];
/**
 * A ring made continuous around the map's centre: where amCharts' outline jumps across 180° (Russia, Fiji) the
 * longitudes go on past it, so MapLibre draws the shape whole (d3 cuts it at 180°; MapLibre drew the jump as a
 * line across the map).
 */
function unwrap(ring: Ring, centre: number): Ring {
  if (ring.length === 0) return ring;
  let lng = ((((ring[0][0] - centre) % 360) + 540) % 360) - 180 + centre;
  return ring.map(([x, y], i) => {
    if (i > 0) {
      let d = x - ring[i - 1][0];
      d -= 360 * Math.round(d / 360);
      lng += d;
    }
    return [lng, y];
  });
}
function unwrapGeometry(g: { type: string; coordinates: unknown } | null, centre: number) {
  if (!g) return g;
  if (g.type === "Polygon") return { ...g, coordinates: (g.coordinates as Ring[]).map((r) => unwrap(r, centre)) };
  if (g.type === "MultiPolygon") return { ...g, coordinates: (g.coordinates as Ring[][]).map((p) => p.map((r) => unwrap(r, centre))) };
  return g;
}

/** The legend's height under the map (Carbon's colour legend is inside the chart's height). */
const LEGEND_HEIGHT = "2.5rem";

/** A shown region's tooltip: its name, its value and where (in the map's box). */
interface Tip {
  name: string;
  value: number;
  x: number;
  y: number;
}

export function ChoroplethMap({ map: regionMap, values, options, label, dark }: { map: RegionMap; values: Map<string, number>; options: ChartOptions; label: string; dark: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [stylesIn, setStylesIn] = useState(false);
  const [tip, setTip] = useState<Tip | null>(null);

  const world = options.regions.map === WORLD_MAP;
  const whole = useMemo(() => wholeMap(regionMap.topology), [regionMap]);
  // As Carbon: 0 is no value (ChoroplethModel: `value || null`).
  const shown = useMemo(() => [...values.values()].filter((v) => v !== 0), [values]);
  const scale = useMemo(() => carbonColorScale(shown), [shown]);

  useEffect(() => {
    loadMapLibre().then(() => setStylesIn(true), () => {});
  }, []);
  const colors = useMemo(() => {
    const el = box.current;
    if (!el || !stylesIn) return null;
    const names = Array.from({ length: scale.steps }, (_, i) => `--cds-charts-${scale.scheme}-1-${i + 1}`);
    const fills = chartTokens(el, dark, names);
    const hovered = chartTokens(el, dark, names.map((n) => `${n}-hovered`));
    const page = getComputedStyle(el);
    return {
      fills,
      hovered,
      background: page.getPropertyValue("--cds-background").trim() || (dark ? "#161616" : "#ffffff"),
      border: page.getPropertyValue("--cds-border-subtle-selected-01").trim() || (dark ? "#525252" : "#c6c6c6"),
    };
  }, [stylesIn, dark, scale]);

  // The regions as GeoJSON, each with its fill (and hovered fill), by its value's step; no value: the background.
  const data = useMemo(() => {
    if (!colors) return null;
    const features = ("features" in whole.regions ? whole.regions.features : []).map((f, id) => {
      const name = String((f.properties as { NAME?: unknown } | null)?.NAME ?? "");
      const value = values.get(name);
      const step = value ? scale.step(value) : 0;
      return {
        ...f,
        geometry: unwrapGeometry(f.geometry as { type: string; coordinates: unknown } | null, whole.centre) as GeoJSON.Geometry,
        id,
        properties: {
          name,
          value: value || null,
          fill: step ? colors.fills[step - 1] : colors.background,
          hover: step ? colors.hovered[step - 1] : colors.background,
        },
      };
    });
    return { type: "FeatureCollection" as const, features };
  }, [whole, values, scale, colors]);

  /** The whole map in view: its regions' bounds, around its centre (a map across 180° whole); the world without most of Antarctica, as Mercator would make it huge. */
  const bounds = useMemo((): [number, number, number, number] => {
    let [west, south, east, north] = [Infinity, Infinity, -Infinity, -Infinity];
    const visit = (c: unknown) => {
      if (!Array.isArray(c)) return;
      if (typeof c[0] === "number") {
        const lng = ((((c[0] as number) - whole.centre + 540) % 360) - 180) + whole.centre;
        west = Math.min(west, lng);
        east = Math.max(east, lng);
        south = Math.min(south, c[1] as number);
        north = Math.max(north, c[1] as number);
      } else c.forEach(visit);
    };
    for (const f of "features" in whole.regions ? whole.regions.features : []) visit((f.geometry as { coordinates?: unknown } | null)?.coordinates);
    if (!Number.isFinite(west)) return [-180, -60, 180, 85];
    return [west, world ? Math.max(south, -58) : south, east, Math.min(north, 85)];
  }, [whole, world]);
  /**
   * The map's own shape (width / height in Mercator): its canvas is no wider than that, centred, as Carbon centres
   * its drawing. MapLibre showing one world (renderWorldCopies off) zooms out no further than the world filling the
   * canvas's width, so a world in a wide block stayed cropped top and bottom.
   */
  const aspect = useMemo(() => {
    const y = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const [west, south, east, north] = bounds;
    return ((east - west) * Math.PI) / 180 / Math.max(1e-6, y(north) - y(south));
  }, [bounds]);
  const fitAll = (animate: boolean) => {
    moved.current = false;
    mapRef.current?.fitBounds(bounds, { padding: 8, animate });
  };

  const latest = useRef({ data, colors, bounds });
  latest.current = { data, colors, bounds };
  /** Moved or zoomed by the user: no longer refitted when its box resizes. */
  const moved = useRef(false);

  // The map, made once: a background, the regions' fills and their borders.
  useEffect(() => {
    let map: MapLibreMap | null = null;
    let gone = false;
    loadMapLibre().then(
      (lib) => {
        if (gone || !canvas.current) return;
        const style: StyleSpecification = { version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "rgba(0,0,0,0)" } }] };
        map = new lib.Map({
          container: canvas.current,
          style,
          bounds: latest.current.bounds,
          fitBoundsOptions: { padding: 8 },
          attributionControl: false,
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
          // One world: a region map is not a strip of copies (a map across 180° wraps into the next copy, so it keeps them).
          renderWorldCopies: !world,
        });
        map.touchZoomRotate.disableRotation();
        mapRef.current = map;
        const m = map;
        m.on("load", () => {
          m.addSource(SOURCE, { type: "geojson", data: latest.current.data ?? { type: "FeatureCollection", features: [] } });
          m.addLayer({
            id: FILL,
            type: "fill",
            source: SOURCE,
            paint: { "fill-color": ["case", ["boolean", ["feature-state", "hover"], false], ["get", "hover"], ["get", "fill"]] },
          });
          m.addLayer({ id: LINE, type: "line", source: SOURCE, paint: { "line-color": latest.current.colors?.border ?? "#c6c6c6", "line-width": 1 } });
          setReady(true);
        });
        let hovered: number | null = null;
        const hover = (id: number | null) => {
          if (hovered !== null) m.setFeatureState({ source: SOURCE, id: hovered }, { hover: false });
          hovered = id;
          if (id !== null) m.setFeatureState({ source: SOURCE, id }, { hover: true });
        };
        m.on("mousemove", FILL, (e: MapLayerMouseEvent) => {
          const f = e.features?.[0];
          const value = f?.properties?.value;
          // As Carbon: only a region with a value is pointed at.
          if (!f || typeof f.id !== "number" || typeof value !== "number") {
            hover(null);
            m.getCanvas().style.cursor = "";
            return setTip(null);
          }
          hover(f.id);
          setTip({ name: String(f.properties.name), value, x: e.point.x, y: e.point.y });
        });
        m.on("mouseleave", FILL, () => {
          hover(null);
          setTip(null);
        });
        // Shown whole at every size (the box may get its height after the map is made) until moved by hand.
        m.on("resize", () => {
          if (!moved.current) m.fitBounds(latest.current.bounds, { padding: 8, animate: false });
        });
        const byHand = (e: { originalEvent?: unknown }) => {
          if (e.originalEvent) moved.current = true;
        };
        m.on("dragstart", byHand);
        m.on("zoomstart", byHand);
        m.on("error", (e) => console.warn("Map:", e.error?.message ?? e));
      },
      (e) => {
        console.error("Loading the map failed", e);
        if (!gone) setFailed(true);
      },
    );
    return () => {
      gone = true;
      map?.remove();
      mapRef.current = null;
      setReady(false);
    };
    // Made once; the regions, colours and bounds follow below.
  }, [world]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !data || !colors) return;
    (map.getSource(SOURCE) as GeoJSONSource | undefined)?.setData(data);
    map.setPaintProperty(LINE, "line-color", colors.border);
  }, [data, colors, ready]);
  // A new map (other regions) is shown whole.
  useEffect(() => {
    if (ready) fitAll(false);
  }, [bounds, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const zoom = (by: number) => {
    moved.current = true;
    mapRef.current?.easeTo({ zoom: mapRef.current.getZoom() + by });
  };
  const fmt = (n: number) => formatValue(n, options);
  const [lo, hi] = scale.domain;
  const gradient = colors ? `linear-gradient(to right, ${colors.fills.join(", ")})` : undefined;

  return (
    <div ref={box} className="choropleth-map">
      <div className="map-block__map" style={{ "--map-height": `calc(${blockHeightCss(options.height, options.aspect)} - ${LEGEND_HEIGHT})` } as CSSProperties}>
        <div ref={canvas} className="map-block__canvas choropleth-map__canvas" style={{ "--map-aspect": String(aspect) } as CSSProperties} />
        {failed && <p className="helper map-block__message">The map couldn't be loaded.</p>}
        <div className="map-block__controls">
          <IconButton kind="secondary" size="sm" label="Zoom in" align="left" autoAlign onClick={() => zoom(1)}>
            <ZoomIn />
          </IconButton>
          <IconButton kind="secondary" size="sm" label="Zoom out" align="left" autoAlign onClick={() => zoom(-1)}>
            <ZoomOut />
          </IconButton>
          <IconButton kind="secondary" size="sm" label="Show the whole map" align="left" autoAlign onClick={() => fitAll(true)}>
            <CenterToFit />
          </IconButton>
        </div>
        {/* Carbon Charts' own tooltip (a choropleth's: the region's name and value), in a chart holder for its fonts and colours. */}
        {tip && (
          <div className="cds--chart-holder map-block__tip-layer" data-carbon-theme={dark ? "g100" : undefined}>
            <div className="cds--cc--tooltip map-block__tooltip" style={{ left: tip.x + 12, top: tip.y - 16 }}>
              <div className="content-box">
                <ul className="multi-tooltip">
                  <li>
                    <div className="datapoint-tooltip">
                      <div className="label">
                        <p title={tip.name}>{tip.name}</p>
                      </div>
                      <p className="value">{fmt(tip.value)}</p>
                    </div>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        )}
      </div>
      {/* Carbon's linear colour legend: the steps' colours, the range's ends and middle. */}
      <div className="choropleth-map__legend" title={label}>
        <div className="choropleth-map__gradient" style={{ background: gradient }} />
        <div className="choropleth-map__ticks">
          <span>{fmt(lo)}</span>
          <span>{fmt((lo + hi) / 2)}</span>
          <span>{fmt(hi)}</span>
        </div>
      </div>
    </div>
  );
}
