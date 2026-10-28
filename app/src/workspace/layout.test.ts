import { describe, expect, it } from "vitest";
import {
  activePane,
  activeTab,
  closeTab,
  findPane,
  focusTab,
  HOME,
  initialWorkspace,
  moveTab,
  navigateActive,
  openBeside,
  openTab,
  paneOfTab,
  panes,
  resizeSplit,
  restoreWorkspace,
  setTabPath,
  topPanes,
  type LayoutNode,
  type SplitNode,
  type Workspace,
} from "./layout";

const paths = (ws: Workspace) => panes(ws.root).map((p) => p.tabs.map((t) => t.path));
const root = (ws: Workspace) => ws.root as SplitNode;

/** A workspace with tabs "/a", "/b" in one pane. */
function two() {
  const ws = openTab(initialWorkspace("/a"), "/b");
  const [a, b] = panes(ws.root)[0].tabs;
  return { ws, a, b };
}

describe("initialWorkspace / queries", () => {
  it("starts with one pane holding one active tab, the collections overview by default", () => {
    const ws = initialWorkspace();
    expect(ws.root.kind).toBe("pane");
    expect(paths(ws)).toEqual([[HOME]]);
    expect(activeTab(ws)?.path).toBe(HOME);
    expect(ws.activePaneId).toBe(ws.root.id);
  });

  it("activePane falls back to the first pane when the active id is stale", () => {
    const ws = { ...initialWorkspace(), activePaneId: "gone" };
    expect(activePane(ws)).toBe(panes(ws.root)[0]);
  });

  it("activeTab falls back to the first tab, and is undefined for an empty pane", () => {
    const { ws, a } = two();
    const stale = { ...ws, root: { ...(ws.root as object), activeTabId: "gone" } as LayoutNode };
    expect(activeTab(stale)?.id).toBe(a.id);
    const one = initialWorkspace();
    expect(activeTab(closeTab(one, activeTab(one)!.id))).toBeUndefined();
  });

  it("findPane / paneOfTab return undefined for unknown ids", () => {
    const { ws, a } = two();
    expect(findPane(ws, "nope")).toBeUndefined();
    expect(paneOfTab(ws, "nope")).toBeUndefined();
    expect(paneOfTab(ws, a.id)?.id).toBe(ws.root.id);
  });
});

describe("openTab / focusTab / navigateActive / setTabPath", () => {
  it("opens a tab in the active pane and focuses it", () => {
    const { ws, b } = two();
    expect(paths(ws)).toEqual([["/a", "/b"]]);
    expect(activeTab(ws)?.id).toBe(b.id);
  });

  it("falls back to the active pane for an unknown pane", () => {
    expect(paths(openTab(two().ws, "/c", "unknown"))).toEqual([["/a", "/b", "/c"]]);
  });

  it("focusTab activates the tab and its pane; unknown tabs change nothing", () => {
    const { ws, a } = two();
    expect(activeTab(focusTab(ws, a.id))?.id).toBe(a.id);
    expect(focusTab(ws, "nope")).toBe(ws);
  });

  it("navigateActive changes the active tab's path and bumps nav so the router reloads", () => {
    const { ws, b } = two();
    const next = navigateActive(ws, "/z");
    expect(paths(next)).toEqual([["/a", "/z"]]);
    expect(activeTab(next)).toMatchObject({ id: b.id, path: "/z", nav: b.nav + 1 });
  });

  it("navigateActive opens a tab when nothing is open", () => {
    const ws = initialWorkspace();
    const empty = closeTab(ws, activeTab(ws)!.id);
    const next = navigateActive(empty, "/z");
    expect(paths(next)).toEqual([["/z"]]);
    expect(activeTab(next)?.nav).toBe(0);
  });

  it("setTabPath records the path without bumping nav", () => {
    const { ws, b } = two();
    const next = setTabPath(ws, b.id, "/inside");
    expect(activeTab(next)).toMatchObject({ path: "/inside", nav: b.nav });
    expect(setTabPath(ws, "nope", "/x")).toBe(ws);
  });
});

