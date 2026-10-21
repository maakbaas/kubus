import type { KeyboardEvent, MouseEvent } from "react";
import { ToggleInput } from "../ui/ToggleInput";
import { openModeOf } from "../workspace/Workspace";
import { useStore } from "../app/store";
import { outputOf } from "../domain/templates";
import { TemplateValue } from "../ui/TemplateValue";
import { fieldValue, isMetaField, type FieldDef, type FieldKind, type FieldValue, type ObjectInstance } from "../domain/model";
import { Highlight } from "../ui/Highlight";
import { ImageThumb } from "../ui/images";
import { ObjectLink } from "../ui/ObjectLink";
import { formatValue, type RefOptions } from "../ui/useReferenceOptions";
import type { ObjectActions } from "./registry";

interface Props {
  field: FieldDef;
  object: ObjectInstance;
  refs: RefOptions;
  /** Search text to highlight. */
  search: string;
  actions: ObjectActions;
}

/**
 * Props for a link or tile that opens an object (a table's title cell, a card): plain click here,
 * Ctrl/Cmd click beside, middle click in a new tab (see openModeOf); keyboard activation here.
 */
export function objectLinkProps(object: ObjectInstance, actions: ObjectActions) {
  return {
    "data-own-click": true,
    onClick: (e: MouseEvent | KeyboardEvent) => {
      e.preventDefault();
      actions.open(object, "button" in e ? openModeOf(e) : "here");
    },
    onAuxClick: (e: MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      actions.open(object, "tab");
    },
  };
}

/** Field kinds whose value can be edited right inside a table cell (the rest need more room). */
const INLINE_KINDS: ReadonlySet<FieldKind> = new Set<FieldKind>(["string", "number", "date", "datetime", "object"]);
export const isInlineEditable = (kind: FieldKind) => INLINE_KINDS.has(kind);
export { isMetaField };

/** One field value inside a view (table cell, card line), shared by every view type. */
export function FieldCell({ field, object, refs, search, actions }: Props) {
  const { templates } = useStore();
  const value: FieldValue = fieldValue(object, field);
  // Template images and HTML show as such (a thumbnail, a note); other results as text.
  if (field.kind === "template") {
    const output = outputOf(field, templates);
    if (output === "image" || output === "html") return <TemplateValue value={value} output={output} variant="cell" search={search} />;
  }
  if (field.kind === "checkbox") {
    return (
      // Toggling must not also open the object (row click / card link).
      <span className="cell-checkbox" onClick={(e) => e.stopPropagation()}>
        <ToggleInput
          icon={field.toggleIcon}
          id={`cell-${object.id}-${field.id}`}
          label={field.name}
          checked={value === true}
          onChange={(checked) => actions.setValue(object, field, checked)}
        />
      </span>
    );
  }
  if (field.kind === "image") return typeof value === "string" && value ? <ImageThumb fileId={value} alt="" /> : null;
  if (field.kind === "object_list" && Array.isArray(value)) {
    const options = refs[field.targetTypeId ?? ""];
    if (options) {
      return (
        <>
          {value.map((id, i) => (
            <span key={`${id}-${i}`}>
              {i > 0 && ", "}
              <ObjectLink field={field} id={id} refs={refs} search={search} />
            </span>
          ))}
        </>
      );
    }
  }
  return <Highlight text={formatValue(field, value, refs)} query={search} />;
}
