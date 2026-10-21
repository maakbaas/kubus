// The workspace layout: a tree of panes (each with tabs) and splits. Pure data and pure
// functions only; the UI (Workspace.tsx) renders it and calls these to change it.

import { newId } from "../domain/model";

export interface WorkspaceTab {
  id: string;
  /** App route shown in the tab, e.g. "/types/<id>/objects". */
  path: string;
  /** Bumped when the tab is navigated from outside (side nav, search), to reload its router. */
  nav: number;
}

export interface PaneNode {
  kind: "pane";
  id: string;
  tabs: WorkspaceTab[];
  activeTabId: string;
}

export interface SplitNode {
  kind: "split";
  id: string;
  /** "row": children side by side; "column": stacked. */
  direction: "row" | "column";
  children: LayoutNode[];
  /** Relative sizes of the children (fractions summing to 1). */
  sizes: number[];
}

export type LayoutNode = PaneNode | SplitNode;

export interface Workspace {
  root: LayoutNode;
  /** The pane that receives navigation from the side nav and search. */
  activePaneId: string;
}

/** Where a dragged tab is dropped on a pane. */
export type DropZone = "center" | "left" | "right" | "top" | "bottom";

export const HOME = "/types";

export const newTab = (path = HOME): WorkspaceTab => ({ id: newId(), path, nav: 0 });

/** A pane with no tabs: what remains when every tab is closed. */
const emptyPane = (): PaneNode => ({ kind: "pane", id: newId(), tabs: [], activeTabId: "" });

/** First launch: one tab with the types overview. */
export function initialWorkspace(path = HOME): Workspace {
  const tab = newTab(path);
  const pane: PaneNode = { kind: "pane", id: newId(), tabs: [tab], activeTabId: tab.id };
  return { root: pane, activePaneId: pane.id };
}

// --- Queries ---------------------------------------------------------------------------

export function panes(node: LayoutNode): PaneNode[] {
  return node.kind === "pane" ? [node] : node.children.flatMap(panes);
}

/** The panes along the layout's top edge (in a stack, only the uppermost child reaches it). */
export function topPanes(node: LayoutNode): PaneNode[] {
  if (node.kind === "pane") return [node];
  return node.direction === "row" ? node.children.flatMap(topPanes) : topPanes(node.children[0]);
}

export const findPane = (ws: Workspace, paneId: string) => panes(ws.root).find((p) => p.id === paneId);

export const paneOfTab = (ws: Workspace, tabId: string) => panes(ws.root).find((p) => p.tabs.some((t) => t.id === tabId));

export function activePane(ws: Workspace): PaneNode {
  return findPane(ws, ws.activePaneId) ?? panes(ws.root)[0];
}

/** The active pane's active tab; undefined when nothing is open. */
export function activeTab(ws: Workspace): WorkspaceTab | undefined {
  const pane = activePane(ws);
  return pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0];
}

// --- Tree helpers ----------------------------------------------------------------------

/** Replaces the node with `id` by the result of `fn` (or removes it when fn returns null). */
function mapNode(node: LayoutNode, id: string, fn: (n: LayoutNode) => LayoutNode | null): LayoutNode | null {
  if (node.id === id) return fn(node);
  if (node.kind === "pane") return node;
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const next = mapNode(child, id, fn);
    if (next) {
      children.push(next);
      sizes.push(node.sizes[i]);
    }
  });
  return { ...node, children, sizes };
}

const updatePane = (ws: Workspace, paneId: string, fn: (p: PaneNode) => PaneNode): Workspace => ({
  ...ws,
  root: mapNode(ws.root, paneId, (n) => (n.kind === "pane" ? fn(n) : n)) ?? ws.root,
});

/** Drops empty panes, unwraps single-child splits, merges same-direction nested splits. */
function normalize(node: LayoutNode | null): LayoutNode | null {
  if (!node) return null;
  if (node.kind === "pane") return node.tabs.length ? node : null;
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const n = normalize(child);
    if (!n) return;
    if (n.kind === "split" && n.direction === node.direction) {
      n.children.forEach((c, j) => {
        children.push(c);
        sizes.push(node.sizes[i] * n.sizes[j]);
      });
    } else {
      children.push(n);
      sizes.push(node.sizes[i]);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return { ...node, children, sizes: sizes.map((s) => s / total) };
}

function finish(ws: Workspace, root: LayoutNode | null): Workspace {
  // Every tab closed: keep a single empty pane (the workspace may be empty).
  const normalized = normalize(root) ?? emptyPane();
  const ids = panes(normalized).map((p) => p.id);
  return { root: normalized, activePaneId: ids.includes(ws.activePaneId) ? ws.activePaneId : ids[0] };
}

// --- Operations ------------------------------------------------------------------------

export function focusTab(ws: Workspace, tabId: string): Workspace {
  const pane = paneOfTab(ws, tabId);
  if (!pane) return ws;
  return { ...updatePane(ws, pane.id, (p) => ({ ...p, activeTabId: tabId })), activePaneId: pane.id };
}

/** Opens a path in a new tab of the active pane (or of `paneId`) and focuses it. */
export function openTab(ws: Workspace, path: string, paneId = ws.activePaneId): Workspace {
  const tab = newTab(path);
  const target = findPane(ws, paneId) ?? activePane(ws);
  return { ...updatePane(ws, target.id, (p) => ({ ...p, tabs: [...p.tabs, tab], activeTabId: tab.id })), activePaneId: target.id };
}

/** Navigates the active tab to a path (from outside the tab, e.g. the side nav). */
export function navigateActive(ws: Workspace, path: string): Workspace {
  const pane = activePane(ws);
  if (pane.tabs.length === 0) return openTab(ws, path, pane.id); // nothing open: open it
  return updatePane(ws, pane.id, (p) => ({
    ...p,
    tabs: p.tabs.map((t) => (t.id === p.activeTabId ? { ...t, path, nav: t.nav + 1 } : t)),
  }));
}

/** Records a navigation that happened inside a tab (no router reload). */
export function setTabPath(ws: Workspace, tabId: string, path: string): Workspace {
  const pane = paneOfTab(ws, tabId);
  if (!pane) return ws;
  return updatePane(ws, pane.id, (p) => ({ ...p, tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, path } : t)) }));
}

