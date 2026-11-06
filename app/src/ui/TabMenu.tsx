import { useEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
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
 * (at most once a frame) when the bar or a tab changes size (the tabs' widths are set by effects of the page), when
 * tabs come and go or another is selected, and once the fonts are in; not after every render of the page around it:
 * each check lays the page out, and pages render many times while they load.
 * `widthOf`: a tab's width to judge by, else its own (read at the time; kept current by the caller).
 */
export function useClippedTabs(bar: RefObject<HTMLElement | null>, widthOf?: (item: HTMLElement) => number): boolean {
  const [clipped, setClipped] = useState(false);
  const clippedRef = useRef(false);
  clippedRef.current = clipped;
  const widthOfRef = useRef(widthOf);
  widthOfRef.current = widthOf;
  /** The bar's width and the tabs' total when they were clipped. */
  const clippedAt = useRef<{ width: number; total: number } | null>(null);
  // Set up once per bar.
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const check = () => {
      const tabs = el.querySelector<HTMLElement>(".cds--tabs");
      const list = el.querySelector<HTMLElement>(".cds--tab--list");
      if (!tabs || !list) return;
      const widthOf = widthOfRef.current;
      const clipped = clippedRef.current;
      const items = [...list.querySelectorAll<HTMLElement>(".cds--tabs__nav-item")];
      // The tabs, and what else the bar holds (its room is the bar's less theirs): their sizes are watched.
      observe([...items, ...el.children]);
      // Without their own sizing the tabs mustn't shrink in the narrowed list: that would unclip.
      if (!widthOf) items.forEach((item) => item.style.flexShrink !== "0" && (item.style.flexShrink = "0"));
      const total = items.reduce((sum, item) => sum + (widthOf ? widthOf(item) : item.offsetWidth), 0);
      // While clipped, the menu arrow's own width counts as free: it goes once the tabs fit (judged
      // with it, two tabs that fit without it would stay clipped). Its margin still counts: no
      // flipping back and forth when the tabs fit by less than that.
      const menu = el.querySelector<HTMLElement>(".tab-menu--arrow");
      const free = clipped && menu ? menu.offsetWidth : 0;
      let over = total > el.clientWidth - occupied(el, tabs) + free + 1;
      // Clipped, they stay so until the bar is wider or the tabs narrower than when they were clipped: clipping moves
      // what the bar holds ("+" into the "⋮" bar, which may then fold up), so the room it is judged by changes with it,
      // and where both answers undid themselves the bar flipped between them every frame, without end (a narrow
      // window, long view names: the page froze).
      const at = clippedAt.current;
      if (clipped && at && el.clientWidth <= at.width + 1 && total >= at.total - 1) over = true;
      clippedAt.current = over ? (clipped && at ? at : { width: el.clientWidth, total }) : null;
      clippedRef.current = over;
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
      if (list !== alignedList) {
        alignedList?.removeEventListener("scroll", align);
        list.addEventListener("scroll", align);
        alignedList = list;
      }
    };
    let frame = 0;
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), check()));
    };
    // Carbon scrolls the list too (to the selected tab as the page loads, smoothly): while clipped
    // the shown tab leads, whoever moved it.
    let alignedList: HTMLElement | null = null;
    const align = () => {
      const list = el.querySelector<HTMLElement>(".cds--tab--list");
      const shown = list?.querySelector<HTMLElement>(".cds--tabs__nav-item--selected");
      if (!list || !shown || list.dataset.aligned === undefined) return;
      const off = shown.getBoundingClientRect().left - list.getBoundingClientRect().left;
      if (Math.abs(off) > 1) list.scrollLeft += off;
    };
    // The bar, each tab (they change width after the first paint: labels loading, the web font, the page's fit) and the
    // bar's other parts.
    const sizes = new ResizeObserver(schedule);
    sizes.observe(el);
    const observed = new Set<Element>();
    const observe = (boxes: Element[]) => {
      for (const box of boxes) if (!observed.has(box)) (observed.add(box), sizes.observe(box));
    };
    // Tabs added or removed, another selected (its class) or its width to judge by set (the strip's `data-least`), the
    // bar's parts coming and going ("+" moving into the "⋮" bar). Not what happens inside them (a tooltip mounting).
    const changes = new MutationObserver((records) => {
      const relevant = records.some((r) => {
        const target = r.target as Element;
        if (r.type === "attributes") return target.classList.contains("cds--tabs__nav-item");
        return target === el || target.parentElement === el || target.matches(".cds--tab--list, .cds--tabs, .overflow-bar__items, .tab-menu");
      });
      if (relevant) schedule();
    });
    changes.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "data-least"] });
    void document.fonts?.ready.then(schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      sizes.disconnect();
      changes.disconnect();
      alignedList?.removeEventListener("scroll", align);
    };
  }, [bar]);
  return clipped;
}

export interface TabMenuItem {
  id: string;
  name: string;
}

/** A down arrow beside tabs that don't all fit: it lists all of them in a toolbar popover (the shown one checked). */
export function TabMenu({ items, activeId, label, onSelect }: { items: TabMenuItem[]; activeId: string | undefined; label: string; onSelect(id: string): void }) {
  return (
    <ToolbarPopover label={label} icon={ChevronDown} fit className="tab-menu tab-menu--arrow">
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
