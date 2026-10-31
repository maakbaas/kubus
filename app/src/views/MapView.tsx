import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Checkbox, IconButton, Link, Select, SelectItem } from "@carbon/react";
import { CenterToFit, Earth, ZoomIn, ZoomOut } from "@carbon/icons-react";
import type { GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent } from "maplibre-gl";
import { itemPath } from "../domain/backlinks";
import type { Component } from "../domain/components";
import { isCoordinateField, isLocationTextField, locationOf, locationOfPair, type LngLat } from "../domain/geo";
import { useStore } from "../app/store";
import { fieldValue, isStruckThrough, itemLabel, pickableFields, type Collection, type FieldDef, type Item } from "../domain/model";
import { fieldText, isEmptyValue, isGrouped, type QueryResult } from "../domain/query";
import { BLOCK_HEIGHT, blockHeightCss, DEFAULT_ASPECT, normalizeAspect, normalizeBlockHeight, type AspectRatio } from "../domain/views";
import { Highlight } from "../ui/Highlight";
import { useMediaQuery } from "../ui/useMediaQuery";
import { openModeOf } from "../workspace/Workspace";
import { itemLinkProps } from "./cells";
import { refLabelOf } from "../ui/useReferenceOptions";
import { useBuffered } from "../ui/useBuffered";
import { AspectSelect, HeightSlider, InRowNote } from "./HeightSlider";
import { useMapStyle } from "../app/mapStyle";
import { loadMapLibre, styleUrl } from "./mapLibre";
import { defineBlockType, type BlockOptionsProps, type BlockProps } from "./registry";

// A block showing its items as dots on a vector map (MapLibre GL, OpenFreeMap's tiles). An item's
// place is read from its fields (domain/geo.ts): one text field with both coordinates, or two
// number fields (or components / AI fields giving a number). The block's grouping colours the dots (one colour per group, as a chart colours its
// series: Carbon Charts' palette for so many, with a legend); dots and route lines are drawn as a
// lollipop chart's dots and lines, so maps and charts look alike; hovering a dot shows the item's title and the
// block's fields (the pointer can move onto it, to its title's link), clicking it opens the item
// (Ctrl/Cmd: beside). On a touch screen the first tap shows the item, a tap on its title opens it.
// With Route on, a line joins the dots in the block's order (one per group, in its colour).

export interface MapOptions {
  /** The text field holding both coordinates, or (a number field) the latitude; null = none chosen. */
  locationFieldId: string | null;
  /** With a number field as location: the longitude's number field. */
  longitudeFieldId: string | null;
  /** The map's height in rem (BLOCK_HEIGHT, like a chart's and a component's). */
  height: number;
  /** With the height: the less of the two (domain/views.ts blockHeightCss). */
  aspect: AspectRatio;
  /** A line through the dots, in the block's order (a track, a trip): one per group. */
  route: boolean;
}

/**
 * Carbon Charts' colours for `count` groups, as a chart of that many series has them (its own stylesheet's
 * `--cds-charts-…` tokens, loaded with MapLibre: mapLibre.ts): the 1- to 5-colour palette, else the 14-colour
 * one, its first option, in order. Read for the theme from an element Carbon Charts would style.
 */
function chartPalette(el: HTMLElement, count: number, dark: boolean): string[] {
  const variants = count > 5 ? 14 : Math.max(count, 1);
  const holder = document.createElement("div");
  holder.className = "cds--chart-holder";
  holder.hidden = true;
  if (dark) holder.dataset.carbonTheme = "g100";
  el.appendChild(holder);
  const style = getComputedStyle(holder);
  const palette = Array.from({ length: Math.min(variants, 14) }, (_, i) => style.getPropertyValue(`--cds-charts-${variants}-1-${i + 1}`).trim());
  holder.remove();
  return palette;
}

const SOURCE = "kubus-items";
const LAYER = "kubus-dots";
/** Under each dot, a disc of the page's background: the route stops at a dot's edge, as a lollipop's line does. */
const UNDER_LAYER = "kubus-dots-under";
const ROUTE_SOURCE = "kubus-route";
const ROUTE_LAYER = "kubus-route";
/** How long a shown item stays after the pointer leaves its dot: time to move onto it. */
const HIDE_DELAY = 200;

