import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Popover, PopoverContent, TextInput } from "@carbon/react";
import { useLinkTargets } from "../app/useLinkTargets";
import type { LinkTarget } from "../domain/linkTargets";
import { LinkTargetList } from "./LinkTargetList";
import { onViewportChange, panelRoom } from "./panelRoom";

/** Text that is a link with a scheme or a site (`https://…`, `mailto:…`, `//host`): no pages of the app to offer. */
const isExternal = (text: string) => (/^[a-z][a-z0-9+.-]*:/i.test(text) && !text.includes("#/collections/")) || text.startsWith("//");

/**
 * The link dialog's URL field with the link picker's options (LinkPicker) in a popover hanging from it while a page
 * of the app is typed (floating: the dialog or panel it is in keeps its size, autoAlign flips it to the side with room,
 * capped to that room and scrolling inside): ↑ ↓ move, Enter or Tab choose, Escape closes the list (not the dialog), a click
 * chooses. Choosing writes the page's link in its name form (`toShown`), stored by id on Apply.
 * Used alike by the link dialog, the New bookmark dialog (only the pages it can bookmark: `filter`) and a linked
 * block's link: a pick is handed over (`onPick`), and what was typed counts too (Apply, Add, or `onCommit`: the field
 * left or Enter), a problem with it shown under the field (`invalidText`).
 */
export function LinkTargetInput({
  id,
  value,
  onChange,
  toShown,
  labelText = "URL",
  placeholder = "https:// or a page: books/reading-list, book/dune#author",
  helperText,
  invalidText,
  filter,
  onPick,
  onCommit,
  primaryFocus,
}: {
  id: string;
  value: string;
  onChange(value: string): void;
  toShown(href: string): Promise<string>;
  labelText?: string;
  placeholder?: string;
  helperText?: string;
  /** Shown under the field, marking it invalid. */
  invalidText?: string;
  /** Only these options are offered. */
  filter?(target: LinkTarget): boolean;
  /** A page was chosen from the list (after onChange with its name form, `value`; `target` the option picked). */
  onPick?(value: string, target: LinkTarget): void;
  /** The text typed is done: the field is left, or Enter pressed with no list open. */
  onCommit?(): void;
  /** The field a dialog it is in focuses when it opens (Carbon's `data-modal-primary-focus`). */
  primaryFocus?: boolean;
}) {
  const { search, reset } = useLinkTargets();
  const [targets, setTargets] = useState<LinkTarget[]>([]);
  const [active, setActive] = useState(0);
  /** Whether the text was typed here (the list shows only then; a pick, Escape or leaving the field closes it until more
   *  is typed). A press on an option doesn't take the focus (LinkTargetList), so choosing doesn't leave the field. */
  const [typing, setTyping] = useState(false);
  const shown = typing && targets.length > 0;
  // The room beside the field (the roomier side, as the popover flips there), within what can be seen.
  const field = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<number>();
  useEffect(() => {
    if (!shown) return;
    const update = () => {
      const r = field.current?.querySelector("input")?.getBoundingClientRect();
      if (r) setRoom(panelRoom(r, null));
    };
    update();
    return onViewportChange(update);
  }, [shown]);

  useEffect(() => {
    const query = value.trim();
    if (!typing || !query || isExternal(query)) {
      setTargets([]);
      return;
    }
    let current = true;
    search(query, { items: true, limit: 30, filter }).then(
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, typing, search]);
  useEffect(() => reset, [reset]);

  const pick = (t: LinkTarget) => {
    setTyping(false);
    const chosen = (value: string) => {
      onChange(value);
      onPick?.(value, t);
    };
    toShown(t.href).then(chosen, () => chosen(t.href));
  };
  const list = { "--popover-room": `${Math.max(room ?? 256, 0)}px`, "--link-field-width": `${field.current?.offsetWidth ?? 0}px` } as CSSProperties;
  return (
    <div ref={field} className="link-target-input link-picker" style={list}>
      <Popover autoAlign open={shown} align="bottom-start" className="link-target-input__popover">
        <TextInput
          size="sm"
          id={id}
          labelText={labelText}
          placeholder={placeholder}
          helperText={helperText}
          invalid={!!invalidText}
          invalidText={invalidText}
          autoComplete="off"
          {...(primaryFocus && { "data-modal-primary-focus": true })}
          value={value}
          onBlur={() => {
            setTyping(false);
            onCommit?.();
          }}
          onChange={(e) => {
            setTyping(true);
            onChange(e.target.value);
          }}
          onKeyDown={(e) => {
            if (!shown) {
              if (e.key === "Enter" && onCommit) {
                e.preventDefault();
                onCommit();
              }
              return;
            }
            const key = e.key;
            if (key === "ArrowDown") setActive((active + 1) % targets.length);
            else if (key === "ArrowUp") setActive((active - 1 + targets.length) % targets.length);
            else if (key === "Enter" || key === "Tab") pick(targets[Math.min(active, targets.length - 1)]);
            else if (key === "Escape") setTyping(false);
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        />
        <PopoverContent>
          {shown && <LinkTargetList targets={targets} active={Math.min(active, targets.length - 1)} label="Link to" onPick={pick} compact />}
        </PopoverContent>
      </Popover>
    </div>
  );
}
