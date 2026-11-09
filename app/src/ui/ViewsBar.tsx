import { useRef, type ReactNode } from "react";
import { IconButton, Tab, TabList, Tabs } from "@carbon/react";
import { Add, Save, Star, StarFilled, TrashCan } from "@carbon/icons-react";
import { OverflowBar } from "./OverflowBar";
import { TabMenu, useClippedTabs } from "./TabMenu";

/**
 * The bar of a page's views (a collection's views, a dashboard's tabs, an item's page layouts): their tabs, "*" after the
 * shown one while it has unsaved changes, a menu of them when they don't all fit, "+", Save, and in the "⋮" bar Delete,
 * the star and the bookmark, then the page's own tools (`children`: search, filter, settings). One bar, so each page
 * has the same one.
 */
export function ViewsBar({
  views,
  activeId,
  changed,
  label,
  onSelect,
  onAdd,
  saveShown,
  onSave,
  onDelete,
  star,
  bookmark,
  children,
}: {
  /** `count`: how many items the view shows, said on its tab ("Show number of items"). */
  views: { id: string; name: string; count?: number }[];
  activeId: string | undefined;
  /** The shown view has unsaved changes. */
  changed: boolean;
  /** What the views are called: the tab list's and its menu's name ("Views", "Page layouts"). */
  label: string;
  onSelect(id: string): void;
  onAdd(): void;
  /** Save shows (the caller holds it while a panel is open, so it appears once the panel closes). */
  saveShown: boolean;
  onSave(): void;
  /** Deletes the shown view; omitted when it can't be (the last one). */
  onDelete?: () => void;
  /** The star choosing the default view; omitted when there is nothing to choose (one view). */
  star?: { isDefault: boolean; label: string; onToggle(): void };
  bookmark?: ReactNode;
  children?: ReactNode;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const clipped = useClippedTabs(bar);
  const active = views.findIndex((v) => v.id === activeId);
  // "*" marks unsaved changes to the shown view (switching views discards them).
  const nameOf = (v: { id: string; name: string; count?: number }) => v.name + (v.count !== undefined ? ` (${v.count})` : "") + (changed && v.id === activeId ? " *" : "");
  const add = (
    <IconButton autoAlign kind="ghost" size="sm" align="bottom" label="Add view" onClick={onAdd}>
      <Add />
    </IconButton>
  );
  return (
    <div className="views-bar" ref={bar}>
      {views.length > 0 && (
        <Tabs selectedIndex={active} onChange={({ selectedIndex }) => onSelect(views[selectedIndex].id)}>
          <TabList aria-label={label} className="views-tabs">
            {views.map((v) => (
              <Tab key={v.id}>{nameOf(v)}</Tab>
            ))}
          </TabList>
        </Tabs>
      )}
      {clipped && <TabMenu label={label} items={views.map((v) => ({ id: v.id, name: nameOf(v) }))} activeId={activeId} onSelect={onSelect} />}
      {/* "+" takes the menu arrow's place; with the arrow it joins the icons at the right edge. */}
      {!clipped && <span className="tab-menu">{add}</span>}
      <span className="views-bar__spacer" />
      {/* Always in the bar, left of the other buttons (never in the "⋮" menu). No Discard: unsaved changes are dropped by
          opening the view again (its tab) or another one. */}
      {saveShown && (
        <IconButton autoAlign kind="ghost" size="sm" align="bottom" label="Save changes to view" onClick={onSave}>
          <Save />
        </IconButton>
      )}
      <OverflowBar>
        {clipped && add}
        {onDelete && (
          <IconButton autoAlign kind="ghost" size="sm" align="bottom" label="Delete view" onClick={onDelete}>
            <TrashCan />
          </IconButton>
        )}
        {star && (
          <IconButton autoAlign kind="ghost" size="sm" align="bottom" label={star.label} aria-pressed={star.isDefault} onClick={star.onToggle}>
            {star.isDefault ? <StarFilled /> : <Star />}
          </IconButton>
        )}
        {bookmark}
        {children}
      </OverflowBar>
    </div>
  );
}
