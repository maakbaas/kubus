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
 */
export function LinkTargetInput({
  id,
  value,
  onChange,
  toShown,
}: {
  id: string;
  value: string;
  onChange(value: string): void;
  toShown(href: string): Promise<string>;
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
  }, [value, typing, search]);
  useEffect(() => reset, [reset]);

  const pick = (t: LinkTarget) => {
    setTyping(false);
    toShown(t.href).then(onChange, () => onChange(t.href));
  };
  return (
    <div className="link-target-input">
      <TextInput
        size="sm"
        id={id}
        labelText="URL"
        placeholder="https:// or a page: books/reading-list, book/dune#author"
        autoComplete="off"
        value={value}
        onChange={(e) => {
          setTyping(true);
          onChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (!shown) return;
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
