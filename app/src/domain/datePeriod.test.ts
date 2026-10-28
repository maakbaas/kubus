import { describe, expect, it } from "vitest";
import { defaultDateField, weekNumber, parseRange, parseRolling, parseRollingRange, periodAround, periodKind, periodLabel, rangeOrRolling, rangeValue, resolveRange, rollingLabel, rollingRangeLabel, rollingRangeValue, rollingValue, shiftPeriod, toDateLabel, toDateValue } from "./datePeriod";

describe("date periods", () => {
  it("finds the day, week (Sunday first), month and year around a day", () => {
    expect(periodAround("day", "2026-10-27")).toEqual({ start: "2026-10-27", end: "2026-10-27" });
    expect(periodAround("week", "2026-10-27")).toEqual({ start: "2026-10-25", end: "2026-10-31" });
    expect(periodAround("week", "2026-11-01")).toEqual({ start: "2026-11-01", end: "2026-11-07" });
    expect(periodAround("month", "2024-02-10")).toEqual({ start: "2024-02-01", end: "2024-02-29" });
    expect(periodAround("year", "2026-10-27")).toEqual({ start: "2026-01-01", end: "2026-12-31" });
  });

  it("tells what a period is from its two days", () => {
    expect(periodKind({ start: "2026-10-27", end: "2026-10-27" })).toBe("day");
    expect(periodKind({ start: "2026-10-25", end: "2026-10-31" })).toBe("week");
    expect(periodKind({ start: "2026-10-26", end: "2026-11-01" })).toBe("range");
    expect(periodKind({ start: "2026-10-27", end: "2026-11-02" })).toBe("range");
    expect(periodKind({ start: "2026-10-01", end: "2026-10-31" })).toBe("month");
    expect(periodKind({ start: "2026-01-01", end: "2026-12-31" })).toBe("year");
  });

  it("moves to the period before or after; a range by its length", () => {
    expect(shiftPeriod({ start: "2026-01-01", end: "2026-01-31" }, "month", -1)).toEqual({ start: "2025-12-01", end: "2025-12-31" });
    expect(shiftPeriod({ start: "2026-12-27", end: "2027-01-02" }, "week", 1)).toEqual({ start: "2027-01-03", end: "2027-01-09" });
    expect(shiftPeriod({ start: "2026-03-31", end: "2026-03-31" }, "day", 1)).toEqual({ start: "2026-04-01", end: "2026-04-01" });
    expect(shiftPeriod({ start: "2026-10-01", end: "2026-10-10" }, "range", 1)).toEqual({ start: "2026-10-11", end: "2026-10-20" });
  });

  it("keeps this week, month or year so far, up to today", () => {
    expect(toDateValue("year")).toBe("year+0..day+0");
    expect(resolveRange("year+0..day+0", "2026-10-28")).toEqual({ start: "2026-01-01", end: "2026-10-28" });
    expect(resolveRange("month+0..day+0", "2026-10-28")).toEqual({ start: "2026-10-01", end: "2026-10-28" });
    expect(resolveRange("week+0..day+0", "2026-10-28")).toEqual({ start: "2026-10-25", end: "2026-10-28" });
    expect(resolveRange("year-1..day+0", "2026-10-28")).toBeNull();
    expect(toDateLabel("month")).toBe("Month to date");
  });

  it("numbers weeks from the one holding 1 January", () => {
    expect(weekNumber("2026-10-27")).toEqual({ week: 44, year: 2026 });
    expect(weekNumber("2026-12-31")).toEqual({ week: 1, year: 2027 });
    expect(weekNumber("2026-01-03")).toEqual({ week: 1, year: 2026 });
    expect(weekNumber("2026-01-04")).toEqual({ week: 2, year: 2026 });
    expect(periodLabel({ start: "2026-10-25", end: "2026-10-31" }, "week", "en-GB")).toBe("Week 44 · 25 Oct – 31 Oct 2026");
  });

  it("reads and writes a between value", () => {
    expect(parseRange(rangeValue({ start: "2026-01-01", end: "2026-02-01" }))).toEqual({ start: "2026-01-01", end: "2026-02-01" });
    expect(parseRange("2026-02-01..2026-01-01")).toBeNull();
    expect(parseRange("2026-02-01")).toBeNull();
  });
});

