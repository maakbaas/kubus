import { useState } from "react";
import { Button, Checkbox, FormGroup, IconButton } from "@carbon/react";
import { Add, ArrowDown, ArrowUp, Edit, Tag, TagNone } from "@carbon/icons-react";
import { isMetaField, type FieldDef, type ObjectType } from "../domain/model";
import { FieldLabel } from "./fieldKindIcons";
import { FieldModal } from "./FieldModal";

/**
 * Picks which fields are shown and in which order (table columns, card fields, object pages):
 * every field with a checkbox, the shown ones first in their order with up / down arrows, the
 * hidden ones after them. `value` null = the default: all fields in the type's order, except
 * `hiddenByDefault` (e.g. an object page's title field, already shown as its title), which still
 * show when ticked. With `hiddenLabels`, each shown
 * field also gets a toggle for its name. With `type`, fields can be added here (a field of the
 * type, shown in this view; templates too) and template fields edited.
 */
export function FieldOrderEditor({
  id,
  label,
  fields,
  value,
  onChange,
  hiddenByDefault = [],
  hiddenLabels,
  onHiddenLabelsChange,
  type,
}: {
  id: string;
  label: string;
  fields: FieldDef[];
  value: string[] | null;
  onChange(value: string[] | null): void;
  hiddenByDefault?: string[];
  /** Fields shown without their name; omit for no name toggles. */
  hiddenLabels?: string[];
  onHiddenLabelsChange?(ids: string[]): void;
  /** The type: enables adding fields and editing template fields from here. */
  type?: ObjectType;
}) {
  /** The field being edited, or "new"; null = no dialog. */
  const [fieldDialog, setFieldDialog] = useState<FieldDef | "new" | null>(null);
  const base = fields.filter((f) => !hiddenByDefault.includes(f.id) && !isMetaField(f)).map((f) => f.id);
  const shown = (value ?? base).filter((fid) => fields.some((f) => f.id === fid));
  const hidden = fields.filter((f) => !shown.includes(f.id));
  const rows = [...shown.map((fid) => fields.find((f) => f.id === fid)!), ...hidden];
  // Stored as null while it is just the default.
  const commit = (next: string[]) => onChange(next.length === base.length && next.every((fid, i) => fid === base[i]) ? null : next);
  const move = (index: number, delta: number) => {
    const next = [...shown];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    commit(next);
  };

  return (
    <FormGroup legendText={label} className="field-order">
      {rows.map((f, i) => {
        const isShown = i < shown.length;
        const nameHidden = hiddenLabels?.includes(f.id) ?? false;
        return (
          <div key={f.id} className="field-order__row">
            <Checkbox
              id={`${id}-${f.id}`}
              labelText={<FieldLabel field={f} />}
              checked={isShown}
              onChange={(_, { checked }) => commit(checked ? [...shown, f.id] : shown.filter((s) => s !== f.id))}
            />
            {isShown && (
              <span className="field-order__moves">
                {hiddenLabels && onHiddenLabelsChange && (
                  <IconButton
                    autoAlign
                    kind="ghost"
                    size="sm"
                    label={nameHidden ? "Show field name" : "Hide field name"}
                    isSelected={nameHidden}
                    onClick={() => onHiddenLabelsChange(nameHidden ? hiddenLabels.filter((h) => h !== f.id) : [...hiddenLabels, f.id])}
                  >
                    {nameHidden ? <TagNone /> : <Tag />}
                  </IconButton>
                )}
                {type && f.kind === "template" && (
                  <IconButton autoAlign kind="ghost" size="sm" label="Edit template" onClick={() => setFieldDialog(f)}>
                    <Edit />
                  </IconButton>
                )}
                <IconButton autoAlign kind="ghost" size="sm" label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp />
                </IconButton>
                <IconButton autoAlign kind="ghost" size="sm" label="Move down" disabled={i === shown.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown />
                </IconButton>
              </span>
            )}
          </div>
        );
      })}
      {type && (
        <Button kind="tertiary" size="sm" renderIcon={Add} iconDescription="Add field" className="field-order__add" onClick={() => setFieldDialog("new")}>
          Add field
        </Button>
      )}
      {type && fieldDialog && (
        <FieldModal
          type={type}
          field={fieldDialog === "new" ? null : fieldDialog}
          onClose={() => setFieldDialog(null)}
          onSaved={() => {
            // The field is saved already and every view showing all fields has it; a view with its
            // own order only gets it once chosen there.
            setFieldDialog(null);
          }}
        />
      )}
    </FormGroup>
  );
}
