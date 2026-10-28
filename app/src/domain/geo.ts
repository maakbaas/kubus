// Places on a map (the Map block, views/MapView.tsx): an item's location is read from its fields,
// never stored in a field kind of its own. Either one text field (or a component giving text) holds
// both coordinates, as typed or pasted ("52.37, 4.89", "geo:52.37,4.89", a map link with "@lat,lon"
// or "q=lat,lon" in it), or two number fields hold the latitude and the longitude.

import type { FieldDef, FieldValue } from "./model";

export interface LngLat {
  lat: number;
  lng: number;
}

const NUMBER = String.raw`[-+]?\d{1,3}(?:\.\d+)?`;
/** Two numbers: by a comma (with or without spaces), or by spaces alone. */
const PAIR = new RegExp(String.raw`^(${NUMBER})\s*(?:,|\s)\s*(${NUMBER})$`);
/** A pair inside a map link: after "@" (Google Maps), or a "q", "ll", "query" or "center" parameter. */
const IN_LINK = new RegExp(String.raw`(?:@|[?&](?:q|ll|query|center)=)(${NUMBER})(?:,|%2C)\s*(${NUMBER})`, "i");

/** A latitude and longitude if both are in range; null otherwise. */
export function lngLat(lat: number, lng: number): LngLat | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** The place a text names ("lat, lon", "geo:lat,lon", a map link); null if none. */
export function parseLocation(text: string): LngLat | null {
  const t = text.trim().replace(/^geo:/i, "").replace(/[;?].*$/, "");
  const pair = PAIR.exec(t) ?? IN_LINK.exec(text);
  return pair ? lngLat(Number(pair[1]), Number(pair[2])) : null;
}

/** The place in a field's value: a text with both coordinates; null if none. */
export const locationOf = (value: FieldValue): LngLat | null => (typeof value === "string" ? parseLocation(value) : null);

/** The place in two number values (latitude, longitude); null if either is missing. */
export const locationOfPair = (lat: FieldValue, lng: FieldValue): LngLat | null =>
  typeof lat === "number" && typeof lng === "number" ? lngLat(lat, lng) : null;

/** Fields that can hold a whole location as text (strings, and components giving text). */
export const isLocationTextField = (field: FieldDef) => field.kind === "string" || field.kind === "component" || field.kind === "ai";
/** Fields that can hold a latitude or a longitude (with the other in a second field). */
export const isCoordinateField = (field: FieldDef) => field.kind === "number";
