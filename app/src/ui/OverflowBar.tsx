import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconButton } from "@carbon/react";
import { OverflowMenuVertical } from "@carbon/icons-react";

/**
 * A row of icon buttons. In a narrow container (styles.css, `.overflow-bar`) they collapse into one
 * "⋮" button that opens them in the dark popover the Markdown editor's table menu has. The buttons
 * are the same elements either way (not copies), so toolbar popovers among them keep their state.
 */
export function OverflowBar({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    // A dialog opened from a button here is rendered at the window level and counts as inside.
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (!root.current?.contains(t) && !t.closest(".cds--modal, .cds--menu")) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);
  return (
    <div ref={root} className="overflow-bar" data-open={open || undefined} onKeyDown={(e) => e.key === "Escape" && open && setOpen(false)}>
      <IconButton
        autoAlign
        kind="ghost"
        size="sm"
        align="bottom-end"
        label="More actions"
        className="overflow-bar__toggle"
        isSelected={open}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <OverflowMenuVertical />
      </IconButton>
      {/* A plain button closes it; a toolbar popover's button opens its panel and keeps it. */}
      <div
        className="overflow-bar__items md-table-menu"
        onClick={(e) => {
          const t = e.target as Element;
          if (t.closest("button") && !t.closest(".toolbar-popover")) setOpen(false);
        }}
      >
        {children}
      </div>
    </div>
  );
}
