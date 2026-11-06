import { describe, expect, it } from "vitest";
import { requestLayout } from "./layoutBatch";

const settled = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("requestLayout", () => {
  it("runs every job asked for in the same task phase by phase: all resets, then all measurements, then all changes", async () => {
    const log: string[] = [];
    const job = (name: string) => ({
      reset: () => log.push(`reset ${name}`),
      measure: () => log.push(`measure ${name}`),
      apply: () => log.push(`apply ${name}`),
    });
    requestLayout(job("a"));
    requestLayout(job("b"));
    expect(log).toEqual([]); // not before the task's own work is done
    await settled();
    expect(log).toEqual(["reset a", "reset b", "measure a", "measure b", "apply a", "apply b"]);
  });

  it("runs a job asked for twice in one task once, and again when asked again later", async () => {
    let runs = 0;
    const job = { measure: () => {}, apply: () => runs++ };
    requestLayout(job);
    requestLayout(job);
    await settled();
    expect(runs).toBe(1);
    requestLayout(job);
    await settled();
    expect(runs).toBe(2);
  });
});
