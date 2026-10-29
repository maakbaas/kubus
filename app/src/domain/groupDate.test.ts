import { describe, expect, it } from "vitest";
import { dateGroup, dateGroupLabel, dateGroupValue, isoWeek, parseGroupDate } from "./groupDate";
import type { Collection, FieldDef, Item } from "./model";
import { applyQuery, defaultQuery, type QueryContext } from "./query";

const field = (id: string, kind: FieldDef["kind"], position: number): FieldDef => ({
  id, collectionId: "t", name: id, kind, targetCollectionId: null, componentId: null, code: null, output: null, frameRatio: null, choiceFilter: [], toggleIcon: null, strikeThrough: false, position,
});
const collection: Collection = {
  id: "t", name: "Entry", pluralName: "Entries", icon: null, description: "", itemViews: [], spaceIds: null,
  fields: [field("title", "string", 0), field("day", "date", 1), field("at", "datetime", 2)],
  createdAt: "", updatedAt: "",
};
const ctx: QueryContext = { refLabel: () => "" };
const entry = (id: string, day: string | null, at: Date | null): Item => ({
  id, collectionId: "t", spaceId: "default", values: { title: id, day, at: at ? at.toISOString() : null }, createdAt: "", updatedAt: "",
});
// Local times (values are stored in UTC; the groups are of the local clock).
const entries = [
  entry("a", "2026-10-28", new Date(2026, 9, 28, 14, 30)),
  entry("b", "2026-10-26", new Date(2026, 9, 28, 14, 5)),
  entry("c", "2025-12-30", new Date(2026, 0, 3, 9, 0)),
  entry("d", "2026-11-02", new Date(2026, 10, 2, 0, 15)),
  entry("e", null, null),
  entry("f", "2026-10-28", new Date(2026, 9, 28, 23, 59)),
];
const grouped = (by: string, groupDate?: "year" | "month" | "week" | "day" | "hour", groupOrder?: "asc" | "desc" | "count") =>
  applyQuery(collection, entries, { ...defaultQuery(), groupBy: by, groupDate, groupOrder }, ctx).groups.map((g) => [g.key, g.label, g.items.map((i) => i.id).join("")]);

describe("isoWeek", () => {
  it("numbers weeks Monday to Sunday, week 1 holding the first Thursday", () => {
    expect(isoWeek(2026, 10, 28)).toEqual({ year: 2026, week: 44 });
    expect(isoWeek(2026, 1, 1)).toEqual({ year: 2026, week: 1 });
    // A week across the new year belongs to the year holding its Thursday.
    expect(isoWeek(2025, 12, 29)).toEqual({ year: 2026, week: 1 });
    expect(isoWeek(2027, 1, 1)).toEqual({ year: 2026, week: 53 });
    expect(isoWeek(2024, 12, 30)).toEqual({ year: 2025, week: 1 });
    expect(isoWeek(2026, 10, 25)).toEqual({ year: 2026, week: 43 });
    expect(isoWeek(2026, 10, 26)).toEqual({ year: 2026, week: 44 });
  });
});

describe("dateGroup", () => {
  it("keys sort as the time does and labels read out", () => {
    expect(dateGroup(2026, 10, 28, 14, "year")).toEqual({ key: "2026", label: "2026" });
    expect(dateGroup(2026, 10, 28, 14, "month")).toEqual({ key: "2026-10", label: "October 2026" });
    expect(dateGroup(2026, 10, 28, 14, "week")).toEqual({ key: "2026-W44", label: "Week 44, 2026" });
    expect(dateGroup(2026, 10, 28, 14, "day")).toEqual({ key: "2026-10-28", label: "28 Oct 2026" });
    expect(dateGroup(2026, 10, 28, 14, "hour")).toEqual({ key: "2026-10-28T14", label: "28 Oct 2026, 14:00" });
    expect(dateGroup(2026, 10, 7, 4)).toEqual({ key: "2026-10-07", label: "7 Oct 2026" });
    // A date has no hour: its day.
    expect(dateGroup(2026, 10, 28, null, "hour")).toEqual({ key: "2026-10-28", label: "28 Oct 2026" });
  });

  it("labels a key of any shape, a value for a new item in it, and reads a stored option", () => {
    expect(["2026", "2026-10", "2026-W44", "2026-10-28", "2026-10-28T14", "x"].map(dateGroupLabel)).toEqual(["2026", "October 2026", "Week 44, 2026", "28 Oct 2026", "28 Oct 2026, 14:00", "x"]);
    expect(["2026", "2026-10", "2026-W44", "2026-W01", "2026-10-28"].map(dateGroupValue)).toEqual(["2026-01-01", "2026-10-01", "2026-10-26", "2025-12-29", "2026-10-28"]);
    expect([parseGroupDate("year"), parseGroupDate("hour"), parseGroupDate("day"), parseGroupDate("decade"), parseGroupDate(undefined)]).toEqual(["year", "hour", undefined, undefined, undefined]);
  });
});

