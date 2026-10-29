import { describe, expect, it } from "vitest";
import { defaultDateField, kindValue, latestValue, periodState, periodText, stepValue, windowValue, withPeriod, weekNumber, parseRange, parseRolling, parseRollingRange, periodAround, periodKind, periodLabel, rangeOrRolling, rangeValue, resolveRange, rollingLabel, rollingRangeLabel, rollingRangeValue, rollingValue, shiftPeriod, toDateLabel, toDateValue } from "./datePeriod";

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

describe("the period as the filter bar and panel edit it", () => {
  // Thursday 29 October 2026, 10:30 (a week runs Sunday 25 to Saturday 31).
  const NOW = "2026-10-29T10:30";

  it("tells which window of its kind a value is, and its words", () => {
    expect(periodState("week-1", NOW)).toMatchObject({ kind: "week", window: "current", counted: true, counting: "Last week", period: { start: "2026-10-18", end: "2026-10-24" } });
    expect(periodState("year+0..day+0", NOW)).toMatchObject({ kind: "year", window: "toDate", counting: "Year to date" });
    expect(periodState("day-6..day+0", NOW)).toMatchObject({ kind: "day", window: "last", counting: "Last 7 days" });
    expect(periodState("minute-29..minute+0", NOW)).toMatchObject({ kind: "hour", window: "lastMinutes" });
    expect(periodState("2026-10-01..2026-10-31", NOW)).toMatchObject({ kind: "month", window: "fixed", counted: false, counting: "" });
    expect(periodState("2026-10-01..2026-10-10", NOW)).toMatchObject({ kind: "range", window: null });
    expect(periodState("day-10..day-3", NOW)).toMatchObject({ kind: "range", window: null, counted: true });
    expect(periodState("nonsense", NOW)).toBeNull();
    const words = (v: string) => periodText(periodState(v, NOW)!);
    expect(words("2026-10-01..2026-10-31")).toBe(periodLabel({ start: "2026-10-01", end: "2026-10-31" }, "month"));
    expect(words("month+0")).toBe(`This month · ${periodLabel({ start: "2026-10-01", end: "2026-10-31" }, "month")}`);
    expect(words("day-6..day+0")).toBe(`Last 7 days · ${periodLabel({ start: "2026-10-23", end: "2026-10-29" }, "range")}`);
  });

  it("steps a rolling period as a rolling one and a chosen one by its kind", () => {
    expect(stepValue("week+0", -1, NOW)).toBe("week-1");
    expect(stepValue("week-1", -1, NOW)).toBe("week-2");
    expect(stepValue("month-2", 1, NOW)).toBe("month-1");
    expect(stepValue("hour+0", 1, NOW)).toBe("hour+1");
    expect(stepValue("2026-10-01..2026-10-31", -1, NOW)).toBe("2026-09-01..2026-09-30");
    expect(stepValue("2026-12-01..2026-12-31", 1, NOW)).toBe("2027-01-01..2027-01-31");
    expect(stepValue("2026-10-29..2026-10-29", 1, NOW)).toBe("2026-10-30..2026-10-30");
    expect(stepValue("2026-10-14T09:00..2026-10-14T09:59", 1, NOW)).toBe("2026-10-14T10:00..2026-10-14T10:59");
    // A range moves by its length, as does a month stepped as a range.
    expect(stepValue("2026-10-01..2026-10-10", 1, NOW)).toBe("2026-10-11..2026-10-20");
    expect(stepValue("2026-10-01..2026-10-31", 1, NOW, "range")).toBe("2026-11-01..2026-12-01");
    // Up to now there is nothing before or after.
    expect(stepValue("day-6..day+0", -1, NOW)).toBeNull();
    expect(stepValue("week+0..day+0", 1, NOW)).toBeNull();
    expect(stepValue("nonsense", 1, NOW)).toBeNull();
  });

  it("changes the kind keeping the window and the moment", () => {
    // Counted from now stays so, in the other kind (last week: this month).
    expect(kindValue("week-1", "month", NOW)).toBe("month+0");
    // A chosen one is the other kind around the period shown.
    expect(kindValue("2026-10-01..2026-10-31", "year", NOW)).toBe("2026-01-01..2026-12-31");
    expect(kindValue("2026-10-01..2026-10-31", "day", NOW)).toBe("2026-10-01..2026-10-01");
    expect(kindValue("2026-10-14T09:00..2026-10-14T09:59", "day", NOW)).toBe("2026-10-14..2026-10-14");
    expect(kindValue("2026-10-14..2026-10-14", "hour", NOW)).toBe("2026-10-14T00:00..2026-10-14T00:59");
    // The last n starts as the other unit's own n; so far isn't of a day; n minutes are of an hour.
    expect(kindValue("day-6..day+0", "month", NOW)).toBe("month-11..month+0");
    expect(kindValue("year+0..day+0", "month", NOW)).toBe("month+0..day+0");
    expect(kindValue("year+0..day+0", "day", NOW)).toBe("day+0");
    expect(kindValue("minute-29..minute+0", "hour", NOW)).toBe("minute-29..minute+0");
    expect(kindValue("minute-29..minute+0", "week", NOW)).toBe("week-3..week+0");
    // No period yet (or a range): the current one of the kind.
    expect(kindValue(null, "month", NOW)).toBe("month+0");
    expect(kindValue("2026-10-01..2026-10-10", "week", NOW)).toBe("week+0");
    expect(windowValue("week", "fixed", "2026-10-29")).toBe("2026-10-25..2026-10-31");
    expect(windowValue("day", "last", NOW, 3)).toBe("day-2..day+0");
  });

  it("jumps to the most recent period of the kind, rolling", () => {
    expect(latestValue("2026-09-01..2026-09-30", NOW)).toBe("month+0");
    expect(latestValue("week-3", NOW)).toBe("week+0");
    expect(latestValue("2026-03-02T14:00..2026-03-02T14:59", NOW)).toBe("hour+0");
    expect(latestValue("2026-03-02..2026-03-02", NOW)).toBe("day+0");
    expect(latestValue("day-6..day+0", NOW)).toBe("day+0");
    expect(latestValue("2026-10-01..2026-10-10", NOW)).toBeNull();
    expect(latestValue("nonsense", NOW)).toBeNull();
    // The jump is itself a value that resolves to the period of now.
    expect(resolveRange(latestValue("2026-03-02..2026-03-02", NOW)!, NOW)).toEqual({ start: "2026-10-29", end: "2026-10-29" });
  });

  it("writes the period into the filters: the rule it has, else a new first one", () => {
    const other = { id: "o", fieldId: "x", operator: "is" as const, value: "1" };
    const made = withPeriod([other], "d", "month+0");
    expect(made).toHaveLength(2);
    expect(made[0]).toMatchObject({ fieldId: "d", operator: "between", value: "month+0" });
    expect(made[1]).toBe(other);
    // The existing rule keeps its id and field (the one picked in the panel), others stay where they are.
    const changed = withPeriod(made, "ignored", "week-1");
    expect(changed[0]).toEqual({ ...made[0], value: "week-1" });
    expect(changed[1]).toBe(other);
    // Counted from a page item's date stays so while the new period is counted from a day, and goes with a chosen one.
    const anchored = [{ id: "r", fieldId: "d", operator: "between" as const, value: "day-6..day+0@$item.f1" }];
    expect(withPeriod(anchored, "d", "day-13..day+0")[0].value).toBe("day-13..day+0@$item.f1");
    expect(withPeriod(anchored, "d", "2026-10-01..2026-10-07")[0].value).toBe("2026-10-01..2026-10-07");
    expect(withPeriod(anchored, "d", "day+0", null)[0].value).toBe("day+0");
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