describe("closeTab", () => {
  it("activates the neighbour that takes its place, or the previous one at the end", () => {
    let ws = openTab(openTab(initialWorkspace("/a"), "/b"), "/c");
    const [a, b, c] = panes(ws.root)[0].tabs;
    ws = focusTab(ws, b.id);
    expect(activeTab(closeTab(ws, b.id))?.id).toBe(c.id);
    ws = focusTab(ws, c.id);
    expect(activeTab(closeTab(ws, c.id))?.id).toBe(b.id);
    expect(activeTab(closeTab(ws, a.id))?.id).toBe(c.id); // closing another tab keeps focus
  });

  it("closing the last tab leaves one empty pane", () => {
    const ws = initialWorkspace();
    const empty = closeTab(ws, activeTab(ws)!.id);
    expect(panes(empty.root)).toHaveLength(1);
    expect(panes(empty.root)[0].tabs).toEqual([]);
    expect(empty.activePaneId).toBe(panes(empty.root)[0].id);
  });

  it("unknown tab: nothing changes", () => {
    const { ws } = two();
    expect(closeTab(ws, "nope")).toBe(ws);
  });

  it("closing the only tab of a split pane unwraps the split", () => {
    const { ws, b } = two();
    const split = moveTab(ws, b.id, ws.root.id, "right");
    expect(root(split).kind).toBe("split");
    const closed = closeTab(split, b.id);
    expect(closed.root.kind).toBe("pane");
    expect(paths(closed)).toEqual([["/a"]]);
  });
});

describe("moveTab", () => {
  it("center of its own pane just focuses the tab", () => {
    const { ws, a } = two();
    const next = moveTab(ws, a.id, ws.root.id, "center");
    expect(paths(next)).toEqual([["/a", "/b"]]);
    expect(activeTab(next)?.id).toBe(a.id);
  });

  it("a pane cannot be split by its own only tab", () => {
    const ws = initialWorkspace("/a");
    expect(moveTab(ws, activeTab(ws)!.id, ws.root.id, "left")).toBe(ws);
  });

  it("unknown tab or target: nothing changes", () => {
    const { ws, a } = two();
    expect(moveTab(ws, "nope", ws.root.id, "center")).toBe(ws);
    expect(moveTab(ws, a.id, "nope", "center")).toBe(ws);
  });

  it("dropping on a side splits: left/top go before, right/bottom after; the new pane is active", () => {
    const { ws, a, b } = two();
    const left = moveTab(ws, b.id, ws.root.id, "left");
    expect(root(left)).toMatchObject({ kind: "split", direction: "row", sizes: [0.5, 0.5] });
    expect(paths(left)).toEqual([["/b"], ["/a"]]);
    expect(activePane(left).tabs[0].id).toBe(b.id);

    const bottom = moveTab(ws, a.id, ws.root.id, "bottom");
    expect(root(bottom).direction).toBe("column");
    expect(paths(bottom)).toEqual([["/b"], ["/a"]]);

    expect(paths(moveTab(ws, a.id, ws.root.id, "top"))).toEqual([["/a"], ["/b"]]);
    expect(paths(moveTab(ws, a.id, ws.root.id, "right"))).toEqual([["/b"], ["/a"]]);
  });

  it("center onto another pane moves the tab there; the emptied pane disappears", () => {
    const { ws, b } = two();
    const split = moveTab(ws, b.id, ws.root.id, "right");
    const [pa, pb] = panes(split.root);
    const back = moveTab(split, b.id, pa.id, "center");
    expect(back.root.kind).toBe("pane");
    expect(paths(back)).toEqual([["/a", "/b"]]);
    expect(activeTab(back)?.id).toBe(b.id);
    expect(findPane(back, pb.id)).toBeUndefined();
  });

  it("when the moved tab was the source's active tab, the source activates a remaining tab", () => {
    let ws = openTab(openTab(initialWorkspace("/a"), "/b"), "/c");
    const [a, , c] = panes(ws.root)[0].tabs;
    ws = moveTab(ws, c.id, ws.root.id, "right");
    const source = panes(ws.root)[0];
    expect(source.tabs.map((t) => t.id)).toContain(source.activeTabId);
    expect(source.activeTabId).toBe(a.id);
  });

  it("splitting a pane inside a same-direction split flattens it and keeps sizes summing to 1", () => {
    const { ws, b } = two();
    let split = moveTab(ws, b.id, ws.root.id, "right"); // [a] [b]
    const left = panes(split.root)[0];
    split = openTab(split, "/c", left.id);
    const c = panes(split.root)[0].tabs[1];
    const three = moveTab(split, c.id, left.id, "right");
    expect(root(three).children).toHaveLength(3);
    expect(root(three).children.every((n) => n.kind === "pane")).toBe(true);
    expect(root(three).sizes.reduce((x, y) => x + y, 0)).toBeCloseTo(1);
    expect(root(three).sizes).toEqual([0.25, 0.25, 0.5]);
  });
});

