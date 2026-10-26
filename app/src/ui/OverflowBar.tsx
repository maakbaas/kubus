import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { IconButton } from "@carbon/react";
import { OverflowMenuVertical } from "@carbon/icons-react";
import { useMediaQuery } from "./useMediaQuery";
import { PANEL_OPENED } from "./ToolbarPopover";
import { visibleArea } from "./panelRoom";

/**
 * A row of icon buttons. On a phone, in a narrow page header (styles.css, `.overflow-bar`) or with
 * `menu`, they collapse into one "⋮" button that opens them in the dark popover the Markdown
 * editor's table menu has. The buttons are the same elements either way (not copies), so toolbar
 * popovers among them keep their state.
 */
export function OverflowBar({ children, menu }: { children: ReactNode; /** The "⋮" button at any width (a hidden header's buttons). */ menu?: boolean }) {
  const narrow = useMediaQuery("(max-width: 42rem)");
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const asMenu = menu || narrow;
  // Opened near the bottom of the window (a block low on a phone's screen): the menu opens upwards,
  // or it, and the panels opened from it, would run out of the window.
  const [up, setUp] = useState(false);
  useLayoutEffect(() => {
    if (!open || !asMenu) return setUp(false);
    const items = root.current?.querySelector<HTMLElement>(":scope > .overflow-bar__items");
    const button = toggle.current?.getBoundingClientRect();
    if (!items || !button) return;
    const { top, bottom } = visibleArea();
    const need = items.offsetHeight + 6;
    setUp(button.bottom + need > bottom && button.top - need >= top);
  }, [open, asMenu]);
  // A toolbar popover among the buttons that opens (also by itself, e.g. View settings for a new
  // view's name) opens the menu, or its panel would be hidden with it.
  useEffect(() => {
    const el = root.current;
    const onOpened = () => setOpen(true);
    el?.addEventListener(PANEL_OPENED, onOpened);
    return () => el?.removeEventListener(PANEL_OPENED, onOpened);
  }, []);
  useEffect(() => {
    if (!open) return;
    // A dialog opened from a button here is rendered at the window level and counts as inside.
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (!root.current?.contains(t) && !t.closest(".cds--modal, .cds--menu")) setOpen(false);
    };
    // Escape closes the menu (and a panel opened from it) with focus in it or dropped to the body
    // (an input that saved on Enter): focus goes to "⋮", as the button that had it is hidden with
    // the menu. Not while a dropdown in a panel closes its own menu (Carbon stops that Escape).
    const onKeyDown = (e: KeyboardEvent) => {
      const focus = document.activeElement;
      if (e.key !== "Escape" || (focus && focus !== document.body && !root.current?.contains(focus))) return;
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  return (
    <div ref={root} className={asMenu ? "overflow-bar overflow-bar--menu" : "overflow-bar"} data-open={open || undefined} data-up={up || undefined}>
      <IconButton
        autoAlign
        kind="ghost"
        size="sm"
        align="bottom-end"
        label="More actions"
        ref={toggle}
        className="overflow-bar__toggle"
        isSelected={open}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <OverflowMenuVertical />
      </IconButton>
      {/* A plain button closes it; a toolbar popover's button opens its panel and keeps it. */}
      <div
        className="overflow-bar__items"
        onClick={(e) => {
          const t = e.target as Element;
          // Not a click in a dialog opened from a panel here: it reaches this handler through
          // React's tree (a portal), and closing the menu hid the panel behind it.
          if (!e.currentTarget.contains(t)) return;
          if (t.closest("button") && !t.closest(".toolbar-popover")) setOpen(false);
        }}
      >
        {children}
      </div>
    </div>
  );
}
