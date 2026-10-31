import { describe, expect, it } from "vitest";
import { isCoordinateField, isLocationTextField, locationOf, locationOfPair, parseLocation } from "./geo";
import { blankField } from "./model";
import type { Component } from "./components";

describe("parseLocation", () => {
  it("reads two numbers as latitude and longitude", () => {
    expect(parseLocation("52.3702, 4.8952")).toEqual({ lat: 52.3702, lng: 4.8952 });
    expect(parseLocation("52.3702,4.8952")).toEqual({ lat: 52.3702, lng: 4.8952 });
    expect(parseLocation(" -33.86  151.21 ")).toEqual({ lat: -33.86, lng: 151.21 });
    expect(parseLocation("+40,-74")).toEqual({ lat: 40, lng: -74 });
  });

  it("reads geo: URIs and map links", () => {
    expect(parseLocation("geo:52.37,4.89")).toEqual({ lat: 52.37, lng: 4.89 });
    expect(parseLocation("geo:52.37,4.89;u=35")).toEqual({ lat: 52.37, lng: 4.89 });
    expect(parseLocation("https://www.google.com/maps/place/Dam/@52.3731,4.8926,17z")).toEqual({ lat: 52.3731, lng: 4.8926 });
    expect(parseLocation("https://maps.google.com/?q=48.8584,2.2945")).toEqual({ lat: 48.8584, lng: 2.2945 });
    expect(parseLocation("https://maps.apple.com/?ll=48.8584%2C2.2945")).toEqual({ lat: 48.8584, lng: 2.2945 });
  });

  it("rejects what isn't a place", () => {
    for (const text of ["", "Amsterdam", "52.37", "91, 4", "52, 181", "1, 2, 3", "12abc, 4"]) {
      expect(parseLocation(text)).toBeNull();
    }
  });
});

describe("locations from values", () => {
  it("takes text, or two numbers", () => {
    expect(locationOf("1, 2")).toEqual({ lat: 1, lng: 2 });
    expect(locationOf(12)).toBeNull();
    expect(locationOf(null)).toBeNull();
    expect(locationOfPair(1, 2)).toEqual({ lat: 1, lng: 2 });
    expect(locationOfPair(1, null)).toBeNull();
    expect(locationOfPair(100, 2)).toBeNull();
    expect(locationOfPair("52.5", " 4.9 ")).toEqual({ lat: 52.5, lng: 4.9 });
    expect(locationOfPair("north", 2)).toBeNull();
  });
});

describe("coordinate fields", () => {
  const shared = [{ id: "n", code: "{{ $item.A }}", output: "number" }] as Component[];
  it("counts components and AI fields giving a number as coordinates, not as location text", () => {
    const aiNumber = blankField("a", "Lat", "ai", { code: "Latitude of {{ $item.City }}", output: "number" });
    const aiText = blankField("b", "Place", "ai", { code: "Coordinates of {{ $item.City }}", output: "string" });
    const sharedNumber = blankField("c", "Lon", "component", { code: null, componentId: "n" });
    for (const f of [aiNumber, sharedNumber, blankField("d", "N", "number")]) {
      expect(isCoordinateField(f, shared)).toBe(true);
      expect(isLocationTextField(f, shared)).toBe(false);
    }
    expect(isCoordinateField(aiText, shared)).toBe(false);
    expect(isLocationTextField(aiText, shared)).toBe(true);
  });
});
