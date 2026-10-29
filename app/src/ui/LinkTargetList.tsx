import { useEffect, useRef } from "react";
import { ContainedList, ContainedListItem, Tag } from "@carbon/react";
import { Catalog, Document, ListBulleted, View } from "@carbon/icons-react";
import type { LinkTarget, LinkTargetKind } from "../domain/linkTargets";
import { Highlight } from "./Highlight";

const ICONS: Record<LinkTargetKind, typeof View> = { collection: Catalog, view: View, item: Document, field: ListBulleted };
const KIND_LABEL: Record<LinkTargetKind, string> = { collection: "Collection", view: "View", item: "Item", field: "Field" };

/** One option: its kind's icon, its name (`query` marked) and where it is. */
export function LinkTargetRow({ target, query }: { target: LinkTarget; query?: string }) {
  const Icon = ICONS[target.kind];
  const name = target.name || "Untitled";
  return (
    <div className="search-hit link-target" data-kind={target.kind}>
      <div className="search-hit__title">
        <Icon aria-label={KIND_LABEL[target.kind]} />
        <span className="link-target__name">{query ? <Highlight text={name} query={query} /> : name}</span>
        <Tag size="sm" type="cool-gray">
          {target.context}
        </Tag>
      </div>
    </div>
  );
}

/**
 * The options as a Carbon contained list: the Markdown editor's link picker (`active`: the one
 * Enter takes, kept in view; the pointer chooses too) and the search page's link results. With
 * `active` a pick doesn't take focus from where the person is typing.
 */
export function LinkTargetList({
  targets,
  label,
  active,
  query,
  onPick,
}: {
  targets: LinkTarget[];
  label: string;
  active?: number;
  query?: string;
  onPick(target: LinkTarget): void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active !== undefined) list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <div ref={list} className="link-target-list" onMouseDown={(e) => active !== undefined && e.preventDefault()}>
      <ContainedList label={label} kind="on-page">
        {targets.map((t, i) => (
          <ContainedListItem key={t.key} onClick={() => onPick(t)} data-active={active === i} aria-current={active === i ? "true" : undefined}>
            <LinkTargetRow target={t} query={query} />
          </ContainedListItem>
        ))}
      </ContainedList>
    </div>
  );
}
