import { useId, type KeyboardEvent, type MouseEvent } from "react";
import { Link } from "@carbon/react";
import { htmlPreview, markdownPreviewParts } from "../domain/fieldKinds";
import { isOpenableUrl, openExternal } from "../platform/openExternal";
import { ToggleInput } from "../ui/ToggleInput";
import { openModeOf } from "../workspace/Workspace";
import { useStore } from "../app/store";
import { outputOf } from "../domain/components";
import { ComponentValue } from "../ui/ComponentValue";
import { fieldValue, isMetaField, type FieldDef, type FieldKind, type FieldValue, type Item } from "../domain/model";
import { AiStatus } from "../ui/AiStatus";
import { Highlight } from "../ui/Highlight";
import { ImageThumb } from "../ui/images";
import { ItemLink } from "../ui/ItemLink";
import { formatValue, type RefOptions } from "../ui/useReferenceOptions";
import type { ItemActions } from "./registry";

interface Props {
  field: FieldDef;
  item: Item;
  refs: RefOptions;
  /** Search text to highlight. */
  search: string;
  actions: ItemActions;
}

/**
 * Props for a link or tile that opens an item (a table's title cell, a card): plain click here,
 * Ctrl/Cmd click beside, middle click in a new tab (see openModeOf); keyboard activation here.
 */
export function itemLinkProps(item: Item, actions: ItemActions) {
  return {
    "data-own-click": true,
    onClick: (e: MouseEvent | KeyboardEvent) => {
      e.preventDefault();
      actions.open(item, "button" in e ? openModeOf(e) : "here");
    },
    onAuxClick: (e: MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      actions.open(item, "tab");
    },
  };
}

/** Field kinds whose value can be edited right inside a table cell (the rest need more room). */
const INLINE_KINDS: ReadonlySet<FieldKind> = new Set<FieldKind>(["string", "number", "date", "datetime", "item"]);
export const isInlineEditable = (kind: FieldKind) => INLINE_KINDS.has(kind);
export { isMetaField };

/**
 * Markdown as a one-line preview (syntax stripped, see markdownPreviewParts) whose links stay
 * links: they open in the browser, without also opening the item or editing the cell.
 */
function MarkdownPreview({ source, search }: { source: string; search: string }) {
  return (
    <span>
      {markdownPreviewParts(source).map((part, i) =>
        typeof part === "string" || !isOpenableUrl(part.href) ? (
          <Highlight key={i} text={typeof part === "string" ? part : part.text} query={search} />
        ) : (
          <Link
            key={i}
            href={part.href}
            data-own-click
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openExternal(part.href);
            }}
          >
            <Highlight text={part.text} query={search} />
          </Link>
        ),
      )}
    </span>
  );
}

/** One field value inside a view (table cell, card line), shared by every view type. */
export function FieldCell({ field, item, refs, search, actions }: Props) {
  const { components } = useStore();
  // Element ids unique per cell: the same item can show in several blocks, panes and tabs at once.
  const uid = useId();
  const value: FieldValue = fieldValue(item, field);
  // HTML (a field, or a component's result) shows its text; without any (a chart, a map) a note.
  const html = field.kind === "html" || (field.kind === "component" && outputOf(field, components) === "html");
  if (html && typeof value === "string" && value) {
    const text = htmlPreview(value);
    return text ? <Highlight text={text} query={search} /> : <ComponentValue value={value} output="html" variant="cell" search={search} />;
  }
  // Component images show as a thumbnail; other results as text.
  if (field.kind === "component") {
    const output = outputOf(field, components);
    if (output === "image") return <ComponentValue value={value} output={output} variant="cell" search={search} />;
    // Text and number results read exactly like a string or number field (no Markdown preview,
    // which would strip characters such as `*`).
    if (output !== "markdown") return <Highlight text={value == null ? "" : String(value)} query={search} />;
  }
  // Generated values: as their output type reads; until there is one, what it is waiting for.
  if (field.kind === "ai") {
    const shown = value == null || value === "" ? null : typeof value === "string" && field.output === "markdown" ? <MarkdownPreview source={value} search={search} /> : <Highlight text={String(value)} query={search} />;
    return (
      <AiStatus itemId={item.id} fieldId={field.id} compact>
        {shown}
      </AiStatus>
    );
  }
  if ((field.kind === "markdown" || field.kind === "component") && typeof value === "string") return <MarkdownPreview source={value} search={search} />;
  if (field.kind === "checkbox") {
    return (
      // Toggling must not also open the item (row click / card link).
      <span className="cell-checkbox" onClick={(e) => e.stopPropagation()}>
        <ToggleInput
          icon={field.toggleIcon}
          id={`${uid}-cell-${item.id}-${field.id}`}
          label={field.name}
          checked={value === true}
          onChange={(checked) => actions.setValue(item, field, checked)}
        />
      </span>
    );
  }
  if (field.kind === "image") return typeof value === "string" && value ? <ImageThumb fileId={value} alt="" /> : null;
  if (field.kind === "item_list" && Array.isArray(value)) {
    const options = refs[field.targetCollectionId ?? ""];
    if (options) {
      return (
        <>
          {value.map((id, i) => (
            <span key={`${id}-${i}`}>
              {i > 0 && ", "}
              <ItemLink field={field} id={id} refs={refs} search={search} />
            </span>
          ))}
        </>
      );
    }
  }
  return <Highlight text={formatValue(field, value, refs)} query={search} />;
}
