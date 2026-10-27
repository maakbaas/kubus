import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useInRouterContext } from "react-router";
import { Tag } from "@carbon/react";
import { tagSearchPath } from "../domain/tags";
import { openModeOf, useOpenRelated, type OpenMode } from "../workspace/Workspace";

/**
 * Carbon's look for a tag in text (domain/tags.ts): the same classes are put on tags in the
 * Markdown editor (decorations) and HTML frames, which can't render this component.
 */
export const TAG_TYPE = "cool-gray";
export const TAG_CLASSES = `cds--tag cds--tag--sm cds--layout--size-sm cds--tag--${TAG_TYPE} inline-tag`;

/**
 * A `#tag` in text, rendered as a Carbon tag: clicking it opens the search for it (here,
 * Ctrl/Cmd beside, middle click in a new tab). A span, not a button, as it sits in text that may
 * itself be a link or a button (an item's title, a search result); its click is its own.
 */
export function TagChip({ tag, children }: { tag: string; children?: ReactNode }) {
  // Outside a tab (no router), there is no search to open: shown, not clickable.
  return useInRouterContext() ? <LinkedTag tag={tag}>{children}</LinkedTag> : <InlineTag tag={tag}>{children}</InlineTag>;
}

function InlineTag({ tag, children, ...props }: { tag: string; children?: ReactNode } & Record<string, unknown>) {
  return (
    <Tag as="span" size="sm" type={TAG_TYPE} className="inline-tag" title={tag} {...props}>
      {children ?? tag}
    </Tag>
  );
}

/** Opens the search for a tag; null outside a tab (no router). */
export function useOpenTag(): ((tag: string, mode?: OpenMode) => void) | null {
  const inRouter = useInRouterContext();
  // Whether there is a router never changes for a mounted component.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const openRelated = inRouter ? useOpenRelated() : null;
  return openRelated && ((tag, mode) => openRelated(tagSearchPath(tag), mode));
}

function LinkedTag({ tag, children }: { tag: string; children?: ReactNode }) {
  const openTag = useOpenTag();
  const open = (e: MouseEvent | KeyboardEvent, mode: OpenMode) => {
    e.preventDefault();
    e.stopPropagation();
    openTag?.(tag, mode);
  };
  return (
    <InlineTag
      tag={tag}
      role="link"
      tabIndex={0}
      title={`Search for ${tag}`}
      data-own-click
      onClick={(e: MouseEvent) => open(e, openModeOf(e))}
      onAuxClick={(e: MouseEvent) => e.button === 1 && open(e, "tab")}
      onKeyDown={(e: KeyboardEvent) => e.key === "Enter" && open(e, "here")}
    >
      {children}
    </InlineTag>
  );
}
