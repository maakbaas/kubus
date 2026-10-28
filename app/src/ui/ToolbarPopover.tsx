import { useCallback, useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from "react";
import { IconButton, Popover, PopoverContent } from "@carbon/react";
import { keepFocusInView, onViewportChange, panelRoom, setRoom as applyRoom, sideOf, typingIn, type PanelSide } from "./panelRoom";

interface Props {
  label: string;
  icon: ComponentType;
  /** In effect (e.g. a filter or a sort other than the default): the icon turns blue. */
  active?: boolean;
  /** Size the panel to its content (e.g. a short list) instead of the settings width. */
  fit?: boolean;
  /** A panel narrower (settings with short inputs) or wider (rows of several inputs) than the usual width. */
  width?: "narrow" | "wide";
  /** Opens the panel whenever this changes to a new truthy value (e.g. after adding a view). */
  openRequest?: number;
  /** Told when the panel opens and closes (see usePanelsOpen). */
  onOpenChange?(open: boolean): void;
  /** Extra class on the button (e.g. a state colour). */
  className?: string;
  /** The panel's content; a function gets `close`, for a panel whose button leads elsewhere. */
  children: ReactNode | ((close: () => void) => ReactNode);
}

/** Dispatched (bubbling) from a toolbar popover when it opens. */
export const PANEL_OPENED = "kubus-panel-opened";
/** What a panel opens at the window level (a dialog, a menu, a date picker's calendar), which counts as part of it. */
export const WINDOW_LEVEL = ".cds--modal, .cds--menu, .flatpickr-calendar";

/**
 * Whether any of a page's toolbar panels is open (pass `onOpenChange` to each), and `hold`:
 * a value kept as it was while one is. A page holds what would move the panels' buttons (a bar
 * appearing above them, a button leaving the row), so an open panel never jumps; the change
 * shows once it closes.
 */
export function usePanelsOpen() {
  const [count, setCount] = useState(0);
  const onOpenChange = useCallback((open: boolean) => setCount((n) => Math.max(0, n + (open ? 1 : -1))), []);
  const held = useRef(new Map<string, unknown>());
  const hold = <T,>(key: string, value: T): T => {
    if (count === 0 || !held.current.has(key)) held.current.set(key, value);
    return held.current.get(key) as T;
  };
  return { open: count > 0, onOpenChange, hold };
}

/**
 * An icon-only toolbar button that opens its settings in a popover (Escape, a click outside or
 * moving focus outside closes it). It stays open while several settings are changed: Carbon also
 * closes a popover when its focused control loses focus without a new one, which happens when a
 * change re-renders the panel (a field row moving, a button turning disabled); that isn't closing.
 */
export function ToolbarPopover({ label, icon: Icon, active, fit, width, openRequest, onOpenChange, className, children }: Props) {
  const [open, setOpen] = useState(false);
  const openChange = useRef(onOpenChange);
  openChange.current = onOpenChange;
  useEffect(() => {
    if (!open) return;
    openChange.current?.(true);
    // A "⋮" menu holding the button opens with it (OverflowBar): a panel opened by a request
    // (rename a new view) would otherwise be inside a closed menu, not shown.
    root.current?.dispatchEvent(new CustomEvent(PANEL_OPENED, { bubbles: true }));
    return () => openChange.current?.(false);
  }, [open]);
  // Opened in the same render as the request, so what the panel focuses (a name to rename) is there.
  const [seenRequest, setSeenRequest] = useState<number>();
  if (openRequest !== seenRequest) {
    setSeenRequest(openRequest);
    if (openRequest) setOpen(true);
  }
  // The panel is rendered once first opened (then kept): closed panels full of icon buttons and
  // their tooltips made every page that has them slow to open.
  const [opened, setOpened] = useState(false);
  if (open && !opened) setOpened(true);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const pressedOutside = useRef(false);
  // A dialog or a date picker's calendar opened from the panel (rendered at the window level) counts as part of it.
  const inside = (n: Node | null) => !!n && (!!root.current?.contains(n) || (n instanceof Element && !!n.closest(WINDOW_LEVEL)));
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      pressedOutside.current = !inside(e.target as Node);
    };
    // Escape closes it with focus in the panel, on its button (where opening it leaves focus) or
    // dropped to the body (the control used was removed, like a rule's trash button), and gives
    // focus back to the button. Not from a dialog opened from the panel, which closes itself, nor
    // while a dropdown in the panel has its menu open (that Escape closes the menu). Seen while
    // capturing: Carbon's dropdowns stop Escape from going further, with their menu closed too.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const focus = document.activeElement;
      if (focus && focus !== document.body && !root.current?.contains(focus)) return;
      if (focus && focus.id !== id && focus.getAttribute("aria-expanded") === "true") return;
      setOpen(false);
      document.getElementById(id)?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);
  // While it is open, what it changes may make the page shorter (a block's filter leaving fewer
  // rows, a component's result): at the bottom of a scrolled pane that would pull the page, and the
  // panel with its button, down under the pointer. The page keeps at least its height until the
  // last panel on it closes (a count on the page: several can be open).
  useEffect(() => {
    if (!open) return;
    const page = root.current?.closest<HTMLElement>(".ws-tab-content");
    if (!page) return;
    const held = Number(page.dataset.panelsHeld ?? 0);
    if (held === 0) page.style.minBlockSize = `${page.offsetHeight}px`;
    page.dataset.panelsHeld = String(held + 1);
    return () => {
      const left = Number(page.dataset.panelsHeld ?? 1) - 1;
      page.dataset.panelsHeld = String(left);
      if (left === 0) page.style.minBlockSize = "";
    };
  }, [open]);
  // The panel never makes the page scroll and never leaves its pane: it gets at most the room on
  // the roomier side of its button (autoAlign flips to that side) and scrolls inside when taller,
  // is at most as wide as the pane minus a margin, and is shifted back inside when autoAlign
  // placed it across a pane edge.
  const [room, setRoom] = useState<number>();
  const [maxWidth, setMaxWidth] = useState<number>();
  useEffect(() => {
    if (!open) return;
    const margin = 16;
    // The panel's own content: the IconButton's tooltip is a popover too, and comes first.
    const content = () => root.current?.querySelector<HTMLElement>(":scope > .cds--popover > .cds--popover-content") ?? null;
    const caret = (el: HTMLElement) => el.querySelector<HTMLElement>(":scope > .cds--popover-caret");
    const bounds = () => {
      const pane = root.current?.closest(".ws-pane__body")?.getBoundingClientRect();
      return { left: Math.max(pane?.left ?? 0, 0), right: Math.min(pane?.right ?? window.innerWidth, window.innerWidth) };
    };
    // The side the panel was on before typing in it began (an on-screen keyboard may come up then).
    let side: PanelSide | null = null;
    const measure = () => {
      const r = root.current?.getBoundingClientRect();
      const el = content();
      // Within what an on-screen keyboard leaves, on its side while it is typed in (panelRoom.ts).
      if (r) {
        const p = el?.getBoundingClientRect();
        const typing = typingIn(el);
        if (!typing && p && p.height > 0) side = sideOf(r, p);
        const height = panelRoom(r, typing ? side : null, margin);
        applyRoom(el?.querySelector<HTMLElement>(".toolbar-popover__panel"), height);
        setRoom(height);
      }
      const b = bounds();
      setMaxWidth(Math.max(b.right - b.left - 2 * margin, 0));
    };
    const place = () => {
      const el = content();
      if (!el) return;
      // CSS `translate` is independent of the `transform` autoAlign positions with.
      el.style.translate = "";
      const tip = caret(el);
      if (tip) tip.style.translate = "";
      const r = el.getBoundingClientRect();
      const b = bounds();
      let dx = 0;
      if (r.right > b.right - margin) dx = b.right - margin - r.right;
      if (r.left + dx < b.left + margin) dx = b.left + margin - r.left;
      if (!dx) return;
      el.style.translate = `${dx}px 0`;
      // The caret is inside the panel: shifted back, so it keeps pointing at the button.
      if (tip) tip.style.translate = `${-dx}px 0`;
    };
    // While open, a panel hung above its button never gets shorter: it would otherwise move
    // everything in it down when something in it shrinks (a code editor's help giving way to a
    // one-line problem), under the pointer. It grows as needed; the held height goes on close. One
    // hung below keeps its top edge, so it shrinks back (a section of it collapsed again).
    let held = 0;
    const hold = () => {
      const el = content();
      const panel = el?.querySelector<HTMLElement>(".toolbar-popover__panel");
      const r = root.current?.getBoundingClientRect();
      if (!el || !panel || !r) return;
      if (sideOf(r, el.getBoundingClientRect()) === "below") {
        held = 0;
        panel.style.minBlockSize = "";
        return;
      }
      const h = panel.getBoundingClientRect().height;
      if (h <= held) return;
      held = h;
      panel.style.minBlockSize = `min(${h}px, var(--popover-room, 100vh))`;
    };
    const update = () => {
      hold();
      measure();
      requestAnimationFrame(() => {
        place();
        keepFocusInView(content()?.querySelector<HTMLElement>(".toolbar-popover__panel"));
      });
    };
    update();
    const stop = onViewportChange(update);
    const el = content();
    const observer = el ? new ResizeObserver(update) : undefined;
    if (el) observer?.observe(el);
    return () => {
      stop();
      observer?.disconnect();
      const panel = el?.querySelector<HTMLElement>(".toolbar-popover__panel");
      if (panel) panel.style.minBlockSize = "";
      if (el) el.style.translate = "";
      const tip = el && caret(el);
      if (tip) tip.style.translate = "";
    };
  }, [open]);
  // Decided once focus has settled: closed for a press outside or focus that moved elsewhere,
  // kept open when focus merely dropped (to the body) or stayed inside.
  const requestClose = () =>
    setTimeout(() => {
      const focus = document.activeElement;
      const dropped = !focus || focus === document.body;
      if (!pressedOutside.current && (dropped || inside(focus))) return;
      pressedOutside.current = false;
      setOpen(false);
    }, 0);
  return (
    <Popover ref={root} autoAlign open={open} align="bottom-end" dropShadow onRequestClose={requestClose} className="toolbar-popover">
      <IconButton autoAlign id={id} className={className} label={label} kind="ghost" size="sm" align="bottom" isSelected={open} data-active={active || undefined} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon />
      </IconButton>
      <PopoverContent>
        <div
          className={`toolbar-popover__panel${fit ? " toolbar-popover__panel--fit" : ""}${width ? ` toolbar-popover__panel--${width}` : ""}`}
          style={
            {
              ...(room !== undefined && { "--popover-room": `${Math.max(room, 0)}px` }),
              ...(maxWidth !== undefined && { "--popover-width": `${maxWidth}px` }),
            } as React.CSSProperties
          }
        >
          {opened && (typeof children === "function" ? children(() => setOpen(false)) : children)}
        </div>
      </PopoverContent>
    </Popover>
  );
}
