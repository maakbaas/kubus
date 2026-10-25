import { useEffect, useState, type MouseEvent, type RefObject } from "react";
import { Link } from "@carbon/react";
import { Checkmark, ChevronDown } from "@carbon/icons-react";
import { ToolbarPopover } from "./ToolbarPopover";

/** The widths of what a bar holds besides `skip`, looking through `display: contents` wrappers. */
export function occupied(bar: Element, skip: Element | null): number {
  let width = 0;
  for (const child of bar.children) {
    if (child === skip || child.classList.contains("views-bar__spacer")) continue;
    width += getComputedStyle(child).display === "contents" ? occupied(child, null) : child.getBoundingClientRect().width;
  }
  return width;
}

/**
 * Whether the tabs in `bar` together are wider than the room the bar leaves them. Then only the
 * shown tab stays visible (the list is narrowed to it) and the `TabMenu` lists them all. The tabs
 * keep their widths while hidden, so this is judged from their widths, not from what shows. Checked
 * after every render (the tabs' widths are set by effects of the page) and when the bar resizes.
 */
export function useClippedTabs(bar: RefObject<HTMLElement | null>, widthOf?: (item: HTMLElement) => number): boolean {
  const [clipped, setClipped] = useState(false);
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const check = () => {
      const tabs = el.querySelector<HTMLElement>(".cds--tabs");
      const list = el.querySelector<HTMLElement>(".cds--tab--list");
      if (!tabs || !list) return;
      const items = [...list.querySelectorAll<HTMLElement>(".cds--tabs__nav-item")];
      // Without their own sizing the tabs mustn't shrink in the narrowed list: that would unclip.
      if (!widthOf) items.forEach((item) => (item.style.flexShrink = "0"));
      const total = items.reduce((sum, item) => sum + (widthOf ? widthOf(item) : item.offsetWidth), 0);
      const over = total > el.clientWidth - occupied(el, tabs) + 1;
      setClipped(over);
      const shown = list.querySelector<HTMLElement>(".cds--tabs__nav-item--selected");
      if (over && shown) {
        list.style.inlineSize = `${shown.offsetWidth}px`;
        list.style.overflow = "hidden"; // no swiping or wheeling to the other tabs: the menu has them
        // Not animated (Carbon's list scrolls smoothly: mid-way, two half tabs show).
        list.style.scrollBehavior = "auto";
        list.scrollLeft += shown.getBoundingClientRect().left - list.getBoundingClientRect().left;
        list.dataset.aligned = "";
      } else {
        list.style.inlineSize = "";
        list.style.overflow = "";
        list.style.scrollBehavior = "";
        delete list.dataset.aligned;
      }
    };
    // Carbon scrolls the list too (to the selected tab as the page loads, smoothly): while clipped
    // the shown tab leads, whoever moved it.
    const align = () => {
      const list = el.querySelector<HTMLElement>(".cds--tab--list");
      const shown = list?.querySelector<HTMLElement>(".cds--tabs__nav-item--selected");
      if (!list || !shown || list.dataset.aligned === undefined) return;
      const off = shown.getBoundingClientRect().left - list.getBoundingClientRect().left;
      if (Math.abs(off) > 1) list.scrollLeft += off;
    };
    el.querySelector(".cds--tab--list")?.addEventListener("scroll", align);
    void document.fonts?.ready.then(check);
    const frame = requestAnimationFrame(check);
    const observer = new ResizeObserver(check);
    observer.observe(el);
    // The tabs change width after the first paint (labels loading, the web font, the page's fit).
    el.querySelectorAll(".cds--tabs__nav-item").forEach((item) => observer.observe(item));
    return () => {
      el.querySelector(".cds--tab--list")?.removeEventListener("scroll", align);
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  });
  return clipped;
}

export interface TabMenuItem {
  id: string;
  name: string;
}

/** A down arrow beside tabs that don't all fit: it lists all of them in a toolbar popover (the shown one checked). */
export function TabMenu({ items, activeId, label, onSelect }: { items: TabMenuItem[]; activeId: string | undefined; label: string; onSelect(id: string): void }) {
  return (
    <ToolbarPopover label={label} icon={ChevronDown} fit className="tab-menu">
      {(close) => (
        <div className="tab-menu__list">
          {items.map((t) => (
            <Link
              key={t.id}
              href="#"
              className="tab-menu__item"
              aria-current={t.id === activeId || undefined}
              onClick={(e: MouseEvent) => {
                e.preventDefault();
                onSelect(t.id);
                close();
              }}
            >
              <span className="tab-menu__check">{t.id === activeId && <Checkmark />}</span>
              {t.name}
            </Link>
          ))}
        </div>
      )}
    </ToolbarPopover>
  );
}
