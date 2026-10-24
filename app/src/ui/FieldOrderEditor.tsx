import { useState, type ReactElement } from "react";
import { Button, Checkbox, FormGroup, IconButton } from "@carbon/react";
import { Add, Tag, TagNone } from "@carbon/icons-react";
import { isMetaField, type FieldDef, type Collection } from "../domain/model";
import { FieldLabel } from "./fieldKindIcons";
import { FieldModal } from "./FieldModal";
import { moveBlock, useReorder } from "./useReorder";

/**
 * Picks which fields are shown and in which order (table columns, card fields, item pages):
 * every field with a checkbox and a drag handle; rows keep their place when ticked or unticked
 * (Space shows / hides the selected rows). `value` null = the default: all fields in the collection's order, except
 * `hiddenByDefault` (e.g. an item page's title field, already shown as its title), which still
 * show when ticked. With `hiddenLabels`, each shown
 * field also gets a toggle for its name. With `collection`, fields can be added here (a field of the
 * collection, shown in this view; components too). `extra` rows (an item page's blocks) are
 * ordered and shown / hidden among the fields, as if they were fields.
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
  collection,
  extra = [],
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
  /** The collection: enables adding fields from here. */
  collection?: Collection;
  /** Rows that aren't fields (ids and labels), listed after them by default. */
  extra?: { id: string; label: ReactElement }[];
}) {
  /** Whether the add-field dialog is open. */
  const [adding, setAdding] = useState(false);
  const entries = [
    ...fields.map((f) => ({ id: f.id, label: <FieldLabel field={f} /> as ReactElement, isField: true, meta: isMetaField(f) })),
    ...extra.map((e) => ({ ...e, isField: false, meta: false })),
  ];
  const all = entries.map((e) => e.id);
  const base = entries.filter((e) => !hiddenByDefault.includes(e.id) && !e.meta).map((e) => e.id);
  const shown = (value ?? base).filter((fid) => all.includes(fid));
  // Every field has a fixed row (the shown ones first, as stored, when this opens); ticking or
  // unticking one doesn't move it. Rows follow the stored order again if that changes elsewhere.
  const [order, setOrder] = useState<string[]>([]);
  const known = order.filter((fid) => all.includes(fid));
  const fresh = all.filter((fid) => !known.includes(fid));
  const sameShown = known.filter((fid) => shown.includes(fid)).join() === shown.join();
  const ids = sameShown && known.length > 0 ? [...known, ...fresh] : [...shown, ...all.filter((fid) => !shown.includes(fid))];
  const rows = ids.map((fid) => entries.find((e) => e.id === fid)!);
  // Stored as null while it is just the default.
  const commit = (rowIds: string[], on: Set<string>) => {
    setOrder(rowIds);
    const next = rowIds.filter((fid) => on.has(fid));
    onChange(next.length === base.length && next.every((fid, i) => fid === base[i]) ? null : next);
  };
  const reorder = useReorder({
    count: rows.length,
    onMove: (start, end, to) => commit(moveBlock(ids, start, end, to), new Set(shown)),
    // Space: show the selected fields, or hide them when all are shown.
    onSpace: (indices) => {
      const picked = indices.map((i) => ids[i]);
      const on = new Set(shown);
      const hide = picked.every((fid) => on.has(fid));
      for (const fid of picked) hide ? on.delete(fid) : on.add(fid);
      commit(ids, on);
    },
  });

  return (
    <FormGroup legendText={label} className="field-order">
      {rows.map((f, i) => {
        const isShown = shown.includes(f.id);
        const nameHidden = hiddenLabels?.includes(f.id) ?? false;
        return (
          <div key={f.id} className="field-order__row" {...reorder.row(i)}>
            <Checkbox
              id={`${id}-${f.id}`}
              labelText={f.label}
              checked={isShown}
              onChange={(_, { checked }) => commit(ids, new Set(checked ? [...shown, f.id] : shown.filter((s) => s !== f.id)))}
            />
            <span className="field-order__moves">
              {isShown && f.isField && hiddenLabels && onHiddenLabelsChange && (
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
              {reorder.handle(i)}
            </span>
          </div>
        );
      })}
      {collection && (
        <Button kind="tertiary" size="sm" renderIcon={Add} iconDescription="Add field" className="field-order__add" onClick={() => setAdding(true)}>
          Add field
        </Button>
      )}
      {collection && adding && (
        <FieldModal
          collection={collection}
          field={null}
          onClose={() => setAdding(false)}
          onSaved={() => {
            // The field is saved already and every view showing all fields has it; a view with its
            // own order only gets it once chosen there.
            setAdding(false);
          }}
        />
      )}
    </FormGroup>
  );
}