/** Fields a location can be read from (Location), and those a longitude can (with a number latitude). */
const locationFields = (collection: Collection, components: Component[]) =>
  pickableFields(collection).filter((f) => isLocationTextField(f, components) || isCoordinateField(f, components));
const coordinateFields = (collection: Collection, components: Component[]) => pickableFields(collection).filter((f) => isCoordinateField(f, components));
/** Whether a stored field id may still be a location / a coordinate: a shared component's output isn't known where options are normalized, so a component field may be either (the map decides when it draws). */
const mayLocate = (f: FieldDef) => f.kind === "string" || f.kind === "number" || f.kind === "component" || f.kind === "ai";
const mayBeCoordinate = (f: FieldDef) => f.kind === "number" || f.kind === "component" || f.kind === "ai";

interface Place {
  item: Item;
  at: LngLat;
  color: string;
  /** Its group's key (a route per group). */
  group: string;
}

interface Legend {
  key: string;
  label: string;
  color: string;
}

/**
 * The items with a place, each once (in the first group it is in), coloured by group as a chart's series
 * are (`palette`: the colours for so many groups); and the legend.
 */
function placesOf(collection: Collection, components: Component[], result: QueryResult, options: MapOptions, palette: (count: number) => string[]) {
  const fields = pickableFields(collection);
  const location = fields.find((f) => f.id === options.locationFieldId);
  const pair = !!location && isCoordinateField(location, components);
  const longitude = pair ? fields.find((f) => f.id === options.longitudeFieldId) : undefined;
  const placeOf = (item: Item): LngLat | null => {
    if (!location) return null;
    if (pair) return longitude ? locationOfPair(fieldValue(item, location), fieldValue(item, longitude)) : null;
    return locationOf(fieldValue(item, location));
  };
  const grouped = isGrouped(result);
  const seen = new Set<string>();
  let missing = 0;
  // The groups with a place: the series a chart would have.
  const shown = result.groups.flatMap((group) => {
    const placed: { item: Item; at: LngLat }[] = [];
    for (const item of group.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const at = placeOf(item);
      if (at) placed.push({ item, at });
      else missing++;
    }
    return placed.length ? [{ group, placed }] : [];
  });
  const colors = palette(shown.length);
  const places: Place[] = [];
  const legend: Legend[] = [];
  shown.forEach(({ group, placed }, i) => {
    // None until Carbon Charts' stylesheet is in (the map isn't drawn before either).
    const color = colors[i % colors.length] ?? "";
    for (const p of placed) places.push({ ...p, color, group: group.key });
    if (grouped) legend.push({ key: group.key, label: group.label, color });
  });
  return { places, legend, missing, chosen: !!location && (!pair || !!longitude) };
}

/** The route: the places in order, a line per group. */
const routeJson = (places: Place[]): Parameters<GeoJSONSource["setData"]>[0] => {
  const lines = new Map<string, { color: string; coordinates: [number, number][] }>();
  for (const p of places) {
    const line = lines.get(p.group) ?? { color: p.color, coordinates: [] };
    line.coordinates.push([p.at.lng, p.at.lat]);
    lines.set(p.group, line);
  }
  return {
    type: "FeatureCollection",
    features: [...lines.values()]
      .filter((line) => line.coordinates.length > 1)
      .map(({ color, coordinates }) => ({ type: "Feature", properties: { color }, geometry: { type: "LineString", coordinates } })),
  };
};

const geoJson = (places: Place[]): Parameters<GeoJSONSource["setData"]>[0] => ({
  type: "FeatureCollection",
  features: places.map((p, i) => ({
    type: "Feature",
    id: i,
    properties: { color: p.color },
    geometry: { type: "Point", coordinates: [p.at.lng, p.at.lat] },
  })),
});

/** Fits the map to the places (one place: around it; none: the world). */
function fit(map: MapLibreMap, places: Place[], animate: boolean) {
  if (places.length === 0) return map.jumpTo({ center: [0, 20], zoom: 1 });
  if (places.length === 1) return map.jumpTo({ center: [places[0].at.lng, places[0].at.lat], zoom: 12 });
  let [west, south, east, north] = [180, 90, -180, -90];
  for (const { at } of places) {
    west = Math.min(west, at.lng);
    east = Math.max(east, at.lng);
    south = Math.min(south, at.lat);
    north = Math.max(north, at.lat);
  }
  map.fitBounds([west, south, east, north], { padding: 40, maxZoom: 14, animate });
}


