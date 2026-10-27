import { describe, expect, it } from "vitest";
import { isoWeek, parseRange, periodAround, periodKind, periodLabel, rangeValue, shiftPeriod } from "./datePeriod";

describe("date periods", () => {
  it("finds the day, week (Monday first), month and year around a day", () => {
    expect(periodAround("day", "2026-10-27")).toEqual({ start: "2026-10-27", end: "2026-10-27" });
    expect(periodAround("week", "2026-10-27")).toEqual({ start: "2026-10-26", end: "2026-11-01" });
    expect(periodAround("week", "2026-11-01")).toEqual({ start: "2026-10-26", end: "2026-11-01" });
    expect(periodAround("month", "2024-02-10")).toEqual({ start: "2024-02-01", end: "2024-02-29" });
    expect(periodAround("year", "2026-10-27")).toEqual({ start: "2026-01-01", end: "2026-12-31" });
  });

  it("tells what a period is from its two days", () => {
    expect(periodKind({ start: "2026-10-27", end: "2026-10-27" })).toBe("day");
    expect(periodKind({ start: "2026-10-26", end: "2026-11-01" })).toBe("week");
    expect(periodKind({ start: "2026-10-27", end: "2026-11-02" })).toBe("range");
    expect(periodKind({ start: "2026-10-01", end: "2026-10-31" })).toBe("month");
    expect(periodKind({ start: "2026-01-01", end: "2026-12-31" })).toBe("year");
  });

  it("moves to the period before or after; a range by its length", () => {
    expect(shiftPeriod({ start: "2026-01-01", end: "2026-01-31" }, "month", -1)).toEqual({ start: "2025-12-01", end: "2025-12-31" });
    expect(shiftPeriod({ start: "2026-12-28", end: "2027-01-03" }, "week", 1)).toEqual({ start: "2027-01-04", end: "2027-01-10" });
    expect(shiftPeriod({ start: "2026-03-31", end: "2026-03-31" }, "day", 1)).toEqual({ start: "2026-04-01", end: "2026-04-01" });
    expect(shiftPeriod({ start: "2026-10-01", end: "2026-10-10" }, "range", 1)).toEqual({ start: "2026-10-11", end: "2026-10-20" });
  });

  it("numbers weeks the ISO way", () => {
    expect(isoWeek("2026-10-27")).toEqual({ week: 44, year: 2026 });
    expect(isoWeek("2027-01-01")).toEqual({ week: 53, year: 2026 });
    expect(isoWeek("2025-12-29")).toEqual({ week: 1, year: 2026 });
    expect(periodLabel({ start: "2026-10-26", end: "2026-11-01" }, "week", "en-GB")).toBe("Week 44 · 26 Oct – 1 Nov 2026");
  });

  it("reads and writes a between value", () => {
    expect(parseRange(rangeValue({ start: "2026-01-01", end: "2026-02-01" }))).toEqual({ start: "2026-01-01", end: "2026-02-01" });
    expect(parseRange("2026-02-01..2026-01-01")).toBeNull();
    expect(parseRange("2026-02-01")).toBeNull();
  });
});