export function closeTab(ws: Workspace, tabId: string): Workspace {
  const pane = paneOfTab(ws, tabId);
  if (!pane) return ws;
  const index = pane.tabs.findIndex((t) => t.id === tabId);
  const tabs = pane.tabs.filter((t) => t.id !== tabId);
  const activeTabId = pane.activeTabId === tabId ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? "") : pane.activeTabId;
  return finish(ws, mapNode(ws.root, pane.id, () => ({ ...pane, tabs, activeTabId })));
}

/** Moves a tab onto a pane: into its tab list ("center") or into a new pane beside it. */
export function moveTab(ws: Workspace, tabId: string, targetPaneId: string, zone: DropZone): Workspace {
  const source = paneOfTab(ws, tabId);
  const target = findPane(ws, targetPaneId);
  if (!source || !target) return ws;
  if (zone === "center" && source.id === target.id) return focusTab(ws, tabId);
  // A pane can't be split by its own only tab.
  if (zone !== "center" && source.id === target.id && source.tabs.length === 1) return ws;
  const tab = source.tabs.find((t) => t.id === tabId)!;

  // Take the tab out of its pane.
  const sourceTabs = source.tabs.filter((t) => t.id !== tabId);
  let root = mapNode(ws.root, source.id, () => ({
    ...source,
    tabs: sourceTabs,
    activeTabId: source.activeTabId === tabId ? (sourceTabs[0]?.id ?? "") : source.activeTabId,
  }))!;

  let activePaneId: string;
  if (zone === "center") {
    root = mapNode(root, target.id, (n) => {
      const p = n as PaneNode;
      return { ...p, tabs: [...p.tabs, tab], activeTabId: tab.id };
    })!;
    activePaneId = target.id;
  } else {
    const pane: PaneNode = { kind: "pane", id: newId(), tabs: [tab], activeTabId: tab.id };
    const direction = zone === "left" || zone === "right" ? "row" : "column";
    const before = zone === "left" || zone === "top";
    root = mapNode(root, target.id, (n) => ({
      kind: "split",
      id: newId(),
      direction,
      children: before ? [pane, n] : [n, pane],
      sizes: [0.5, 0.5],
    }))!;
    activePaneId = pane.id;
  }
  return finish({ ...ws, activePaneId }, root);
}

/** The pane directly right of `paneId` in the nearest row split, if any. */
function rightNeighbour(node: LayoutNode, paneId: string): PaneNode | null {
  if (node.kind === "pane") return null;
  const i = node.children.findIndex((c) => panes(c).some((p) => p.id === paneId));
  if (i < 0) return null;
  const nested = rightNeighbour(node.children[i], paneId);
  if (nested) return nested;
  return node.direction === "row" && i < node.children.length - 1 ? panes(node.children[i + 1])[0] : null;
}

/**
 * Opens a related item next to `sourcePaneId`: in the pane to its right (reusing it, so
 * clicking through a list doesn't keep splitting), or in a new pane split off to the right.
 * The source pane stays active, so the user can keep browsing it.
 */
export function openBeside(ws: Workspace, sourcePaneId: string, path: string): Workspace {
  const right = rightNeighbour(ws.root, sourcePaneId);
  if (right) {
    return updatePane(ws, right.id, (p) => ({
      ...p,
      tabs: p.tabs.map((t) => (t.id === p.activeTabId ? { ...t, path, nav: t.nav + 1 } : t)),
    }));
  }
  const tab = newTab(path);
  const pane: PaneNode = { kind: "pane", id: newId(), tabs: [tab], activeTabId: tab.id };
  const root = mapNode(ws.root, sourcePaneId, (n) => ({ kind: "split", id: newId(), direction: "row", children: [n, pane], sizes: [0.5, 0.5] }));
  return finish(ws, root);
}

export function resizeSplit(ws: Workspace, splitId: string, sizes: number[]): Workspace {
  return { ...ws, root: mapNode(ws.root, splitId, (n) => (n.kind === "split" ? { ...n, sizes } : n)) ?? ws.root };
}

/** Validates a stored workspace (e.g. from localStorage); falls back to a fresh one. */
export function restoreWorkspace(raw: unknown): Workspace {
  const valid = (n: unknown): n is LayoutNode => {
    const node = n as LayoutNode;
    if (!node || typeof node.id !== "string") return false;
    if (node.kind === "pane") return Array.isArray(node.tabs) && node.tabs.every((t) => typeof t.id === "string" && typeof t.path === "string");
    if (node.kind === "split") return Array.isArray(node.children) && node.children.every(valid) && node.sizes?.length === node.children.length;
    return false;
  };
  const ws = raw as Workspace;
  if (!ws || !valid(ws.root)) return initialWorkspace();
  return finish(ws, ws.root);
}