describe("applyQuery grouped by a date", () => {
  it("groups a date by day when not told otherwise, empty ones last", () => {
    expect(grouped("day")).toEqual([
      ["2025-12-30", "30 Dec 2025", "c"],
      ["2026-10-26", "26 Oct 2026", "b"],
      ["2026-10-28", "28 Oct 2026", "af"],
      ["2026-11-02", "2 Nov 2026", "d"],
      ["", "(empty)", "e"],
    ]);
  });

  it("groups a date by year, month and ISO week, in time order either way", () => {
    expect(grouped("day", "year")).toEqual([["2025", "2025", "c"], ["2026", "2026", "abdf"], ["", "(empty)", "e"]]);
    expect(grouped("day", "month")).toEqual([["2025-12", "December 2025", "c"], ["2026-10", "October 2026", "abf"], ["2026-11", "November 2026", "d"], ["", "(empty)", "e"]]);
    expect(grouped("day", "week")).toEqual([["2026-W01", "Week 1, 2026", "c"], ["2026-W44", "Week 44, 2026", "abf"], ["2026-W45", "Week 45, 2026", "d"], ["", "(empty)", "e"]]);
    expect(grouped("day", "month", "desc").map((g) => g[0])).toEqual(["2026-11", "2026-10", "2025-12", ""]);
    // Labels as text would put "April" before "December": the order is the keys'.
    expect(grouped("day", "week", "desc").map((g) => g[0])).toEqual(["2026-W45", "2026-W44", "2026-W01", ""]);
    expect(grouped("day", "month", "count").map((g) => g[0])).toEqual(["2026-10", "2025-12", "2026-11", ""]);
  });

  it("groups a date & time by its local year, month, week, day and hour", () => {
    expect(grouped("at", "year").map((g) => g.slice(0, 2).join("|"))).toEqual(["2026|2026", "|(empty)"]);
    expect(grouped("at", "month").map((g) => g[1])).toEqual(["January 2026", "October 2026", "November 2026", "(empty)"]);
    expect(grouped("at", "week").map((g) => g[1])).toEqual(["Week 1, 2026", "Week 44, 2026", "Week 45, 2026", "(empty)"]);
    expect(grouped("at")).toEqual([
      ["2026-01-03", "3 Jan 2026", "c"],
      ["2026-10-28", "28 Oct 2026", "abf"],
      ["2026-11-02", "2 Nov 2026", "d"],
      ["", "(empty)", "e"],
    ]);
    expect(grouped("at", "hour")).toEqual([
      ["2026-01-03T09", "3 Jan 2026, 09:00", "c"],
      ["2026-10-28T14", "28 Oct 2026, 14:00", "ab"],
      ["2026-10-28T23", "28 Oct 2026, 23:00", "f"],
      ["2026-11-02T00", "2 Nov 2026, 00:00", "d"],
      ["", "(empty)", "e"],
    ]);
  });

  it("groups a date by its day when asked for hours", () => {
    expect(grouped("day", "hour").map((g) => g[0])).toEqual(["2025-12-30", "2026-10-26", "2026-10-28", "2026-11-02", ""]);
  });
});
