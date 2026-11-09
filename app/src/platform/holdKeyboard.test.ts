// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { holdKeyboard, letGoOfKeyboard } from "./holdKeyboard";

const held = () => document.querySelectorAll('body > input[aria-hidden="true"]');

describe("the keyboard held for a Markdown editor that is still loading", () => {
  afterEach(() => {
    letGoOfKeyboard();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const touch = (on: boolean) => vi.stubGlobal("matchMedia", (q: string) => ({ matches: on && q.includes("hover: none") }));

  it("on a touch screen an unseen input at the tap has focus until the editor takes it", () => {
    touch(true);
    holdKeyboard({ clientX: 10, clientY: 20 });
    expect(held()).toHaveLength(1);
    expect(document.activeElement).toBe(held()[0]);
    letGoOfKeyboard();
    expect(held()).toHaveLength(0);
  });

  it("lets go at another tap, or after a long while (an editor that never came)", () => {
    touch(true);
    vi.useFakeTimers();
    holdKeyboard();
    document.dispatchEvent(new Event("pointerdown"));
    expect(held()).toHaveLength(0);
    holdKeyboard();
    vi.advanceTimersByTime(10_000);
    expect(held()).toHaveLength(1);
    vi.advanceTimersByTime(6_000);
    expect(held()).toHaveLength(0);
  });

  it("with a mouse nothing is held", () => {
    touch(false);
    holdKeyboard();
    expect(held()).toHaveLength(0);
  });
});