export function MapView({ collection, result, fields, layout, options, refs, search, actions }: BlockProps<MapOptions>) {
  const dark = useMediaQuery("(prefers-color-scheme: dark)");
  // One style for every map (Settings → Maps).
  const mapStyle = useMapStyle();
  const touch = useMediaQuery("(hover: none)");
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  // The dots' colours are Carbon Charts' (its stylesheet comes with MapLibre), for the theme.
  const [stylesIn, setStylesIn] = useState(false);
  useEffect(() => {
    loadMapLibre().then(() => setStylesIn(true), () => {});
  }, []);
  const palette = useMemo(() => {
    const el = box.current;
    const cache = new Map<number, string[]>();
    return (count: number) => {
      if (!cache.has(count)) cache.set(count, el && stylesIn ? chartPalette(el, count, dark) : []);
      return cache.get(count)!;
    };
  }, [dark, stylesIn]);

  const { components } = useStore();
  const { places, legend, missing, chosen } = useMemo(
    () => placesOf(collection, components, result, options, palette),
    [collection, components, result, options, palette],
  );
  // What a chart's dots sit on: the page's background (a theme token, read: the map can't read CSS variables).
  const under = useMemo(() => (box.current ? getComputedStyle(box.current).getPropertyValue("--cds-background").trim() : "") || (dark ? "#161616" : "#ffffff"), [dark]);

  // No fields chosen (the block's Fields): no tooltip; a dot is still pointed at, and clicked (or tapped) opens its item.
  const tips = fields.length > 0;
  // The latest places, for the map's own handlers (set up once).
  const latest = useRef({ places, route: options.route, under, tips });
  latest.current = { places, route: options.route, under, tips };

  /** The dot shown with its item (hovered, or tapped on a touch screen), and where on the map it is. */
  const [shownDot, setShownDot] = useState<{ index: number; pinned: boolean } | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const shownRef = useRef(shownDot);
  shownRef.current = shownDot;
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const touchRef = useRef(touch);
  touchRef.current = touch;
  // A hovered dot's item hides a moment after the pointer leaves the dot, unless it moved onto the item.
  const hideTimer = useRef(0);
  const keepShown = () => window.clearTimeout(hideTimer.current);
  const hideSoon = () => {
    keepShown();
    hideTimer.current = window.setTimeout(() => {
      if (!shownRef.current?.pinned) setShownDot(null);
    }, HIDE_DELAY);
  };
  const hideSoonRef = useRef(hideSoon);
  hideSoonRef.current = hideSoon;
  useEffect(() => keepShown, []);

  // The map, made once. Our dots are a GeoJSON source and a circle layer, added again whenever the
  // style is (re)loaded (a style change replaces every source and layer).
  useEffect(() => {
    let map: MapLibreMap | null = null;
    let gone = false;
    loadMapLibre().then(
      (lib) => {
        if (gone || !canvas.current) return;
        map = new lib.Map({
          container: canvas.current,
          style: styleUrl(mapStyle, dark),
          center: [0, 20],
          zoom: 1,
          // No attribution box on the map (asked for: it covered the map's corner).
          attributionControl: false,
          // Like any map: the wheel zooms, one finger moves it (no Ctrl + wheel or two-finger gate).
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
        });
        map.touchZoomRotate.disableRotation();
        mapRef.current = map;
        const m = map;
        m.on("style.load", () => {
          // The route under the dots.
          m.addSource(ROUTE_SOURCE, { type: "geojson", data: latest.current.route ? routeJson(latest.current.places) : routeJson([]) });
          m.addLayer({
            id: ROUTE_LAYER,
            type: "line",
            source: ROUTE_SOURCE,
            layout: { "line-join": "round", "line-cap": "round" },
            // As a lollipop chart's lines (Carbon Charts).
            paint: { "line-color": ["get", "color"], "line-width": 1 },
          });
          m.addSource(SOURCE, { type: "geojson", data: geoJson(latest.current.places) });
          m.addLayer({
            id: UNDER_LAYER,
            type: "circle",
            source: SOURCE,
            paint: { "circle-color": latest.current.under, "circle-radius": 4 },
          });
          m.addLayer({
            id: LAYER,
            type: "circle",
            source: SOURCE,
            paint: {
              // As a lollipop chart's dots (Carbon Charts): its colour at 30%, outlined, filled when hovered.
              "circle-color": ["get", "color"],
              "circle-radius": 4,
              "circle-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 1, 0.3],
              "circle-stroke-width": 1.5,
              "circle-stroke-color": ["get", "color"],
            },
          });
          setReady(true);
        });
        let hovered: number | null = null;
        const hover = (index: number | null) => {
          if (hovered !== null) m.setFeatureState({ source: SOURCE, id: hovered }, { hover: false });
          hovered = index;
          if (index !== null) m.setFeatureState({ source: SOURCE, id: index }, { hover: true });
        };
        m.on("mousemove", LAYER, (e: MapLayerMouseEvent) => {
          const index = e.features?.[0]?.id;
          if (typeof index !== "number" || touchRef.current) return;
          m.getCanvas().style.cursor = "pointer";
          hover(index);
          window.clearTimeout(hideTimer.current);
          if (latest.current.tips && !shownRef.current?.pinned) setShownDot({ index, pinned: false });
        });
        m.on("mouseleave", LAYER, () => {
          m.getCanvas().style.cursor = "";
          hover(null);
          hideSoonRef.current();
        });
        m.on("click", (e) => {
          const index = m.queryRenderedFeatures(e.point, { layers: [LAYER] })[0]?.id;
          if (typeof index !== "number") return setShownDot(null);
          const place = latest.current.places[index];
          if (!place) return;
          // A touch screen has no hover: the first tap shows the item, its title opens it.
          if (touchRef.current && latest.current.tips && shownRef.current?.index !== index) return setShownDot({ index, pinned: true });
          actionsRef.current.open(place.item, openModeOf(e.originalEvent));
        });
        m.on("dragstart", () => {
          if (!shownRef.current?.pinned) setShownDot(null);
        });
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
    // Made once; the style and data follow below.
  }, []);

  // The style follows the setting and the theme.
  const style = styleUrl(mapStyle, dark);
  const shownStyle = useRef(style);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || shownStyle.current === style) return;
    shownStyle.current = style;
    setReady(false);
    map.setStyle(style);
  }, [style, ready]);

  // The dots follow the items; the map fits them when which items are shown changes (not when one
  // of them is edited, so it doesn't jump away from where it was moved to).
  const ids = useMemo(() => places.map((p) => p.item.id).join(","), [places]);
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource(SOURCE) as GeoJSONSource | undefined)?.setData(geoJson(places));
    (map.getSource(ROUTE_SOURCE) as GeoJSONSource | undefined)?.setData(routeJson(options.route ? places : []));
    if (map.getLayer(UNDER_LAYER)) map.setPaintProperty(UNDER_LAYER, "circle-color", under);
    if (fitted.current !== ids) {
      fit(map, places, fitted.current !== null);
      fitted.current = ids;
    }
    setShownDot((d) => (d && tips && d.index < places.length ? d : null));
  }, [places, ids, ready, options.route, under, tips]);

  // The shown dot's place on the map, kept while the map moves.
  const shownPlace = shownDot ? places[shownDot.index] : undefined;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !shownPlace) return setAnchor(null);
    const place = () => {
      const p = map.project([shownPlace.at.lng, shownPlace.at.lat]);
      setAnchor({ x: p.x, y: p.y });
    };
    place();
    map.on("move", place);
    return () => {
      map.off("move", place);
    };
  }, [shownPlace]);

  const shownFields = layout.hideEmpty && shownPlace ? fields.filter((f) => !isEmptyValue(fieldValue(shownPlace.item, f))) : fields;
  const zoom = (by: number) => mapRef.current?.easeTo({ zoom: mapRef.current.getZoom() + by });
  const ctx = useMemo(() => ({ refLabel: refLabelOf(refs, "(deleted)") }), [refs]);

  // The shown item's tooltip beside its dot, as a chart's is beside the pointer: on the right, else on the left,
  // past the map's edges but within its pane (the map's box doesn't clip it).
  const tip = useRef<HTMLDivElement>(null);
  const [tipAt, setTipAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = tip.current;
    const mapEl = el?.closest(".map-block__map");
    if (!el || !mapEl || !anchor) return setTipAt(null);
    const map = mapEl.getBoundingClientRect();
    const pane = mapEl.closest(".ws-pane__body")?.getBoundingClientRect() ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    const { width, height } = el.getBoundingClientRect();
    const gap = 12;
    const x = map.left + anchor.x;
    const left = Math.max(pane.left, Math.min(x + gap + width <= pane.right ? x + gap : x - gap - width, pane.right - width));
    const top = Math.max(pane.top, Math.min(map.top + anchor.y - height / 2, pane.bottom - height));
    setTipAt({ left: left - map.left, top: top - map.top });
  }, [anchor, shownPlace]);

  return (
    <div ref={box} className="map-block">
      <div
        className="map-block__map"
        style={{ "--map-height": blockHeightCss(options.height, options.aspect) } as CSSProperties}
        onKeyDown={(e) => {
          if (e.key === "Escape" && shownDot) setShownDot(null);
        }}
      >
        <div ref={canvas} className="map-block__canvas" />
        {failed && <p className="helper map-block__message">The map couldn't be loaded.</p>}
        {!failed && !chosen && <p className="helper map-block__message">Choose the field with the location in Block settings.</p>}
        <div className="map-block__controls">
          <IconButton kind="secondary" size="sm" label="Zoom in" align="left" autoAlign onClick={() => zoom(1)}>
            <ZoomIn />
          </IconButton>
          <IconButton kind="secondary" size="sm" label="Zoom out" align="left" autoAlign onClick={() => zoom(-1)}>
            <ZoomOut />
          </IconButton>
          {/* Only with more than one place to fit. */}
          {places.length > 1 && (
            <IconButton
              kind="secondary"
              size="sm"
              label={`Show all ${collection.pluralName}`}
              align="left"
              autoAlign
              onClick={() => mapRef.current && fit(mapRef.current, places, true)}
            >
              <CenterToFit />
            </IconButton>
          )}
        </div>
        {/* Carbon Charts' own tooltip (a chart's datapoint tooltip: the item's title in its dot's colour, then
            its fields), in a chart holder for its fonts and colours. */}
        {shownPlace && anchor && (
          <div className="cds--chart-holder map-block__tip-layer" data-carbon-theme={dark ? "g100" : undefined}>
            <div
              ref={tip}
              className="cds--cc--tooltip map-block__tooltip"
              style={tipAt ? { left: tipAt.left, top: tipAt.top } : { visibility: "hidden" }}
              onMouseEnter={keepShown}
              onMouseLeave={() => hideSoon()}
            >
              <div className="content-box">
                <ul className="multi-tooltip">
                  <li>
                    <div className="datapoint-tooltip bold">
                      <div className="tooltip-color" style={{ backgroundColor: shownPlace.color }} />
                      <div className="label">
                        <p title={itemLabel(collection, shownPlace.item)}>
                          <Link
                            href={`#${itemPath(collection, shownPlace.item)}`}
                            {...itemLinkProps(shownPlace.item, actions)}
                            className={isStruckThrough(collection, shownPlace.item) ? "map-block__title item--struck" : "map-block__title"}
                          >
                            <Highlight text={itemLabel(collection, shownPlace.item)} query={search} />
                          </Link>
                        </p>
                      </div>
                    </div>
                  </li>
                  {shownFields.map((f: FieldDef) => {
                    const text = fieldText(f, shownPlace.item, ctx);
                    const labelled = !layout.hiddenLabels.includes(f.id);
                    return (
                      <li key={f.id}>
                        <div className="datapoint-tooltip">
                          <div className="label">
                            <p title={labelled ? f.name : text}>{labelled ? f.name : text}</p>
                          </div>
                          {labelled && (
                            <p className="value" title={text}>
                              {text}
                            </p>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          </div>
        )}
      </div>
      {(legend.length > 0 || (chosen && missing > 0)) && (
        <div className="map-block__legend">
          {legend.map((g) => (
            <span key={g.key} className="map-block__legend-entry">
              <span className="map-block__swatch" style={{ background: g.color }} />
              <Highlight text={g.label} query="" />
            </span>
          ))}
          {chosen && missing > 0 && (
            <span className="helper">
              {missing} without a location
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function MapOptionsEditor({ collection, options, inRow, onChange }: BlockOptionsProps<MapOptions>) {
  // Element ids unique per instance: the same page can be open in several tabs.
  const uid = useId();
  // Stored after a pause, not at every step of a drag: each store is a write, a sync change and a redraw (a map's
  // canvas resized each time, which could crash the page).
  const [height, setHeight] = useBuffered(options.height, (h) => onChange({ ...options, height: h }));
  const { components } = useStore();
  const location = collection.fields.find((f) => f.id === options.locationFieldId);
  const pair = !!location && isCoordinateField(location, components);
  return (
    <div className="view-options">
      <Select
        size="sm"
        id={`${uid}-map-location`}
        labelText={pair ? "Latitude" : "Location"}
        helperText={pair ? undefined : "Text with both coordinates (“52.37, 4.89”, a map link), or a number field (or component / AI field giving a number) with the latitude."}
        value={options.locationFieldId ?? ""}
        onChange={(e) => onChange({ ...options, locationFieldId: e.target.value || null })}
      >
        <SelectItem value="" text="None" />
        {locationFields(collection, components).map((f) => (
          <SelectItem key={f.id} value={f.id} text={f.name} />
        ))}
      </Select>
      {pair && (
        <Select
          size="sm"
          id={`${uid}-map-longitude`}
          labelText="Longitude"
          value={options.longitudeFieldId ?? ""}
          onChange={(e) => onChange({ ...options, longitudeFieldId: e.target.value || null })}
        >
          <SelectItem value="" text="None" />
          {coordinateFields(collection, components)
            .filter((f) => f.id !== options.locationFieldId)
            .map((f) => (
              <SelectItem key={f.id} value={f.id} text={f.name} />
            ))}
        </Select>
      )}
      <HeightSlider id={`${uid}-map-height`} value={height} onChange={setHeight} />
      <AspectSelect id={`${uid}-map-aspect`} value={options.aspect} onChange={(aspect) => onChange({ ...options, aspect })} />
      {inRow && <InRowNote />}
      <Checkbox
        id={`${uid}-map-route`}
        labelText="Show as route"
        checked={options.route}
        onChange={(_, { checked }) => onChange({ ...options, route: checked })}
      />
    </div>
  );
}

const NAMED = { location: /locat|coord|place|position|geo/i, lat: /^lat/i, lng: /^(lng|lon)/i };

/**
 * A first guess at the location: two number fields named latitude / longitude, else a text field named like a location.
 * Shared components aren't known here: a field's own component and an AI field count by their output.
 */
function guessLocation(collection: Collection): Pick<MapOptions, "locationFieldId" | "longitudeFieldId"> {
  const numbers = coordinateFields(collection, []);
  const lat = numbers.find((f) => NAMED.lat.test(f.name));
  const lng = numbers.find((f) => NAMED.lng.test(f.name));
  if (lat && lng) return { locationFieldId: lat.id, longitudeFieldId: lng.id };
  const text = pickableFields(collection).find((f) => isLocationTextField(f, []) && NAMED.location.test(f.name));
  return { locationFieldId: text?.id ?? null, longitudeFieldId: null };
}

export const mapView = defineBlockType<MapOptions>({
  kind: "map",
  label: "Map",
  icon: Earth,
  defaultOptions: (collection) => ({ ...guessLocation(collection), height: BLOCK_HEIGHT.initial, aspect: DEFAULT_ASPECT, route: false }),
  uses: (options) => ({ query: true, groups: true, fields: { labels: true, hideEmpty: true }, ownHeight: { height: options.height, aspect: options.aspect } }),
  normalizeOptions(raw, collection) {
    const o = (raw ?? {}) as Partial<MapOptions>;
    const fields = pickableFields(collection);
    const location = fields.find((f) => f.id === o.locationFieldId && mayLocate(f));
    const longitude = location && mayBeCoordinate(location) ? fields.find((f) => f.id === o.longitudeFieldId && mayBeCoordinate(f)) : undefined;
    return {
      locationFieldId: location?.id ?? null,
      longitudeFieldId: longitude?.id ?? null,
      height: normalizeBlockHeight(o.height),
      aspect: normalizeAspect(o.aspect),
      route: o.route === true,
    };
  },
  View: MapView,
  OptionsEditor: MapOptionsEditor,
});
