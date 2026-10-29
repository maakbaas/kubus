// shared/sources.ts: the helpers the app and every connector share. (Its tests live here, not in
// shared/: the server's typecheck and image take everything in shared/, and have no vitest.)
import { describe, expect, it } from "vitest";
import {
  betweenBounds,
  conditionText,
  isSourceCondition,
  wallTime,
  type SourceCondition,
  type SourceFilter,
} from "../../../../shared/sources";

describe("betweenBounds", () => {
  it("reads two days, both included", () => {
    expect(betweenBounds("2026-10-01..2026-10-31")).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(betweenBounds("2026-10-05..2026-10-05")).toEqual({ start: "2026-10-05", end: "2026-10-05" });
    expect(betweenBounds("  2026-10-01..2026-10-02  ")).toEqual({ start: "2026-10-01", end: "2026-10-02" });
  });

  it("reads two minutes", () => {
    expect(betweenBounds("2026-10-28T14:00..2026-10-28T14:59")).toEqual({ start: "2026-10-28T14:00", end: "2026-10-28T14:59" });
  });

  it.each([
    ["no range", "2026-10-01"],
    ["three parts", "2026-10-01..2026-10-02..2026-10-03"],
    ["not dates", "a..b"],
    ["a day and a minute", "2026-10-01..2026-10-02T10:00"],
    ["a minute and a day", "2026-10-01T10:00..2026-10-02"],
    ["first after last", "2026-10-31..2026-10-01"],
    ["seconds", "2026-10-01T10:00:00..2026-10-01T11:00:00"],
    ["empty", ""],
  ])("refuses %s", (_what, value) => {
    expect(betweenBounds(value)).toBeNull();
  });
});

describe("wallTime", () => {
  it("is a day's start as if UTC, or some days later (also over a month's end)", () => {
    expect(wallTime("2026-10-28")).toBe(Date.UTC(2026, 9, 28));
    expect(wallTime("2026-10-28", 1)).toBe(Date.UTC(2026, 9, 29));
    expect(wallTime("2026-10-31", 1)).toBe(Date.UTC(2026, 10, 1));
  });

  it("is a minute's wall time, or some minutes later (also over midnight)", () => {
    expect(wallTime("2026-10-28T14:05")).toBe(Date.UTC(2026, 9, 28, 14, 5));
    expect(wallTime("2026-10-28T23:59", 1)).toBe(Date.UTC(2026, 9, 29, 0, 0));
  });

  it("is NaN for anything else", () => {
    expect(wallTime("tomorrow")).toBeNaN();
    expect(wallTime("")).toBeNaN();
  });
});

describe("isSourceCondition", () => {
  const rule = { column: "name", operator: "is", value: "x" };

  it("accepts a rule, and nested and / or lists (also empty ones)", () => {
    expect(isSourceCondition(rule)).toBe(true);
    expect(isSourceCondition({ and: [] })).toBe(true);
    expect(isSourceCondition({ or: [] })).toBe(true);
    expect(isSourceCondition({ and: [rule, { or: [rule, { and: [rule] }] }] })).toBe(true);
  });

  it.each([
    ["null", null],
    ["a string", "name"],
    ["a number", 3],
    ["an empty object", {}],
    ["a rule without a value", { column: "a", operator: "is" }],
    ["a rule with a non-text value", { column: "a", operator: "is", value: 3 }],
    ["a rule with a non-text column", { column: 1, operator: "is", value: "x" }],
    ["and that isn't a list", { and: rule }],
    ["a bad rule nested", { and: [rule, { or: [{ column: "a" }] }] }],
  ])("refuses %s", (_what, x) => {
    expect(isSourceCondition(x)).toBe(false);
  });

  it("refuses a condition nested deeper than a malformed request may be", () => {
    let deep: unknown = rule;
    for (let i = 0; i < 40; i++) deep = { and: [deep] };
    expect(isSourceCondition(deep)).toBe(false);
    let ok: unknown = rule;
    for (let i = 0; i < 20; i++) ok = { or: [ok] };
    expect(isSourceCondition(ok)).toBe(true);
  });
});

describe("conditionText", () => {
  const words = { and: "AND", or: "OR", all: "TRUE", none: "FALSE" };
  const rule = (f: SourceFilter) => `${f.column} ${f.operator} ${f.value}`;
  const a: SourceFilter = { column: "a", operator: "is", value: "1" };
  const b: SourceFilter = { column: "b", operator: "is", value: "2" };

  it("brackets each rule as the connector writes it", () => {
    expect(conditionText(a, rule, words)).toBe("(a is 1)");
  });

  it("joins lists with the connector's words, nested in brackets", () => {
    const c: SourceCondition = { and: [a, { or: [b, a] }] };
    expect(conditionText(c, rule, words)).toBe("((a is 1) AND ((b is 2) OR (a is 1)))");
  });

  it("writes an empty and as everything and an empty or as nothing", () => {
    expect(conditionText({ and: [] }, rule, words)).toBe("TRUE");
    expect(conditionText({ or: [] }, rule, words)).toBe("FALSE");
    expect(conditionText({ and: [{ or: [] }] }, rule, words)).toBe("(FALSE)");
  });
});
