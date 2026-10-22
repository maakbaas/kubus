import { useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from "react";
import { IconButton, Popover, PopoverContent } from "@carbon/react";

interface Props {
  label: string;
  icon: ComponentType;
  /** Shows the button as selected, e.g. when filters are active. */
  active?: boolean;
  /** Size the panel to its content (e.g. a short list) instead of the settings width. */
  fit?: boolean;
  /** Opens the panel whenever this changes to a new truthy value (e.g. after adding a view). */
  openRequest?: number;
  children: ReactNode;
}

/**
 * An icon-only toolbar button that opens its settings in a popover (Escape, a click outside or
 * moving focus outside closes it). It stays open while several settings are changed: Carbon also
 * closes a popover when its focused control loses focus without a new one, which happens when a
 * change re-renders the panel (a field row moving, a button turning disabled); that isn't closing.
 */
export function ToolbarPopover({ label, icon: Icon, active, fit, openRequest, children }: Props) {
  const [open, setOpen] = useState(false);
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
  const inside = (n: Node | null) => !!n && (!!root.current?.contains(n) || (n instanceof Element && !!n.closest(".cds--modal")));
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
    // autoAlign places the panel asynchronously (and again on scroll or a flip): shift it back
    // inside after every move, not only after the first one. Only a new transform counts, so the
    // shift's own style change doesn't loop.
    let placedAt = el?.style.transform;
    const moves = new MutationObserver(() => {
      if (!el || el.style.transform === placedAt) return;
      placedAt = el.style.transform;
      place();
    });
    if (el) moves.observe(el, { attributes: true, attributeFilter: ["style"] });
    return () => {
      window.removeEventListener("resize", update);
      moves.disconnect();
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
      <IconButton autoAlign id={id} label={label} kind="ghost" size="sm" align="bottom" isSelected={active || open} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon />
      </IconButton>
      <PopoverContent>
        <div
          className={fit ? "toolbar-popover__panel toolbar-popover__panel--fit" : "toolbar-popover__panel"}
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
          {opened && children}
        </div>
      </PopoverContent>
    </Popover>
  );
}
