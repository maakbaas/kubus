import { createContext, type DragEvent, type ReactNode } from "react";
import { IconButton } from "@carbon/react";
import { ChevronDown } from "@carbon/icons-react";
import { OverflowBar } from "./OverflowBar";

interface Collapse {
  collapsed: boolean;
  onToggle(): void;
}

/**
 * Makes the field labels inside collapsible (item pages): `FieldLabel` puts the caret before its
 * icon, in every field's label alike (read-only, edited, lists, images), so nothing moves between
 * view and edit.
 */
export const FieldCollapse = createContext<Collapse | null>(null);

/**
 * The collapse caret before a label's icon. It takes a label's height (the 2rem button overhangs)
 * and is pulled left by the button's inset, so its chevron starts where the label's text would.
 */
export function CollapseCaret({ collapsed, onToggle }: Collapse) {
  return (
    <span className="collapse-caret">
      <IconButton autoAlign kind="ghost" size="sm" align="top-start" label={collapsed ? "Expand" : "Collapse"} aria-expanded={!collapsed} onClick={onToggle}>
        <ChevronDown className={collapsed ? "collapse-caret__chevron--collapsed" : undefined} />
      </IconButton>
    </span>
  );
}

/**
 * The heading row of a field or a block: a collapse caret where it collapses, its name as a field
 * label (small text, with its icon), and its buttons at the right (an OverflowBar: "⋮" on phones).
 * The row is as tall as a label; the 2rem buttons are centred on it and overhang a little.
 * `hidden` leaves nothing, its buttons neither. `overlay` keeps only the buttons, over the right
 * of the label row of what follows (a field being edited: its input brings its own label).
 */
export function SectionHeader({
  label,
  heading,
  collapsed,
  onToggle,
  hidden,
  overlay,
  onDragStart,
  children,
}: {
  /** The name, typically an icon label (`FieldLabel`, or an icon with a block's name). */
  label: ReactNode;
  /** A heading (a block) rather than a field's label. */
  heading?: boolean;
  /** Collapsible: whether it is collapsed now. */
  collapsed?: boolean;
  onToggle?(): void;
  hidden?: boolean;
  overlay?: boolean;
  /** Its name can be dragged (a block, to another place on the page: views/BlockRows.tsx). */
  onDragStart?(e: DragEvent): void;
  /** Buttons at the right. */
  children?: ReactNode;
}) {
  const Title = heading ? "h2" : "div";
  if (hidden) return null;
  if (overlay) {
    return children ? (
      <div className="section-header section-header--overlay">
        <div className="section-header__actions">
          <OverflowBar>{children}</OverflowBar>
        </div>
      </div>
    ) : null;
  }
  return (
    <div className="section-header">
      <Title className={onDragStart ? "section-header__title section-header__title--drag cds--label" : "section-header__title cds--label"} draggable={!!onDragStart || undefined} onDragStart={onDragStart}>
        {onToggle && <CollapseCaret collapsed={!!collapsed} onToggle={onToggle} />}
        {/* The name toggles too, like an accordion heading (the caret is its keyboard control). */}
        <span className={onToggle ? "section-header__toggle" : undefined} onClick={onToggle}>
          {label}
        </span>
      </Title>
      {children && (
        <div className="section-header__actions">
          <OverflowBar>{children}</OverflowBar>
        </div>
      )}
    </div>
  );
}
