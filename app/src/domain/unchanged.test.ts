import { describe, expect, it } from "vitest";
import { keepUnchanged } from "./unchanged";

describe("keepUnchanged", () => {
  const a = { id: "a", name: "A", fields: [{ id: "f", name: "F" }] };
  const b = { id: "b", name: "B", fields: [] };

  it("keeps the previous object of each one whose contents are the same", () => {
    const next = keepUnchanged([a, b], [{ ...a, fields: [{ id: "f", name: "F" }] }, { ...b, name: "B2" }]);
    expect(next[0]).toBe(a);
    expect(next[1]).not.toBe(b);
    expect(next[1].name).toBe("B2");
  });

  it("is the previous list itself when nothing changed, a new one when one was added, removed or moved", () => {
    const prev = [a, b];
    expect(keepUnchanged(prev, [{ ...a }, { ...b }])).toBe(prev);
    expect(keepUnchanged(prev, [{ ...a }])).toEqual([a]);
    expect(keepUnchanged(prev, [{ ...b }, { ...a }])).toEqual([b, a]);
    expect(keepUnchanged(prev, [{ ...b }, { ...a }])[0]).toBe(b);
    expect(keepUnchanged([], [a])).toEqual([a]);
  });
});
