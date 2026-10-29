import { useEffect, useRef, useState, type RefObject } from "react";
import { Popover, PopoverContent } from "@carbon/react";
import { useLinkTargets } from "../app/useLinkTargets";
import type { LinkTarget } from "../domain/linkTargets";
import { LinkTargetList } from "./LinkTargetList";
import { onViewportChange, panelRoom } from "./panelRoom";

/** Dispatched on the editor's content when a local link is being typed (or no longer); its detail is a LinkTrigger or null. */
export const LINK_TRIGGER = "kubus-link-trigger";
/** Dispatched on the editor's content for a key the open picker takes; its detail is the key. */
export const LINK_KEY = "kubus-link-key";
/** Set on the editor's box (`data-link-picker`) while the picker has options: the editor then hands it ↑ ↓ Enter Tab Escape. */
export const LINK_PICKER_OPEN = "open";

/** A local link being typed: `[text](query` (text may be empty), or `#/query` (text empty). */
export interface LinkTrigger {
  /** Where it starts and where the caret is, in the document. */
  from: number;
  to: number;
  /** The visible text typed so far (empty: the option's name is used). */
  text: string;
  /** What is typed for the target. */
  query: string;
  /** The caret's place on screen. */
  caret: { left: number; top: number; bottom: number };
}

/**
 * Autocompletes a local link as it is typed in the Markdown editor: a Carbon list of collections,
 * views, items and (after `item#`) fields at the caret, filtering as the target is typed. ↑ ↓ move,
 * Enter or Tab choose, Escape closes it (the editor keeps focus; typing on opens it again for
 * another link); the pointer chooses too. Nothing shows while nothing matches.
 */
export function LinkPicker({ box, trigger, onPick }: { box: RefObject<HTMLDivElement | null>; trigger: LinkTrigger | null; onPick(target: LinkTarget, trigger: LinkTrigger): void }) {
  const { search, reset } = useLinkTargets();
  const [targets, setTargets] = useState<LinkTarget[]>([]);
  const [active, setActive] = useState(0);
  /** Where Escape closed it: the link stays closed until another one is begun. */
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [room, setRoom] = useState<number>();
  const shown = trigger !== null && dismissed !== trigger.from && targets.length > 0;

  // The options for what is typed (the latest answer wins).
  const query = trigger?.query;
  useEffect(() => {
    if (query === undefined) {
      setTargets([]);
      setDismissed(null);
      reset();
      return;
    }
    let current = true;
    search(query, { items: true, limit: 30 }).then(
      (found) => {
        if (!current) return;
        setTargets(found);
        setActive(0);
      },
      () => current && setTargets([]),
    );
    return () => {
      current = false;
    };
  }, [query, search, reset]);

  // The keys the editor hands over while the picker shows.
  const latest = useRef({ targets, active, trigger, onPick });
  latest.current = { targets, active, trigger, onPick };
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onKey = (e: Event) => {
      const { targets, active, trigger, onPick } = latest.current;
      const key = (e as CustomEvent<string>).detail;
      if (!trigger || targets.length === 0) return;
      if (key === "ArrowDown") setActive((active + 1) % targets.length);
      else if (key === "ArrowUp") setActive((active - 1 + targets.length) % targets.length);
      else if (key === "Escape") setDismissed(trigger.from);
      else onPick(targets[Math.min(active, targets.length - 1)], trigger);
    };
    el.addEventListener(LINK_KEY, onKey);
    return () => el.removeEventListener(LINK_KEY, onKey);
  }, [box]);

  // The editor asks for the keys only while the list shows.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (shown) el.dataset.linkPicker = LINK_PICKER_OPEN;
    else delete el.dataset.linkPicker;
    return () => {
      delete el.dataset.linkPicker;
    };
  }, [box, shown]);

  // The room beside the caret (the roomier side; the popover flips there), within what can be seen.
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
    // A box at the caret in the editor's coordinates; the Carbon popover hangs from it.
    <div
      className="md-link-popover link-picker"
      style={{ left: trigger.caret.left - outer.left, top: trigger.caret.top - outer.top, width: 1, height: trigger.caret.bottom - trigger.caret.top, ...(room !== undefined && { "--popover-room": `${Math.max(room, 0)}px` }) }}
    >
      <Popover autoAlign open align="bottom-start" className="md-link-popover__popover">
        <span className="md-link-popover__anchor" />
        <PopoverContent>
          <LinkTargetList targets={targets} active={Math.min(active, targets.length - 1)} label="Link to" onPick={(t) => onPick(t, trigger)} />
        </PopoverContent>
      </Popover>
    </div>
  );
}
