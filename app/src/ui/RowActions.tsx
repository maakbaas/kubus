import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconButton, Popover, PopoverContent, TableCell } from "@carbon/react";
import { OverflowMenuHorizontal } from "@carbon/icons-react";

/**
 * Props for a row action's IconButton. In the menu the tooltips prefer below their button, not
 * beside it, where they would hide the neighbouring buttons (autoAlign keeps them inside the pane).
 */
export function rowButtonProps(inMenu: boolean) {
  return inMenu
    ? ({ autoAlign: true, kind: "ghost", size: "sm", align: "bottom" } as const)
    : ({ autoAlign: true, kind: "ghost", size: "sm", align: "top-end", className: "row-action-icon" } as const);
}

/**
 * The actions cell of every table row: icon buttons in a wide table; in a stacked one (cards,
 * styles.css) a "⋯" button in the card's corner opens a popover with the same buttons, so the
 * actions cost no line of their own. `children(inMenu)` renders the buttons (spread
 * `rowButtonProps(inMenu)` on each).
 */
export function RowActions({ children }: { children(inMenu: boolean): ReactNode }) {
  return (
    <TableCell className="row-actions">
      {children(false)}
      <RowActionsMenu>{children(true)}</RowActionsMenu>
    </TableCell>
  );
}

/** The dark popover behind one button, styled like the markdown editor's table menu. */
function RowActionsMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const pressedOutside = useRef(false);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      pressedOutside.current = !root.current?.contains(e.target as Node);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);
  // Only a press outside (or Escape) closes it. Carbon also asks to close when focus is lost,
  // which on iOS (where tapping a button focuses nothing) shut the menu the moment it opened.
  const requestClose = () => {
    if (!pressedOutside.current) return;
    pressedOutside.current = false;
    setOpen(false);
  };
  return (
    <Popover ref={root} open={open} align="bottom-end" autoAlign highContrast className="row-actions__menu" onRequestClose={requestClose}>
      <IconButton autoAlign kind="ghost" size="sm" align="left" label="Actions" isSelected={open} onClick={() => setOpen((o) => !o)}>
        <OverflowMenuHorizontal />
      </IconButton>
      <PopoverContent>
        {/* Any action closes it. Its buttons exist only while it is open: every row has this
            menu, and closed copies of every row's buttons made tables slow to open. */}
        <div
          className="md-link-popover__content md-table-menu"
          onClick={() => setOpen(false)}
          onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        >
          {open && children}
        </div>
      </PopoverContent>
    </Popover>
  );
}
