import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { ContainedList, ContainedListItem, Popover, PopoverContent, Tag } from "@carbon/react";
import { useTags } from "../app/tagIndex";
import { matchingTags, tagColor } from "../domain/tags";
import { LINK_KEY, LINK_PICKER_OPEN, type LinkTrigger } from "./LinkPicker";
import { onViewportChange, panelRoom } from "./panelRoom";

/**
 * Autocompletes a tag as it is typed in the Markdown editor (`#`, then what a tag may hold): a Carbon list of the tags in
 * use, each in its colour, at the caret, as the link picker (LinkPicker): ↑ ↓ move, Enter or
 * Tab choose, Escape closes it; the pointer chooses too. Nothing shows while nothing matches.
 */
export function TagPicker({ box, trigger, onPick }: { box: RefObject<HTMLDivElement | null>; trigger: LinkTrigger | null; onPick(tag: string, trigger: LinkTrigger): void }) {
  const { used } = useTags();
  const [active, setActive] = useState(0);
  /** Where Escape closed it: the tag stays closed until another one is begun. */
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [room, setRoom] = useState<number>();
  const query = trigger?.query;
  const tags = query === undefined ? [] : matchingTags(used, query);
  const shown = trigger !== null && dismissed !== trigger.from && tags.length > 0;
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (query === undefined) setDismissed(null);
  }, [query]);

  // The keys the editor hands over while the picker shows (the same as the link picker's: one of them shows at a time).
  const latest = useRef({ tags, active, trigger, onPick });
  latest.current = { tags, active, trigger, onPick };
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onKey = (e: Event) => {
      const { tags, active, trigger, onPick } = latest.current;
      const key = (e as CustomEvent<string>).detail;
      if (!trigger || tags.length === 0) return;
      if (key === "ArrowDown") setActive((active + 1) % tags.length);
      else if (key === "ArrowUp") setActive((active - 1 + tags.length) % tags.length);
      else if (key === "Escape") setDismissed(trigger.from);
      else onPick(tags[Math.min(active, tags.length - 1)].tag, trigger);
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

  const outer = box.current?.getBoundingClientRect();
  const caret = trigger?.caret;
  useEffect(() => {
    if (!shown || !caret) return;
    const update = () => setRoom(panelRoom(new DOMRect(caret.left, caret.top, 1, caret.bottom - caret.top), null));
    update();
    return onViewportChange(update);
  }, [shown, caret?.left, caret?.top, caret?.bottom]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!shown || !trigger || !outer) return null;
  return (
    <TagPopover
      style={{ left: trigger.caret.left - outer.left, top: trigger.caret.top - outer.top, width: 1, height: trigger.caret.bottom - trigger.caret.top, ...(room !== undefined && { "--popover-room": `${Math.max(room, 0)}px` }) }}
      tags={tags}
      active={Math.min(active, tags.length - 1)}
      onPick={(tag) => onPick(tag, trigger)}
    />
  );
}

/**
 * The tags offered (`active`: the one Enter takes, kept in view), in a Carbon popover hanging from a box at the caret
 * (`style`: its place and size, and the room below it). A pick doesn't take focus from where the person types.
 */
export function TagPopover({ style, fixed, tags, active, onPick }: { style: CSSProperties; fixed?: boolean; tags: { tag: string; count: number }[]; active: number; onPick(tag: string): void }) {
  const { index } = useTags();
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <div className={fixed ? "md-link-popover link-picker tag-picker--fixed" : "md-link-popover link-picker"} style={style}>
      <Popover autoAlign open align="bottom-start" className="md-link-popover__popover">
        <span className="md-link-popover__anchor" />
        <PopoverContent>
          <div ref={list} className="link-target-list link-target-list--compact" onMouseDown={(e) => e.preventDefault()}>
            <ContainedList label="Tags" kind="on-page" size="sm">
              {tags.map((t, i) => (
                <ContainedListItem key={t.tag} onClick={() => onPick(t.tag)} data-active={active === i} aria-current={active === i ? "true" : undefined}>
                  <span className="tag-option">
                    <Tag size="sm" type={tagColor(index, t.tag)} className="tag-option__tag">
                      {t.tag}
                    </Tag>
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
