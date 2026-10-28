import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { IconButton, TableCell } from "@carbon/react";

/** Props for a row action's IconButton (or RowIconButton). */
export const ROW_BUTTON = { autoAlign: true, kind: "ghost", size: "sm", align: "top-end" } as const;

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
 * nothing moves when it comes), a plain button labelled by `label`. Props as ROW_BUTTON.
 */
export function RowIconButton({ label, align, className, pressed, onClick, children }: { label: string; align?: "top-end"; className?: string; pressed?: boolean; onClick?: (e: MouseEvent<HTMLButtonElement>) => void; children: ReactNode; kind?: "ghost"; size?: "sm"; autoAlign?: boolean }) {
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

/**
 * The actions cell of every table row: its icon buttons (spread `ROW_BUTTON` on each).
 *
 * The tooltips come once the row is live (RowIconButton): every icon button's tooltip is a
 * Carbon Popover, which reads computed styles on each render, and a 200-row table had 800 of them.
 */
export function RowActions({ children }: { children: ReactNode }) {
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
      <RowLive.Provider value={live}>{children}</RowLive.Provider>
    </TableCell>
  );
}
