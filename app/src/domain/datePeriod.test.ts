import { describe, expect, it } from "vitest";
import { defaultDateField, weekNumber, offsetFrom, parseRange, parseRolling, periodAround, periodKind, periodLabel, rangeValue, resolveRange, rollingLabel, rollingValue, shiftPeriod } from "./datePeriod";

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

  it("round-trip through their offset and read in words", () => {
    expect(offsetFrom("month", { start: "2025-12-01", end: "2025-12-31" }, today)).toBe(-10);
    expect(offsetFrom("week", { start: "2026-11-01", end: "2026-11-07" }, today)).toBe(1);
    expect(parseRolling(rollingValue({ kind: "week", offset: -2 }))).toEqual({ kind: "week", offset: -2 });
    expect(rollingLabel({ kind: "month", offset: -1 })).toBe("Last month");
    expect(rollingLabel({ kind: "day", offset: 3 })).toBe("In 3 days");
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
