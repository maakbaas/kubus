import { useEffect, useRef, useState, type RefObject } from "react";
import { ContainedList, ContainedListItem, Popover, PopoverContent } from "@carbon/react";
import { insertOptions, type InsertOption } from "./markdownActions";
import { LINK_KEY, LINK_PICKER_OPEN, type LinkTrigger } from "./LinkPicker";
import { onViewportChange, panelRoom } from "./panelRoom";

/**
 * The `/` menu (docs/features.md "Markdown editor"): what can be inserted at the caret, a Carbon list hanging from the
 * `/` typed at a line's start or after a space, filtered by what is typed after it (`/tab`: Table). Each option shows
 * the Markdown that types it. ↑ ↓ move, Enter or Tab choose, Escape closes it (the `/` stays text, as does a space
 * typed with nothing found); the pointer chooses too. Only inserts: what is there already is changed in the bars.
 */
export function SlashMenu({ box, trigger, onPick }: { box: RefObject<HTMLDivElement | null>; trigger: LinkTrigger | null; onPick(option: InsertOption, trigger: LinkTrigger): void }) {
  const [active, setActive] = useState(0);
  /** Where Escape closed it: closed until another `/` is begun. */
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [room, setRoom] = useState<number>();
  const query = trigger?.query;
  const options = query === undefined ? [] : insertOptions(query);
  const shown = trigger !== null && dismissed !== trigger.from && options.length > 0;
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (query === undefined) setDismissed(null);
  }, [query]);

  // The keys the editor hands over while it shows (as the link and tag pickers'; one of them shows at a time).
  const latest = useRef({ options, active, trigger, onPick });
  latest.current = { options, active, trigger, onPick };
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onKey = (e: Event) => {
      const { options, active, trigger, onPick } = latest.current;
      const key = (e as CustomEvent<string>).detail;
      if (!trigger || options.length === 0) return;
      if (key === "ArrowDown") setActive((active + 1) % options.length);
      else if (key === "ArrowUp") setActive((active - 1 + options.length) % options.length);
      else if (key === "Escape") setDismissed(trigger.from);
      else onPick(options[Math.min(active, options.length - 1)], trigger);
    };
    el.addEventListener(LINK_KEY, onKey);
    return () => el.removeEventListener(LINK_KEY, onKey);
  }, [box]);
  useEffect(() => {
    const el = box.current;
    if (!el || !shown) return;
    el.dataset.linkPicker = LINK_PICKER_OPEN;
    return () => {
      delete el.dataset.linkPicker;
    };
  }, [box, shown]);

  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const caret = trigger?.caret;
  useEffect(() => {
    if (!shown || !caret) return;
    const update = () => setRoom(panelRoom(new DOMRect(caret.left, caret.top, 1, caret.bottom - caret.top), null));
    update();
    return onViewportChange(update);
  }, [shown, caret?.left, caret?.top, caret?.bottom]); // eslint-disable-line react-hooks/exhaustive-deps

  const outer = box.current?.getBoundingClientRect();
  if (!shown || !trigger || !outer) return null;
  const at = Math.min(active, options.length - 1);
  return (
    <div
      className="md-link-popover link-picker slash-menu"
      style={{ left: trigger.caret.left - outer.left, top: trigger.caret.top - outer.top, width: 1, height: trigger.caret.bottom - trigger.caret.top, ...(room !== undefined && { "--popover-room": `${Math.max(room, 0)}px` }) }}
    >
      <Popover autoAlign open align="bottom-start" className="md-link-popover__popover">
        <span className="md-link-popover__anchor" />
        <PopoverContent>
          <div ref={list} className="link-target-list link-target-list--compact" onMouseDown={(e) => e.preventDefault()}>
            <ContainedList label="Insert" kind="on-page" size="sm">
              {options.map((o, i) => (
                <ContainedListItem key={o.kind} data-active={i === at} onClick={() => onPick(o, trigger)}>
                  <span className="slash-menu__option">
                    <span className="slash-menu__label">{o.label}</span>
                    <span className="slash-menu__syntax">{o.syntax}</span>
                  </span>
                </ContainedListItem>
              ))}
            </ContainedList>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
