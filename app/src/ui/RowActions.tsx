import { Children, createContext, isValidElement, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { IconButton, Popover, PopoverContent, TableCell } from "@carbon/react";
import { OverflowMenuVertical } from "@carbon/icons-react";

/**
 * Props for a row action's IconButton. In the menu the tooltips prefer below their button, not
 * beside it, where they would hide the neighbouring buttons (autoAlign keeps them inside the pane).
 */
export function rowButtonProps(inMenu: boolean) {
  return inMenu
    ? ({ autoAlign: true, kind: "ghost", size: "sm", align: "bottom" } as const)
    : ({ autoAlign: true, kind: "ghost", size: "sm", align: "top-end", className: "row-action-icon" } as const);
}

/** Whether the table around is stacked as cards (FillTable, views/TableView.tsx). */
export const TableStacked = createContext(false);

/** The buttons in what `children` rendered, through fragments. */
function countButtons(node: ReactNode): number {
  return Children.toArray(node).reduce<number>((n, c) => {
    if (!isValidElement(c)) return n;
    const el = c as ReactElement<{ children?: ReactNode }>;
    return n + (typeof el.type === "symbol" ? countButtons(el.props.children) : 1);
  }, 0);
}

/**
 * The actions cell of every table row: icon buttons in a wide table; in a stacked one (cards,
 * styles.css) a "⋯" button in the card's corner opens a popover with the same buttons, so the
 * actions cost no line of their own. `children(inMenu)` renders the buttons (spread
 * `rowButtonProps(inMenu)` on each).
 *
 * Only what shows is rendered: every icon button's tooltip is a Carbon Popover, which reads
 * computed styles on each render, and a 200-row table had 800 of them, half of them hidden. A
 * stacked row keeps empty boxes as wide as its icons (hidden like them), because FillTable decides
 * between table and cards by the width the table would have unstacked.
 */
export function RowActions({ children }: { children(inMenu: boolean): ReactNode }) {
  const stacked = useContext(TableStacked);
  const icons = children(false);
  return (
    <TableCell className="row-actions">
      {stacked
        ? Array.from({ length: countButtons(icons) }, (_, i) => <span key={i} className="row-action-icon row-action-icon--placeholder" aria-hidden />)
        : icons}
      {stacked && <RowActionsMenu>{children(true)}</RowActionsMenu>}
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
        <OverflowMenuVertical />
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
