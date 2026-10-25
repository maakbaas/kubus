import { useCallback, useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from "react";
import { IconButton, Popover, PopoverContent } from "@carbon/react";

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
  // A dialog opened from the panel (rendered at the window level) counts as part of it.
  const inside = (n: Node | null) => !!n && (!!root.current?.contains(n) || (n instanceof Element && !!n.closest(".cds--modal, .cds--menu")));
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      pressedOutside.current = !inside(e.target as Node);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
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
    const measure = () => {
      const r = root.current?.getBoundingClientRect();
      if (r) setRoom(Math.max(r.top, window.innerHeight - r.bottom) - margin);
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
    const update = () => {
      measure();
      requestAnimationFrame(place);
    };
    update();
    window.addEventListener("resize", update);
    const el = content();
    const observer = el ? new ResizeObserver(update) : undefined;
    if (el) observer?.observe(el);
    return () => {
      window.removeEventListener("resize", update);
      observer?.disconnect();
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
          onKeyDown={(e) => {
            // An Escape closing a dialog opened from here reaches this panel too (React portal).
            if (e.key !== "Escape" || e.defaultPrevented || (e.target as Element).closest?.(".cds--modal")) return;
            setOpen(false);
            document.getElementById(id)?.focus();
          }}
        >
          {opened && (typeof children === "function" ? children(() => setOpen(false)) : children)}
        </div>
      </PopoverContent>
    </Popover>
  );
}
