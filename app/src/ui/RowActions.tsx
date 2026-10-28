import { Children, createContext, isValidElement, useContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from "react";
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

/**
 * Whether the row's buttons have their tooltips yet (RowIconButton). Every Carbon IconButton's
 * tooltip is a Popover that reads computed styles on every render, works out its position once
 * on mount and listens to every click and key on the window: a 1,000-row table had 2,000 of
 * them, more than half the time it took to open. A row gets them once a mouse or pen enters it,
 * or focus does; a touch screen, which shows no tooltips, never needs them.
 */
const RowLive = createContext(true);

/**
 * A row action's IconButton: until its row is live, the same markup without the tooltip (so
 * nothing moves when it comes), a plain button labelled by `label`. Props as rowButtonProps.
 */
export function RowIconButton({ label, align, className, pressed, onClick, children }: { label: string; align?: "top-end" | "bottom" | "left"; className?: string; pressed?: boolean; onClick?: (e: MouseEvent<HTMLButtonElement>) => void; children: ReactNode; kind?: "ghost"; size?: "sm"; autoAlign?: boolean }) {
  const live = useContext(RowLive);
  const button = useRef<HTMLButtonElement>(null);
  const hadFocus = useRef(false);
  // Focus that landed on the plain button (Shift+Tab into the row) moves to the real one.
  useLayoutEffect(() => {
    if (live && hadFocus.current) button.current?.focus();
    hadFocus.current = false;
  }, [live]);
  if (live) {
    return (
      <IconButton ref={button} autoAlign kind="ghost" size="sm" align={align} className={className} label={label} isSelected={pressed} onClick={onClick}>
        {children}
      </IconButton>
    );
  }
  return (
    <span className={`cds--popover-container cds--popover--caret cds--popover--high-contrast cds--popover--auto-align cds--autoalign cds--popover--${align ?? "top"} cds--tooltip cds--icon-tooltip`}>
      <div className="cds--tooltip-trigger__wrapper">
        <button
          ref={button}
          type="button"
          aria-label={label}
          aria-pressed={pressed}
          className={`${className ? `${className} ` : ""}cds--btn cds--btn--sm cds--layout--size-sm cds--btn--ghost cds--btn--icon-only`}
          onClick={onClick}
          onFocus={() => (hadFocus.current = true)}
        >
          {children}
        </button>
      </div>
    </span>
  );
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
  const cell = useRef<HTMLTableCellElement>(null);
  const [live, setLive] = useState(false);
  useEffect(() => {
    const row = cell.current?.closest("tr");
    if (!row || live) return;
    const onPointer = (e: PointerEvent) => e.pointerType !== "touch" && setLive(true);
    const onFocus = () => setLive(true);
    row.addEventListener("pointerover", onPointer);
    row.addEventListener("focusin", onFocus);
    return () => {
      row.removeEventListener("pointerover", onPointer);
      row.removeEventListener("focusin", onFocus);
    };
  }, [live]);
  return (
    <TableCell ref={cell} className="row-actions">
      <RowLive.Provider value={live}>
        {stacked
          ? Array.from({ length: countButtons(icons) }, (_, i) => <span key={i} className="row-action-icon row-action-icon--placeholder" aria-hidden />)
          : icons}
        {stacked && <RowActionsMenu>{children(true)}</RowActionsMenu>}
      </RowLive.Provider>
    </TableCell>
  );
}

/** The dark popover behind one button, styled like the markdown editor's table menu. */
function RowActionsMenu({ children }: { children: ReactNode }) {
  const live = useContext(RowLive);
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
  // Until its row is live (or it is tapped open: a touch screen's row never is), the same button
  // without the popover around it or its tooltip: every stacked row has this menu.
  if (!live && !open) {
    return (
      <span className="cds--popover-container cds--popover--caret cds--popover--drop-shadow cds--popover--high-contrast cds--popover--auto-align cds--autoalign cds--popover--bottom-end row-actions__menu">
        <RowIconButton label="Actions" align="left" pressed={false} onClick={() => setOpen(true)}>
          <OverflowMenuVertical />
        </RowIconButton>
      </span>
    );
  }
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
