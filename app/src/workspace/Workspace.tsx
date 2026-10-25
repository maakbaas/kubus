import {
  createContext,
  Fragment,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { MemoryRouter, useLocation, useNavigate, useNavigationType } from "react-router";
import { IconButton, Link, Tab, TabList, Tabs } from "@carbon/react";
import { Add } from "@carbon/icons-react";
import { TabMenu, occupied, useClippedTabs } from "../ui/TabMenu";
import { AppRoutes } from "../app/routes";
import { readPref, writePref } from "../ui/localPrefs";
import { useMediaQuery } from "../ui/useMediaQuery";
import {
  activeTab,
  closeTab,
  focusTab,
  HOME,
  moveTab,
  navigateActive,
  openBeside,
  openTab,
  paneOfTab,
  panes,
  resizeSplit,
  topPanes,
  restoreWorkspace,
  setTabPath,
  type DropZone,
  type LayoutNode,
  type PaneNode,
  type SplitNode,
  type Workspace,
  type WorkspaceTab,
} from "./layout";

// The workspace: tabs in panes, panes tiled by dragging tabs onto each other's edges.
// Each tab runs the app's routes in its own MemoryRouter, so navigation stays in the tab.
// In-app links (href="#/...") are intercepted: plain click = this tab, Ctrl/Cmd/middle click =
// new tab. Links outside tabs (side nav, header) go to the active tab.

/** Each space remembers its own tabs (per device). */
const storageKey = (spaceId: string) => `kubus.workspace.${spaceId}`;
const TAB_MIME = "application/x-kubus-tab";

/** What changes the workspace: stable for its lifetime, so using it re-renders nothing. */
interface WorkspaceActions {
  /** Navigates the active tab. */
  navigate(path: string): void;
  /** Opens a path in a new tab of the active pane. */
  openTab(path: string): void;
  update(fn: (ws: Workspace) => Workspace): void;
  setTitle(tabId: string, title: string): void;
  /** A tab's back/forward; returns an unregister function. */
  registerHistory(tabId: string, history: TabHistory): () => void;
}

interface WorkspaceApi extends WorkspaceActions {
  workspace: Workspace;
  /** Route of the active tab (for the side nav's active state and search box). */
  activePath: string;
  titles: Record<string, string>;
}

interface TabHistory {
  back(): void;
  forward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
}

const WorkspaceContext = createContext<WorkspaceApi | null>(null);
/**
 * The actions alone, for pages (titles, opening related items): they don't re-render when
 * another tab is focused, moved or renamed, as users of the whole workspace do.
 */
const WorkspaceActionsContext = createContext<WorkspaceActions | null>(null);
/** The id of the tab a component is rendered in (null outside tabs). */
const TabIdContext = createContext<string | null>(null);
/** What starts the top-left pane's tab strip (the side nav toggle; see WorkspaceView). */
const TabStripStartContext = createContext<ReactNode>(null);
const TabStripEndContext = createContext<ReactNode>(null);

export function useWorkspace(): WorkspaceApi {
  const ws = useContext(WorkspaceContext);
  if (!ws) throw new Error("useWorkspace outside WorkspaceProvider");
  return ws;
}

/** Pages report their title (e.g. from the page header) so their tab can show it. */
export function useTabTitle(title: string | undefined) {
  const tabId = useContext(TabIdContext);
  const ws = useContext(WorkspaceActionsContext);
  useEffect(() => {
    if (tabId && ws && title) ws.setTitle(tabId, title);
  }, [tabId, ws, title]);
}

/** Windows at least this wide have room to open related items beside (in a split to the right). */
const WIDE = "(min-width: 72rem)";

/** Where to open a related item: this tab, a pane beside it, or a new tab. */
export type OpenMode = "here" | "beside" | "tab";

/** Plain click = here, Ctrl/Cmd click = beside, middle click = new tab. */
export function openModeOf(e: { ctrlKey: boolean; metaKey: boolean; button: number }): OpenMode {
  if (e.button === 1) return "tab";
  return e.ctrlKey || e.metaKey ? "beside" : "here";
}

/**
 * Opens a related item (an item from a list, a referenced item) in this tab, beside the
 * current pane (narrow windows have no room: a new tab instead), or in a new tab.
 */
export function useOpenRelated(): (path: string, mode?: OpenMode) => void {
  const tabId = useContext(TabIdContext);
  const ws = useContext(WorkspaceActionsContext);
  const navigate = useNavigate();
  const wide = useMediaQuery(WIDE);
  return (path, mode = "here") => {
    if (!ws || !tabId || mode === "here") return navigate(path);
    if (mode === "tab" || !wide) return ws.openTab(path);
    ws.update((w) => {
      const pane = paneOfTab(w, tabId);
      return pane ? openBeside(w, pane.id, path) : w;
    });
  };
}

/** A back / forward swipe starts this close to the screen's edge (px) and travels at least this far. */
const SWIPE_EDGE = 24;
const SWIPE_DISTANCE = 64;

/** The tabs of one space; remount it (key) for another space. */
export function WorkspaceProvider({ spaceId, children }: { spaceId: string; children: ReactNode }) {
  const [workspace, setWorkspace] = useState<Workspace>(() => restoreWorkspace(readPref<unknown>(storageKey(spaceId), null)));
  const [titles, setTitles] = useState<Record<string, string>>({});

  // Per-device convenience: remember the layout (best effort).
  useEffect(() => writePref(storageKey(spaceId), workspace), [spaceId, workspace]);

  const update = useCallback((fn: (ws: Workspace) => Workspace) => setWorkspace(fn), []);

  // Back / forward for the active tab: mouse back/forward buttons, Alt+←/→, the browser-back key,
  // and, on touch screens, swipes in from the edges.
  const histories = useRef(new Map<string, TabHistory>());
  const registerHistory = useCallback((tabId: string, history: TabHistory) => {
    histories.current.set(tabId, history);
    return () => {
      if (histories.current.get(tabId) === history) histories.current.delete(tabId);
    };
  }, []);
  const current = useRef(workspace);
  current.current = workspace;
  useEffect(() => {
    const activeHistory = () => {
      const tab = activeTab(current.current);
      return tab ? histories.current.get(tab.id) : undefined;
    };
    const go = (direction: "back" | "forward") => activeHistory()?.[direction]();
    const onMouseUp = (e: globalThis.MouseEvent) => {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
        go(e.button === 3 ? "back" : "forward");
      }
    };
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      const back = e.key === "BrowserBack" || (e.altKey && e.key === "ArrowLeft");
      const forward = e.key === "BrowserForward" || (e.altKey && e.key === "ArrowRight");
      if (!back && !forward) return;
      e.preventDefault();
      go(back ? "back" : "forward");
    };
    // Touch screens: a swipe in from the left edge is back, from the right edge forward (the
    // tab's own history, like the mouse buttons). Only from the edge: elsewhere horizontal swipes
    // scroll (tab strips, wide tables).
    let swipe: { x: number; y: number; direction: "back" | "forward" } | null = null;
    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      swipe = null;
      if (e.touches.length !== 1) return;
      const direction = t.clientX <= SWIPE_EDGE ? "back" : t.clientX >= window.innerWidth - SWIPE_EDGE ? "forward" : null;
      if (direction) swipe = { x: t.clientX, y: t.clientY, direction };
    };
    const onTouchEnd = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      if (!swipe || !t) return;
      const dx = (t.clientX - swipe.x) * (swipe.direction === "back" ? 1 : -1);
      const dy = Math.abs(t.clientY - swipe.y);
      if (dx >= SWIPE_DISTANCE && dy < dx / 2) go(swipe.direction);
      swipe = null;
    };
    const onTouchCancel = () => {
      swipe = null;
    };
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchCancel, { passive: true });
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchCancel);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
  const setTitle = useCallback(
    (tabId: string, title: string) => setTitles((t) => (t[tabId] === title ? t : { ...t, [tabId]: title })),
    [],
  );
  const actions = useMemo<WorkspaceActions>(
    () => ({
      navigate: (path) => update((ws) => navigateActive(ws, path)),
      openTab: (path) => update((ws) => openTab(ws, path)),
      update,
      setTitle,
      registerHistory,
    }),
    [update, setTitle, registerHistory],
  );
  const api = useMemo<WorkspaceApi>(
    () => ({ ...actions, workspace, activePath: activeTab(workspace)?.path ?? "", titles }),
    [actions, workspace, titles],
  );
  return (
    <WorkspaceActionsContext.Provider value={actions}>
      <WorkspaceContext.Provider value={api}>{children}</WorkspaceContext.Provider>
    </WorkspaceActionsContext.Provider>
  );
}