describe("rolling periods", () => {
  const today = "2026-10-27";
  it("are counted from today", () => {
    expect(resolveRange("week+0", today)).toEqual({ start: "2026-10-25", end: "2026-10-31" });
    expect(resolveRange("month-1", today)).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(resolveRange("year+1", today)).toEqual({ start: "2027-01-01", end: "2027-12-31" });
    expect(resolveRange("day-3", today)).toEqual({ start: "2026-10-24", end: "2026-10-24" });
    expect(resolveRange("2026-01-01..2026-01-31", today)).toEqual({ start: "2026-01-01", end: "2026-01-31" });
    expect(resolveRange("fortnight+0", today)).toBeNull();
  });

  it("read and write their value, and read in words", () => {
    expect(parseRolling(rollingValue({ kind: "week", offset: -2 }))).toEqual({ kind: "week", offset: -2 });
    expect(rollingLabel({ kind: "month", offset: -1 })).toBe("Last month");
    expect(rollingLabel({ kind: "day", offset: 3 })).toBe("In 3 days");
  });

  it("include a range ending today, kept as days from today", () => {
    expect(rangeOrRolling({ start: "2026-10-21", end: today }, today)).toBe("day-6..day+0");
    expect(rangeOrRolling({ start: "2026-10-21", end: "2026-10-26" }, today)).toBe("2026-10-21..2026-10-26");
    expect(resolveRange("day-6..day+0", today)).toEqual({ start: "2026-10-21", end: today });
    expect(resolveRange("day-6..day+0", "2026-11-02")).toEqual({ start: "2026-10-27", end: "2026-11-02" });
    expect(parseRollingRange("day+1..day-1")).toBeNull();
    expect(rollingRangeLabel({ from: -6, to: 0 })).toBe("Last 7 days");
    expect(rollingRangeLabel({ from: 0, to: 0 })).toBe("Today");
  });
});

describe("hours and minutes", () => {
  const now = "2026-10-27T14:35";
  it("are an hour's minutes, or a range's counted from now", () => {
    expect(periodAround("hour", now)).toEqual({ start: "2026-10-27T14:00", end: "2026-10-27T14:59" });
    expect(periodAround("hour", "2026-10-27")).toEqual({ start: "2026-10-27T00:00", end: "2026-10-27T00:59" });
    expect(periodAround("day", now)).toEqual({ start: "2026-10-27", end: "2026-10-27" });
    expect(resolveRange("hour+0", now)).toEqual({ start: "2026-10-27T14:00", end: "2026-10-27T14:59" });
    expect(resolveRange("hour-15", now)).toEqual({ start: "2026-10-26T23:00", end: "2026-10-26T23:59" });
    expect(resolveRange("hour-23..hour+0", now)).toEqual({ start: "2026-10-26T15:00", end: "2026-10-27T14:59" });
    expect(resolveRange("minute-29..minute+0", now)).toEqual({ start: "2026-10-27T14:06", end: "2026-10-27T14:35" });
    expect(resolveRange("day-6..day+0", now)).toEqual({ start: "2026-10-21", end: "2026-10-27" });
    expect(resolveRange("2026-10-27T08:00..2026-10-27T09:29", now)).toEqual({ start: "2026-10-27T08:00", end: "2026-10-27T09:29" });
    expect(resolveRange("2026-10-27T08:00..2026-10-27", now)).toBeNull();
    expect(resolveRange("hour-1..day+0", now)).toBeNull();
  });
  it("are told apart, moved and named", () => {
    expect(periodKind({ start: "2026-10-27T14:00", end: "2026-10-27T14:59" })).toBe("hour");
    expect(periodKind({ start: "2026-10-27T14:06", end: "2026-10-27T14:35" })).toBe("range");
    expect(shiftPeriod({ start: "2026-10-27T23:00", end: "2026-10-27T23:59" }, "hour", 1)).toEqual({ start: "2026-10-28T00:00", end: "2026-10-28T00:59" });
    expect(shiftPeriod({ start: "2026-10-27T14:06", end: "2026-10-27T14:35" }, "range", -1)).toEqual({ start: "2026-10-27T13:36", end: "2026-10-27T14:05" });
    expect(periodLabel({ start: "2026-10-27T14:00", end: "2026-10-27T14:59" }, "hour", "en-GB")).toBe("Tue, 27 Oct 2026, 14:00 – 15:00");
    expect(periodLabel({ start: "2026-10-26T15:00", end: "2026-10-27T14:59" }, "range", "en-GB")).toBe("26 Oct 15:00 – 27 Oct 15:00");
    expect(rollingRangeLabel({ from: -23, to: 0, unit: "hour" })).toBe("Last 24 hours");
    expect(rollingRangeLabel({ from: 0, to: 0, unit: "minute" })).toBe("This minute");
    expect(rollingRangeValue({ from: -29, to: 0, unit: "minute" })).toBe("minute-29..minute+0");
    expect(rollingLabel({ kind: "hour", offset: -1 })).toBe("Last hour");
    expect(rangeOrRolling({ start: "2026-10-27T08:00", end: "2026-10-27T08:59" }, "2026-10-27")).toBe("2026-10-27T08:00..2026-10-27T08:59");
  });
});

describe("the default date field", () => {
  const base = { id: "c", name: "C", pluralName: "Cs", icon: null, description: "", itemViews: [], spaceIds: null, createdAt: "", updatedAt: "" };
  const f = (id: string, kind: "string" | "date") => ({ id, collectionId: "c", name: id, kind, targetCollectionId: null, componentId: null, code: null, output: null, frameRatio: null, choiceFilter: [], toggleIcon: null, strikeThrough: false, position: 0 });
  it("is the first date field, else Updated", () => {
    expect(defaultDateField({ ...base, fields: [f("a", "string"), f("b", "date")] })).toBe("b");
    expect(defaultDateField({ ...base, fields: [f("a", "string")] })).toBe("$updated");
  });
});
