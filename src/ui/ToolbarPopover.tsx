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
