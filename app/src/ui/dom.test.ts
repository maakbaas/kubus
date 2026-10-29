// @vitest-environment node
// Logic that talks to the browser (viewport, focus, keyboard, selection, canvas), against small
// stand-ins for the parts of the DOM it touches. What is drawn is the GUI suite's.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cellEditStart, captureEditStart } from "./editStart";
import { escapeThroughDropdowns } from "./escapeThroughDropdowns";
import { keepFocusInView, onViewportChange, panelRoom, setRoom, sideOf, typingIn, visibleArea } from "./panelRoom";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const rect = (top: number, bottom: number, extra: Partial<DOMRect> = {}) => ({ top, bottom, left: 0, right: 100, width: 100, height: bottom - top, ...extra }) as DOMRect;

describe("panel room", () => {
  const viewport = (innerHeight: number, vv?: { offsetTop: number; height: number }) => vi.stubGlobal("window", { innerHeight, visualViewport: vv });

  it("the visible area is the window without an on-screen keyboard", () => {
    viewport(800);
    expect(visibleArea()).toEqual({ top: 0, bottom: 800 });
    viewport(800, { offsetTop: 0, height: 500 });
    expect(visibleArea()).toEqual({ top: 0, bottom: 500 });
    viewport(800, { offsetTop: 40, height: 900 }); // panned: never past the window
    expect(visibleArea()).toEqual({ top: 40, bottom: 800 });
  });

  it("a panel is below its button when it starts under it, else above", () => {
    expect(sideOf(rect(100, 132), rect(132, 400))).toBe("below");
    expect(sideOf(rect(100, 132), rect(100, 132))).toBe("below");
    expect(sideOf(rect(500, 532), rect(200, 500))).toBe("above");
  });

  it("gets the room of the roomier side, less a margin", () => {
    viewport(800);
    expect(panelRoom(rect(100, 132), null)).toBe(800 - 132 - 16);
    expect(panelRoom(rect(600, 632), null)).toBe(600 - 16);
    expect(panelRoom(rect(600, 632), null, 0)).toBe(600);
  });

  it("while typing it keeps its side, as long as there is room there, even if the other is roomier", () => {
    viewport(800, { offsetTop: 0, height: 400 }); // the keyboard came up
    const button = rect(150, 182);
    expect(panelRoom(button, null)).toBe(400 - 182 - 16); // 202: below
    expect(panelRoom(rect(300, 332), "above")).toBe(300 - 16);
    // Too little room on the side it was on: it may change sides.
    expect(panelRoom(rect(300, 332), "below")).toBe(300 - 16);
    expect(panelRoom(rect(60, 92), "above")).toBe(400 - 92 - 16);
  });

  it("knows when a text field inside an element has focus", () => {
    const matches = vi.fn((s: string) => s.includes("textarea"));
    const inside = { matches };
    const el = { contains: (n: unknown) => n === inside };
    vi.stubGlobal("document", { activeElement: inside });
    expect(typingIn(el as never)).toBe(true);
    expect(typingIn(null)).toBe(false);
    expect(typingIn({ contains: () => false } as never)).toBe(false);
    vi.stubGlobal("document", { activeElement: null });
    expect(typingIn(el as never)).toBe(false);
    vi.stubGlobal("document", { activeElement: { matches: () => false } });
    expect(typingIn({ contains: () => true } as never)).toBe(false); // a checkbox, a button
  });

  it("scrolls only the panel to keep the focused field in sight", () => {
    viewport(1000);
    const field = { getBoundingClientRect: () => rect(0, 0), matches: () => true };
    const scroller = (s: DOMRect) => ({ scrollTop: 100, getBoundingClientRect: () => s, contains: () => true });
    vi.stubGlobal("document", { activeElement: field });
    field.getBoundingClientRect = () => rect(280, 330);
    const low = scroller(rect(100, 300));
    keepFocusInView(low as never);
    expect(low.scrollTop).toBe(130); // 30 px under its bottom edge
    field.getBoundingClientRect = () => rect(80, 110);
    const high = scroller(rect(100, 300));
    keepFocusInView(high as never);
    expect(high.scrollTop).toBe(80);
    field.getBoundingClientRect = () => rect(150, 180);
    const fine = scroller(rect(100, 300));
    keepFocusInView(fine as never);
    expect(fine.scrollTop).toBe(100);
    keepFocusInView(null);
    keepFocusInView(undefined);
  });

  it("keeps the field within what can be seen of the panel, not under the keyboard", () => {
    // iOS: panned by 160, 300 seen; the panel (hung above a button the keyboard covers) runs on to 480.
    viewport(800, { offsetTop: 160, height: 300 });
    const field = { getBoundingClientRect: () => rect(440, 472), matches: () => true };
    vi.stubGlobal("document", { activeElement: field });
    const scroller = { scrollTop: 50, getBoundingClientRect: () => rect(166, 480), contains: () => true };
    keepFocusInView(scroller as never);
    expect(scroller.scrollTop).toBe(50 + 12); // its bottom at 460, the end of what is seen
    // A field taller than what is seen: its top stays in sight (where the caret starts).
    field.getBoundingClientRect = () => rect(200, 500);
    scroller.scrollTop = 0;
    keepFocusInView(scroller as never);
    expect(scroller.scrollTop).toBe(200 - 166);
  });

  it("does not scroll when nothing is being typed in", () => {
    vi.stubGlobal("document", { activeElement: null });
    const scroller = { scrollTop: 5, contains: () => false, getBoundingClientRect: () => rect(0, 10) };
    keepFocusInView(scroller as never);
    expect(scroller.scrollTop).toBe(5);
  });

  it("listens to the window and its visual viewport, and stops", () => {
    const vv = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const win = { visualViewport: vv, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal("window", win);
    const update = vi.fn();
    const off = onViewportChange(update);
    expect(win.addEventListener).toHaveBeenCalledWith("resize", update, true); // capture: before Floating UI's own
    expect(vv.addEventListener).toHaveBeenCalledWith("resize", update);
    expect(vv.addEventListener).toHaveBeenCalledWith("scroll", update);
    off();
    expect(win.removeEventListener).toHaveBeenCalledWith("resize", update, true);
    expect(vv.removeEventListener).toHaveBeenCalledTimes(2);
  });

  it("copes with a browser without a visual viewport", () => {
    const win = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal("window", win);
    onViewportChange(() => {})();
    expect(win.removeEventListener).toHaveBeenCalled();
  });

  it("sets the room as a property, never negative", () => {
    const style = { setProperty: vi.fn() };
    setRoom({ style } as never, 120);
    setRoom({ style } as never, -30);
    setRoom(null, 5);
    expect(style.setProperty.mock.calls).toEqual([["--popover-room", "120px"], ["--popover-room", "0px"]]);
  });
});

describe("Escape through dropdowns", () => {
  class FakeKeyboardEvent {
    isTrusted = false;
    constructor(
      public type: string,
      public init: Record<string, unknown>,
    ) {}
    get key() {
      return this.init.key;
    }
  }
  function setup() {
    vi.useFakeTimers();
    const listeners: { type: string; fn: (e: never) => void; capture: boolean }[] = [];
    const dispatched: unknown[] = [];
    vi.stubGlobal("KeyboardEvent", FakeKeyboardEvent);
    vi.stubGlobal("document", {
      addEventListener: (type: string, fn: (e: never) => void, capture?: boolean) => listeners.push({ type, fn, capture: !!capture }),
      dispatchEvent: (e: unknown) => dispatched.push(e),
    });
    escapeThroughDropdowns();
    const capture = listeners.find((l) => l.capture)!.fn;
    const bubble = listeners.find((l) => !l.capture)!.fn;
    /** A trusted keydown whose target is (or is in) a dropdown field. */
    const key = (k: string, target: { expanded?: boolean; dropdown?: boolean } = { dropdown: true }) => {
      const e = new FakeKeyboardEvent("keydown", { key: k });
      e.isTrusted = true;
      Object.assign(e, {
        target: { closest: () => (target.dropdown ? { getAttribute: () => (target.expanded ? "true" : "false") } : null) },
      });
      return e;
    };
    return { capture, bubble, dispatched, key };
  }

  it("sends an Escape that a closed dropdown swallowed on to the document", () => {
    const t = setup();
    const e = t.key("Escape");
    t.capture(e as never);
    vi.runAllTimers();
    expect(t.dispatched).toHaveLength(1);
    expect(t.dispatched[0]).toMatchObject({ type: "keydown", init: { key: "Escape", code: "Escape", bubbles: true, cancelable: true } });
  });

  it("does nothing when the Escape got through by itself", () => {
    const t = setup();
    const e = t.key("Escape");
    t.capture(e as never);
    t.bubble(e as never);
    vi.runAllTimers();
    expect(t.dispatched).toHaveLength(0);
  });

  it("leaves an open dropdown's Escape to the dropdown (it closes its menu)", () => {
    const t = setup();
    t.capture(t.key("Escape", { dropdown: true, expanded: true }) as never);
    vi.runAllTimers();
    expect(t.dispatched).toHaveLength(0);
  });

  it("ignores other keys, other targets and untrusted events (including its own)", () => {
    const t = setup();
    t.capture(t.key("Enter") as never);
    t.capture(t.key("Escape", { dropdown: false }) as never);
    const synthetic = t.key("Escape");
    synthetic.isTrusted = false;
    t.capture(synthetic as never);
    const noTarget = t.key("Escape");
    Object.assign(noTarget, { target: null });
    t.capture(noTarget as never);
    vi.runAllTimers();
    expect(t.dispatched).toHaveLength(0);
  });

  it("only the latest pending Escape is sent on", () => {
    const t = setup();
    const first = t.key("Escape");
    const second = t.key("Escape");
    t.capture(first as never);
    t.capture(second as never);
    vi.runAllTimers();
    expect(t.dispatched).toHaveLength(1);
  });
});

describe("where a click puts the caret", () => {
  /** Text nodes in a container: offsets are counted over the text before a node. */
  interface FakeNode {
    text: string;
  }
  function world(nodes: FakeNode[], opts: { rectsOfContainer?: { top: number; width?: number }[]; selection?: unknown; caretAt?: { node: FakeNode; offset: number } | null; legacy?: boolean; fieldHeight?: number } = {}) {
    const container = {
      nodes,
      contains: (n: FakeNode) => nodes.includes(n),
      closest: (s: string) => (s === ".view-field" && opts.fieldHeight ? { getBoundingClientRect: () => ({ height: opts.fieldHeight }) } : null),
      getBoundingClientRect: () => ({ height: 20 }),
    };
    const createRange = () => {
      let end: { node: FakeNode; offset: number } | null = null;
      return {
        selectNodeContents: () => {},
        setEnd: (node: FakeNode, offset: number) => (end = { node, offset }),
        setStart: (node: FakeNode, offset: number) => (end = { node, offset }),
        get startContainer() {
          return end!.node;
        },
        get startOffset() {
          return end!.offset;
        },
        toString: () => "x".repeat(nodes.slice(0, nodes.indexOf(end!.node)).reduce((n, x) => n + x.text.length, 0) + end!.offset),
        getClientRects: () => (opts.rectsOfContainer ?? [{ top: 0 }]).map((r) => ({ width: 10, ...r })),
      };
    };
    const doc: Record<string, unknown> = { createRange };
    if (opts.legacy) {
      doc.caretRangeFromPoint = () => {
        if (!opts.caretAt) return null;
        const r = createRange();
        r.setStart(opts.caretAt.node, opts.caretAt.offset);
        return r;
      };
    }
    else doc.caretPositionFromPoint = () => (opts.caretAt ? { offsetNode: opts.caretAt.node, offset: opts.caretAt.offset } : null);
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", { getSelection: () => opts.selection ?? null });
    return container as unknown as HTMLElement;
  }
  const click = { clientX: 40, clientY: 12 };
  const a = { text: "Hello " };
  const b = { text: "world" };

  it("the caret goes where the text was clicked, counted in characters", () => {
    const el = world([a, b], { caretAt: { node: b, offset: 2 } });
    const start = captureEditStart(el, click);
    expect(start).toMatchObject({ point: { x: 40, y: 12 }, range: { start: 8, end: 8 }, wrapped: false, fieldHeight: 20 });
    expect(start.selection).toBeUndefined();
  });

  it("falls back to the older WebKit call", () => {
    const el = world([a, b], { legacy: true, caretAt: { node: a, offset: 3 } });
    expect(captureEditStart(el, click).range).toEqual({ start: 3, end: 3 });
  });

  it("no range when the click is outside the text", () => {
    const outside = { text: "x" };
    expect(captureEditStart(world([a], { caretAt: { node: outside, offset: 0 } }), click).range).toBeUndefined();
    expect(captureEditStart(world([a], { caretAt: null }), click).range).toBeUndefined();
    expect(captureEditStart(world([a], { legacy: true, caretAt: null }), click).range).toBeUndefined();
  });

  const selecting = (_nodes: FakeNode[], from: [FakeNode, number], to: [FakeNode, number], rects: { left: number; right: number; top: number; height: number }[]) => ({
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => ({ startContainer: from[0], startOffset: from[1], endContainer: to[0], endOffset: to[1], getClientRects: () => rects }),
  });

  it("a text selected by dragging is carried over: its characters and its two ends", () => {
    const selection = selecting([a, b], [a, 2], [b, 3], [{ left: 10, right: 60, top: 0, height: 20 }, { left: 0, right: 30, top: 20, height: 20 }]);
    const start = captureEditStart(world([a, b], { selection }), click);
    expect(start.range).toEqual({ start: 2, end: 9 });
    expect(start.selection).toEqual({ from: { x: 11, y: 10 }, to: { x: 29, y: 30 } });
  });

  it("a selection with no rectangles still has its characters", () => {
    const selection = selecting([a], [a, 1], [a, 4], []);
    const start = captureEditStart(world([a], { selection }), click);
    expect(start.range).toEqual({ start: 1, end: 4 });
    expect(start.selection).toBeUndefined();
  });

  it("a selection elsewhere on the page or a collapsed one is not this value's: the click decides", () => {
    const other = { text: "elsewhere" };
    const elsewhere = selecting([a], [other, 0], [other, 3], []);
    expect(captureEditStart(world([a], { selection: elsewhere, caretAt: { node: a, offset: 1 } }), click).range).toEqual({ start: 1, end: 1 });
    const collapsed = { isCollapsed: true, rangeCount: 1 };
    expect(captureEditStart(world([a], { selection: collapsed, caretAt: { node: a, offset: 2 } }), click).range).toEqual({ start: 2, end: 2 });
    const none = { isCollapsed: false, rangeCount: 0 };
    expect(captureEditStart(world([a], { selection: none, caretAt: { node: a, offset: 2 } }), click).range).toEqual({ start: 2, end: 2 });
  });

  it("knows a value that wraps onto several lines, and holds the height of the whole field", () => {
    const el = world([a], { rectsOfContainer: [{ top: 0 }, { top: 20 }, { top: 20.2 }], fieldHeight: 64 });
    expect(captureEditStart(el, click)).toMatchObject({ wrapped: true, fieldHeight: 64 });
    // Empty rectangles (collapsed whitespace) are not lines.
    expect(captureEditStart(world([a], { rectsOfContainer: [{ top: 0 }, { top: 20, width: 0 }] }), click).wrapped).toBe(false);
  });

  it("a table cell has no field height to hold", () => {
    const start = cellEditStart(world([a], { caretAt: { node: a, offset: 1 }, fieldHeight: 64 }), click);
    expect(start.fieldHeight).toBeUndefined();
    expect(start.range).toEqual({ start: 1, end: 1 });
  });
});