/** Intercepts in-app links (href="#/...") inside `children`. */
function InAppLinks({ onNavigate, children }: { onNavigate(path: string, newTab: boolean): void; children: ReactNode }) {
  const handle = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#/"]');
    // Links marked data-own-click handle navigation themselves (e.g. "open beside").
    if (!a || a.hasAttribute("data-own-click") || (e.type === "click" && e.button !== 0)) return;
    e.preventDefault();
    e.stopPropagation();
    onNavigate(a.getAttribute("href")!.slice(1), e.ctrlKey || e.metaKey || e.button === 1);
  };
  return (
    <div className="ws-links" onClickCapture={handle} onAuxClickCapture={handle}>
      {children}
    </div>
  );
}

/** Routes links outside tabs (side nav, header) to the active tab. */
export function GlobalLinks({ children }: { children: ReactNode }) {
  const ws = useWorkspace();
  return <InAppLinks onNavigate={(path, newTab) => (newTab ? ws.openTab(path) : ws.navigate(path))}>{children}</InAppLinks>;
}

/** Keeps the workspace informed about navigation inside a tab, and routes its links. */
function TabRouterBridge({ tab }: { tab: WorkspaceTab }) {
  const ws = useContext(WorkspaceActionsContext)!;
  const { update, registerHistory } = ws;
  const location = useLocation();
  const navigate = useNavigate();
  const path = location.pathname + location.search;
  const tabPath = useRef(tab.path);
  tabPath.current = tab.path;

  // Navigation from outside the tab (side nav, search): push it onto this tab's history
  // (search typing replaces, so each keystroke isn't a history item).
  const seenNav = useRef(tab.nav);
  useEffect(() => {
    if (tab.nav === seenNav.current) return;
    seenNav.current = tab.nav;
    if (tab.path !== path) navigate(tab.path, { replace: path.startsWith("/search") && tab.path.startsWith("/search") });
    // Only when the tab is navigated from outside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.nav]);

  // Navigation inside the tab: tell the workspace (title, side nav state, saved layout).
  useEffect(() => {
    if (path !== tabPath.current) update((w) => setTabPath(w, tab.id, path));
  }, [path, tab.id, update]);

  // Back / forward (mouse buttons, Alt+arrows) act on the active tab's history.
  // Which entries the tab's history holds is tracked by location key (a memory history can't be asked).
  const navCollection = useNavigationType();
  const keys = useRef({ list: [location.key], at: 0 });
  const k = keys.current;
  if (k.list[k.at] !== location.key) {
    if (navCollection === "PUSH") {
      k.list.splice(k.at + 1, Infinity, location.key);
      k.at += 1;
    } else if (navCollection === "REPLACE") {
      k.list[k.at] = location.key;
    } else if (k.list.includes(location.key)) {
      k.at = k.list.indexOf(location.key);
    }
  }
  useEffect(
    () =>
      registerHistory(tab.id, {
        back: () => navigate(-1),
        forward: () => navigate(1),
        canGoBack: () => keys.current.at > 0,
        canGoForward: () => keys.current.at < keys.current.list.length - 1,
      }),
    [registerHistory, tab.id, navigate],
  );

  return (
    <InAppLinks onNavigate={(to, newTab) => (newTab ? ws.openTab(to) : navigate(to))}>
      <AppRoutes />
    </InAppLinks>
  );
}

/** A tab's page; only re-rendered when that tab itself changes (not when others do). */
const TabContent = memo(function TabContent({ tab }: { tab: WorkspaceTab }) {
  return (
    <TabIdContext.Provider value={tab.id}>
      {/* Remounted (fresh router) only when navigated from outside the tab. */}
      {/* One router (and history) for the tab's lifetime; outside navigation is pushed into it. */}
      <MemoryRouter initialEntries={[tab.path]}>
        <TabRouterBridge tab={tab} />
      </MemoryRouter>
    </TabIdContext.Provider>
  );
});

/** Which drop zone the pointer is in: the outer quarter of each edge splits, the middle merges. */
function zoneAt(e: { clientX: number; clientY: number }, el: HTMLElement): DropZone {
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  const edge = Math.min(x, 1 - x, y, 1 - y);
  if (edge > 0.25) return "center";
  if (edge === x) return "left";
  if (edge === 1 - x) return "right";
  return edge === y ? "top" : "bottom";
}

function PaneView({ pane }: { pane: PaneNode }) {
  const ws = useWorkspace();
  const [zone, setZone] = useState<DropZone | null>(null);
  const active = ws.workspace.activePaneId === pane.id;
  const index = Math.max(0, pane.tabs.findIndex((t) => t.id === pane.activeTabId));
  const isTabDrag = (e: { dataTransfer: DataTransfer | null }) => !!e.dataTransfer?.types.includes(TAB_MIME);

  // The tabs' content is portalled in (see TabSlot), so React events from inside it don't pass
  // through this pane: clicks (making the pane active) and tab drags over it are listened for
  // on the DOM itself.
  const root = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  // Scrolled away from the top: a fade shows below the tab strip.
  const [scrolled, setScrolled] = useState(false);
  const tabBar = useRef<HTMLDivElement>(null);
  const latest = useRef({ ws, active, zone, paneId: pane.id });
  latest.current = { ws, active, zone, paneId: pane.id };
  const hasTabs = pane.tabs.length > 0;
  useEffect(() => {
    const el = root.current;
    const body = frame.current;
    if (!el || !body) return;
    const activate = () => {
      const { ws, active, paneId } = latest.current;
      if (!active) ws.update((w) => ({ ...w, activePaneId: paneId }));
    };
    const over = (e: globalThis.DragEvent) => {
      if (!isTabDrag(e)) return;
      e.preventDefault();
      setZone(zoneAt(e, body));
    };
    const leave = (e: globalThis.DragEvent) => !body.contains(e.relatedTarget as Node) && setZone(null);
    const drop = (e: globalThis.DragEvent) => {
      const tabId = e.dataTransfer?.getData(TAB_MIME);
      const { ws, zone, paneId } = latest.current;
      setZone(null);
      if (tabId) {
        e.preventDefault();
        ws.update((w) => moveTab(w, tabId, paneId, zone ?? "center"));
      }
    };
    el.addEventListener("pointerdown", activate, true);
    body.addEventListener("dragover", over);
    body.addEventListener("dragleave", leave);
    body.addEventListener("drop", drop);
    return () => {
      el.removeEventListener("pointerdown", activate, true);
      body.removeEventListener("dragover", over);
      body.removeEventListener("dragleave", leave);
      body.removeEventListener("drop", drop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasTabs]);

  // Tabs are cut (end in "…") only as far as needed, longest first: when they don't fit, the
  // longest are cut to one width, as wide as still lets all fit; shorter tabs keep their whole
  // label until the cut reaches them. A tab keeps at least its close button and 6rem of text (a
  // short name like "Locations" is never cut); when even that doesn't fit, the list scrolls. Flexbox would shrink every tab in proportion,
  // short ones included, so each tab gets its width set here.
  // A tab is also never wider than 80% of the room between the scroll buttons, so the active tab
  // fits whole with its neighbours peeking in on both sides.
  const tabTitles = pane.tabs.map((t) => ws.titles[t.id] ?? "").join("|");
  const activeTabId = pane.activeTabId;
  // Too many tabs even at their least width: some are clipped, a down arrow lists them all.
  // (Judged from each tab's least width, not the width it has now: a clipped bar shows its active tab whole.)
  const clippedTabs = useClippedTabs(tabBar, (item) => Number(item.dataset.least) || item.offsetWidth);
  useLayoutEffect(() => {
    const bar = tabBar.current;
    if (!bar) return;
    const fit = () => {
      const items = [...bar.querySelectorAll<HTMLElement>(".cds--tabs__nav-item")];
      const tabs = bar.querySelector<HTMLElement>(".cds--tabs");
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      // The room for tabs: the strip less what else it holds ("+", the menu arrow, ...). (Not the
      // tabs' own width: that is only as wide as its tabs, so a lone tab would cap itself.)
      const room = tabs ? bar.clientWidth - occupied(bar, tabs) : Infinity;
      // A tab is as wide as it would be alone in the strip: the menu arrow's room counts as free.
      const menu = bar.querySelector<HTMLElement>(".tab-menu");
      const menuRoom = menu ? menu.offsetWidth + parseFloat(getComputedStyle(menu).marginInlineStart) : 0;
      const cap = Math.min(16 * rem, (room + menuRoom) * 0.8);
      const sized = items.flatMap((item) => {
        const label = item.querySelector<HTMLElement>(".cds--tabs__nav-item-label");
        if (!label) return [];
        item.style.minInlineSize = "0";
        item.style.maxInlineSize = "none";
        const chrome = item.offsetWidth - label.clientWidth; // padding and close button
        const natural = Math.min(label.scrollWidth + chrome, cap);
        return [{ item, natural, least: Math.min(natural, chrome + 6 * rem) }];
      });
      // The cut: the widest width w with sum(min(natural, w)) <= the room (Infinity: all fit).
      let cut = Infinity;
      let rest = room;
      const naturals = sized.map((t) => t.natural).sort((x, y) => x - y);
      for (let i = 0; i < naturals.length; i++) {
        const share = rest / (naturals.length - i);
        if (naturals[i] > share) {
          cut = Math.floor(share);
          break;
        }
        rest -= naturals[i];
      }
      for (const { item, natural, least } of sized) {
        item.dataset.least = String(Math.ceil(least));
        item.style.flexShrink = "";
        if (clippedTabs) {
          // Clipped: the shown tab as wide as it would be alone, the others at their least.
          const shown = item.classList.contains("cds--tabs__nav-item--selected");
          const width = `${shown ? natural : least}px`;
          item.style.minInlineSize = width;
          item.style.maxInlineSize = shown ? `${cap}px` : width;
          // The shown tab takes its content's width, as when it is alone (the narrowed list is then
          // sized to it); squeezed to the measured width it would end in "…" by a fraction.
          if (shown) item.style.flexShrink = "0";
        } else if (natural <= cut) {
          // Not cut: at least its natural width, free to grow to the cap (a measurement a fraction
          // short, or made before the web font loaded, must not cut the label).
          item.style.minInlineSize = `${natural}px`;
          item.style.maxInlineSize = `${cap}px`;
        } else {
          const width = `${Math.max(cut, least)}px`;
          item.style.minInlineSize = width;
          item.style.maxInlineSize = width;
        }
      }
    };
    fit();
    // Labels widen once the web font is in: measure again.
    void document.fonts?.ready.then(fit);
    const observer = new ResizeObserver(fit);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [tabTitles, activeTabId, clippedTabs]);

  const newTab = (
    <IconButton autoAlign label="New tab" kind="ghost" size="sm" align="bottom-end" onClick={() => ws.update((w) => openTab(w, HOME, pane.id))}>
      <Add />
    </IconButton>
  );
  // The side nav toggle starts the top-left pane's tab strip (mirroring "+" at the end). Phones
  // show only the active pane, so there it is in the active pane's strip instead.
  const stripStart = useContext(TabStripStartContext);
  const topLeft = panes(ws.workspace.root)[0]?.id === pane.id;
  /** Its tab strip is at the window's top edge (it then gets some room above the tabs). */
  const atTop = topPanes(ws.workspace.root).some((p) => p.id === pane.id);
  const lead =
    stripStart && (topLeft || active) ? (
      <span className={topLeft ? "ws-pane__lead" : "ws-pane__lead ws-pane__lead--phone"}>{stripStart}</span>
    ) : null;
  // The sync status ends the top-right strip, right of "+" (on phones: the active pane's strip).
  const stripEnd = useContext(TabStripEndContext);
  const topRight = topPanes(ws.workspace.root).at(-1)?.id === pane.id;
  const end =
    stripEnd && (topRight || active) ? (
      <span className={topRight ? "ws-pane__end" : "ws-pane__end ws-pane__end--phone"}>{stripEnd}</span>
    ) : null;

  if (pane.tabs.length === 0) {
    // Every tab was closed: an empty workspace, with a way back in.
    return (
      <div className="ws-pane ws-pane--active ws-pane--top">
        <div className="ws-pane__tabs ws-pane__tabs--empty">
          {lead}
          <span className="ws-pane__spacer" />
          {newTab}
          {end}
        </div>
        <div className="ws-pane__body ws-empty">
          <p className="helper">Pick a collection in the menu or{" "}
            <Link
              href="#"
              onClick={(e: React.MouseEvent) => {
                e.preventDefault();
                ws.update((w) => openTab(w, HOME, pane.id));
              }}
            >
              open a new tab
            </Link>
            .
          </p>
        </div>
      </div>
    );
  }

  return (
    <div ref={root} className={`ws-pane${active ? " ws-pane--active" : ""}${atTop ? " ws-pane--top" : ""}`}>
      <div
        ref={tabBar}
        className="ws-pane__tabs"
        onDragOver={(e) => isTabDrag(e) && e.preventDefault()}
        onDrop={(e) => {
          const tabId = e.dataTransfer.getData(TAB_MIME);
          if (tabId) ws.update((w) => moveTab(w, tabId, pane.id, "center"));
        }}
      >
        {lead}
        <Tabs
          selectedIndex={index}
          onChange={({ selectedIndex }) => ws.update((w) => focusTab(w, pane.tabs[selectedIndex].id))}
          dismissable
          onTabCloseRequest={(i) => ws.update((w) => closeTab(w, pane.tabs[i].id))}
        >
          <TabList aria-label="Open pages" contained>
            {pane.tabs.map((t) => (
              <Tab
                key={t.id}
                draggable
                onDragStart={(e: DragEvent) => e.dataTransfer.setData(TAB_MIME, t.id)}
                // Middle click closes the tab (as in browsers); suppress the middle-button autoscroll.
                onMouseDown={(e: MouseEvent) => e.button === 1 && e.preventDefault()}
                onAuxClick={(e: MouseEvent) => {
                  if (e.button !== 1) return;
                  e.preventDefault();
                  ws.update((w) => closeTab(w, t.id));
                }}
                title={ws.titles[t.id] ?? t.path}
              >
                {ws.titles[t.id] ?? "…"}
              </Tab>
            ))}
          </TabList>
        </Tabs>
        {clippedTabs && (
          <TabMenu
            label="Open pages"
            items={pane.tabs.map((t) => ({ id: t.id, name: ws.titles[t.id] ?? "…" }))}
            activeId={pane.activeTabId}
            onSelect={(id) => ws.update((w) => focusTab(w, id))}
          />
        )}
        {/* "+" takes the menu arrow's place; with the arrow it joins the icons at the right edge. */}
        {!clippedTabs && <span className="tab-menu">{newTab}</span>}
        <span className="views-bar__spacer" />
        {clippedTabs && newTab}
        {end}
      </div>
      {/* The drop highlight covers the whole pane body, scrollbar gutters included: it sits on
          this frame, outside the scrolling body. */}
      <div ref={frame} className="ws-pane__frame" data-scrolled={scrolled || undefined}>
        <div className="ws-pane__body" onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}>
          {pane.tabs.map((t) => (
            <TabSlot key={t.id} tabId={t.id} hidden={t.id !== pane.activeTabId} />
          ))}
        </div>
        {zone && <div className={`ws-drop ws-drop--${zone}`} aria-hidden="true" />}
      </div>
    </div>
  );
}

function SplitView({ split }: { split: SplitNode }) {
  const ws = useWorkspace();
  const container = useRef<HTMLDivElement>(null);

  /** Dragging the divider before child `i` moves size between children i-1 and i. */
  const startResize = (i: number) => (e: PointerEvent<HTMLDivElement>) => {
    const el = container.current;
    if (!el) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const total = split.direction === "row" ? rect.width : rect.height;
    const start = split.direction === "row" ? e.clientX : e.clientY;
    const initial = [...split.sizes];
    // Side by side, panes keep at least --pane-min-width (an iPhone 16's width).
    const minPx = split.direction === "row" ? parseFloat(getComputedStyle(el).getPropertyValue("--pane-min-width")) || 0 : 0;
    const min = Math.min(0.5, Math.max(0.1, minPx / total));
    const move = (ev: globalThis.PointerEvent) => {
      const delta = ((split.direction === "row" ? ev.clientX : ev.clientY) - start) / total;
      const a = Math.max(min, Math.min(initial[i - 1] + initial[i] - min, initial[i - 1] + delta));
      const sizes = [...initial];
      sizes[i - 1] = a;
      sizes[i] = initial[i - 1] + initial[i] - a;
      ws.update((w) => resizeSplit(w, split.id, sizes));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div ref={container} className={`ws-split ws-split--${split.direction}`}>
      {split.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && (
            <div
              className="ws-divider"
              role="separator"
              aria-orientation={split.direction === "row" ? "vertical" : "horizontal"}
              onPointerDown={startResize(i)}
              // Double click: the two neighbouring panes share their space equally again.
              onDoubleClick={() => {
                const sizes = [...split.sizes];
                sizes[i - 1] = sizes[i] = (split.sizes[i - 1] + split.sizes[i]) / 2;
                ws.update((w) => resizeSplit(w, split.id, sizes));
              }}
            />
          )}
          <div className="ws-split__child" style={{ flexGrow: split.sizes[i], flexBasis: 0 }}>
            <LayoutView node={child} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function LayoutView({ node }: { node: LayoutNode }) {
  return node.kind === "pane" ? <PaneView pane={node} /> : <SplitView split={node} />;
}

/**
 * Each tab's content lives in its own element for the tab's lifetime (rendered into it through
 * a portal from WorkspaceView); a pane only moves that element into its slot. So splitting a
 * pane, opening a tab beside or dragging a tab elsewhere, which changes the layout tree around
 * the panes, never remounts a tab: its page keeps its state and doesn't load (and flash) again.
 */
const tabHosts = new Map<string, HTMLDivElement>();
function tabHost(tabId: string): HTMLDivElement {
  let host = tabHosts.get(tabId);
  if (!host) {
    host = document.createElement("div");
    host.className = "ws-tab-content";
    tabHosts.set(tabId, host);
  }
  return host;
}

/** Where a pane shows one of its tabs: the tab's own element is moved in here. */
function TabSlot({ tabId, hidden }: { tabId: string; hidden: boolean }) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = tabHost(tabId);
    if (slot.current && host.parentNode !== slot.current) slot.current.appendChild(host);
  });
  return <div ref={slot} className="ws-tab-slot" hidden={hidden} />;
}

function tabsOf(node: LayoutNode): WorkspaceTab[] {
  return node.kind === "pane" ? node.tabs : node.children.flatMap(tabsOf);
}

/**
 * Renders the workspace layout; `tabStripStart` (the side nav toggle) leads the top-left tab strip,
 * `tabStripEnd` (the sync status) ends the top-right one.
 */
export function WorkspaceView({ tabStripStart, tabStripEnd }: { tabStripStart?: ReactNode; tabStripEnd?: ReactNode }) {
  const ws = useWorkspace();
  const tabs = tabsOf(ws.workspace.root);
  // Closed tabs drop their element.
  useEffect(() => {
    const open = new Set(tabs.map((t) => t.id));
    for (const [id, host] of tabHosts) {
      if (!open.has(id)) {
        host.remove();
        tabHosts.delete(id);
      }
    }
  });
  return (
    <div className="ws">
      <TabStripStartContext.Provider value={tabStripStart}>
        <TabStripEndContext.Provider value={tabStripEnd}>
          <LayoutView node={ws.workspace.root} />
        </TabStripEndContext.Provider>
      </TabStripStartContext.Provider>
      {tabs.map((t) => createPortal(<TabContent tab={t} />, tabHost(t.id), t.id))}
    </div>
  );
}