describe("topPanes", () => {
  it("lists every pane of a row but only the uppermost of a column", () => {
    const { ws, b } = two();
    const row = moveTab(ws, b.id, ws.root.id, "right");
    expect(topPanes(row.root)).toHaveLength(2);
    const col = moveTab(ws, b.id, ws.root.id, "bottom");
    expect(topPanes(col.root).map((p) => p.tabs[0].path)).toEqual(["/a"]);
    expect(topPanes(ws.root)).toHaveLength(1);
  });
});

describe("openBeside", () => {
  it("splits to the right when there is no neighbour, keeping the source pane active", () => {
    const ws = initialWorkspace("/list");
    const next = openBeside(ws, ws.root.id, "/item1");
    expect(root(next).direction).toBe("row");
    expect(paths(next)).toEqual([["/list"], ["/item1"]]);
    expect(next.activePaneId).toBe(ws.root.id);
  });

  it("reuses the pane to the right on the next call (navigating its tab, nav bumped)", () => {
    const ws = initialWorkspace("/list");
    const once = openBeside(ws, ws.root.id, "/item1");
    const twice = openBeside(once, ws.root.id, "/item2");
    expect(paths(twice)).toEqual([["/list"], ["/item2"]]);
    expect(panes(twice.root)[1].tabs[0].nav).toBe(1);
    expect(panes(twice.root)).toHaveLength(2);
  });

  it("from the rightmost pane it splits again", () => {
    const ws = initialWorkspace("/list");
    const once = openBeside(ws, ws.root.id, "/item1");
    const again = openBeside(once, panes(once.root)[1].id, "/more");
    expect(paths(again)).toEqual([["/list"], ["/item1"], ["/more"]]);
  });

  it("a pane stacked in a column uses the neighbour of the whole column", () => {
    const ws = initialWorkspace("/list");
    const once = openBeside(ws, ws.root.id, "/item1"); // [list] [item1]
    const left = panes(once.root)[0];
    const withX = openTab(once, "/x", left.id);
    const x = panes(withX.root)[0].tabs[1];
    const stacked = moveTab(withX, x.id, left.id, "bottom"); // [list / x] [item1]
    const top = panes(stacked.root)[0];
    const next = openBeside(stacked, top.id, "/y");
    expect(paths(next)).toEqual([["/list"], ["/x"], ["/y"]]);
  });
});

describe("resizeSplit", () => {
  it("sets the sizes of the split only", () => {
    const { ws, b } = two();
    const split = moveTab(ws, b.id, ws.root.id, "right");
    const resized = resizeSplit(split, split.root.id, [0.3, 0.7]);
    expect(root(resized).sizes).toEqual([0.3, 0.7]);
    expect(resizeSplit(split, panes(split.root)[0].id, [1]).root).toEqual(split.root); // a pane has no sizes
  });
});

describe("restoreWorkspace", () => {
  it("round-trips a stored workspace through JSON", () => {
    const { ws, b } = two();
    const split = moveTab(ws, b.id, ws.root.id, "right");
    expect(restoreWorkspace(JSON.parse(JSON.stringify(split)))).toEqual(split);
  });

  it("falls back to a fresh workspace for garbage", () => {
    const garbage = [
      null,
      undefined,
      42,
      {},
      { root: null },
      { root: { kind: "pane", id: "p" } },
      { root: { kind: "pane", id: "p", tabs: [{ id: 1, path: "/" }] } },
      { root: { kind: "other", id: "p" } },
      { root: { kind: "split", id: "s", children: [], sizes: [1] } },
    ];
    for (const raw of garbage) expect(paths(restoreWorkspace(raw))).toEqual([[HOME]]);
  });

  it("repairs a stored layout: empty panes dropped, stale active pane replaced", () => {
    const raw = {
      activePaneId: "gone",
      root: {
        kind: "split",
        id: "s",
        direction: "row",
        sizes: [0.5, 0.5],
        children: [
          { kind: "pane", id: "p1", tabs: [], activeTabId: "" },
          { kind: "pane", id: "p2", tabs: [{ id: "t", path: "/x", nav: 0 }], activeTabId: "t" },
        ],
      },
    };
    const ws = restoreWorkspace(raw);
    expect(ws.root.kind).toBe("pane");
    expect(ws.activePaneId).toBe("p2");
    expect(paths(ws)).toEqual([["/x"]]);
  });

  it("a stored workspace with no tabs stays empty rather than inventing one", () => {
    const ws = restoreWorkspace({ activePaneId: "p", root: { kind: "pane", id: "p", tabs: [], activeTabId: "" } });
    expect(paths(ws)).toEqual([[]]);
  });
});
