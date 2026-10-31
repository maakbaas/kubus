import { useEffect, useState } from "react";
import { TextInput } from "@carbon/react";
import { useLinkTargets } from "../app/useLinkTargets";
import type { LinkTarget } from "../domain/linkTargets";
import { LinkTargetList } from "./LinkTargetList";

/** Text that is a link with a scheme or a site (`https://…`, `mailto:…`, `//host`): no pages of the app to offer. */
const isExternal = (text: string) => (/^[a-z][a-z0-9+.-]*:/i.test(text) && !text.includes("#/collections/")) || text.startsWith("//");

/**
 * The link dialog's URL field with the link picker's options (LinkPicker) under it while a page of
 * the app is typed: ↑ ↓ move, Enter or Tab choose, Escape closes the list (not the dialog), a click
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
}) {
  const { search, reset } = useLinkTargets();
  const [targets, setTargets] = useState<LinkTarget[]>([]);
  const [active, setActive] = useState(0);
  /** Whether the text was typed here (the list shows only then; a pick or Escape closes it until more is typed).
   *  Not closed when the field is left: the dialog would shrink under a click on Apply. */
  const [typing, setTyping] = useState(false);
  const shown = typing && targets.length > 0;

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
  return (
    <div className="link-target-input">
      <TextInput
        size="sm"
        id={id}
        labelText={labelText}
        placeholder={placeholder}
        helperText={helperText}
        invalid={!!invalidText}
        invalidText={invalidText}
        autoComplete="off"
        value={value}
        onBlur={() => onCommit?.()}
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
      {shown && <LinkTargetList targets={targets} active={Math.min(active, targets.length - 1)} label="Link to" onPick={pick} compact />}
    </div>
  );
}
