import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react";
import { IconButton, TextInput } from "@carbon/react";
import { Add, TrashCan } from "@carbon/icons-react";
import { useStore } from "../app/store";
import { checklistItems, itemString, type ChecklistItem } from "../domain/checklist";
import type { FieldDef, FieldValue } from "../domain/model";
import { captureEditStart } from "./editStart";
import { WrappedTextBox } from "./FieldInput";
import { FieldLabel } from "./fieldKindIcons";
import { Highlight } from "./Highlight";
import { RefCombo } from "./RefCombo";
import { RelatedLink } from "./RelatedLink";
import { ToggleInput } from "./ToggleInput";
import { labelOf, type RefOptions } from "./useReferenceOptions";
import { moveBlock, useReorder } from "./useReorder";

/** The items as stored (an item's text trimmed; empty items are kept). */
function storedValue(items: ChecklistItem[], checklist: boolean): FieldValue {
  const kept = items.map((i) => ({ ...i, text: i.text.trim() }));
  return kept.length ? kept.map((i) => (checklist ? itemString(i) : i.text)) : null;
}

/**
 * A list field on an item page (list of strings, checklist, list of items), edited one item at a time like a
 * table cell: clicking an item's text turns just that item into an input, the caret where it was
 * clicked. Tab moves in the usual order (checkbox, text, remove icon, next item…): leaving the
 * input saves it, tabbing onto an item's text edits it. Enter saves and adds a new item below,
 * Escape stops editing (an empty item goes), clicking elsewhere saves. Each item has its remove icon; "+" below adds one; a
 * checklist's boxes toggle right away. Every change is saved at once; an item just added and
 * left empty is dropped again, other empty items are kept. Items move up and down with arrow icons. A list of items keeps each item's id as
 * the item's text and shows a ComboBox per item (always, so nothing to click first).
 */
export function ListField({
  field,
  value,
  readOnly,
  refs,
  onSave,
}: {
  field: FieldDef;
  value: FieldValue;
  readOnly?: boolean;
  /** Selectable items, for a list of items. */
  refs?: RefOptions;
  onSave(value: FieldValue): void;
}) {
  const checklist = field.kind === "checklist";
  const itemList = field.kind === "item_list";
  const { collections } = useStore();
  const target = collections.find((t) => t.id === field.targetCollectionId);
  const options = refs?.[field.targetCollectionId ?? ""] ?? [];
  // Unique per instance (an item can be open in two tabs): its inputs are looked up by id.
  const uid = useId();
  const fromValue = (v: FieldValue) => (checklist ? checklistItems(v) : (Array.isArray(v) ? v : []).map((text) => ({ text, done: false })));
  const [items, setItems] = useState<ChecklistItem[]>(() => fromValue(value));
  /**
   * The item being edited, the caret / selection to start with (offsets in its text), and whether
   * its text was shown over several lines (then it edits in a box wrapping it the same way).
   */
  const [editing, setEditing] = useState<{ index: number; range?: { start: number; end: number }; wrapped?: boolean } | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;

  // The stored value changed (saved here, or elsewhere): show it, unless an item is being edited.
  const valueKey = JSON.stringify(value ?? null);
  useEffect(() => {
    if (!editingRef.current) setItems(fromValue(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueKey]);

  /** Shows `next` and saves it (when it differs from what is stored). */
  const save = (next: ChecklistItem[]) => {
    setItems(next);
    const stored = storedValue(next, checklist);
    if (JSON.stringify(stored ?? null) !== valueKey) onSave(stored);
  };
  /** The item just added by "+" / Enter and not yet filled: dropped again when left empty. */
  const freshRef = useRef<number | null>(null);
  /** The items without that added item if it is still empty (cancelled add); only it goes. */
  const settled = () => {
    const f = freshRef.current;
    freshRef.current = null;
    return f !== null && items[f] && !items[f].text.trim() ? items.filter((_, i) => i !== f) : items;
  };
  /** Stops editing: saved. */
  const finish = () => {
    setEditing(null);
    save(settled());
  };
  const edit = (index: number, range?: { start: number; end: number }, wrapped?: boolean) => {
    if (editing) {
      const f = freshRef.current;
      save(settled());
      if (f !== null && f < index && !items[f].text.trim()) index--;
    }
    setEditing({ index, range, wrapped });
  };
  const insert = (at: number) => {
    save(items);
    setItems([...items.slice(0, at), { text: "", done: false }, ...items.slice(at)]);
    freshRef.current = at;
    setEditing({ index: at });
  };
  const reorder = useReorder({
    count: items.length,
    onMove: (start, end, to) => {
      freshRef.current = null;
      setEditing(null);
      save(moveBlock(items, start, end, to));
    },
    onDelete: (indices) => {
      freshRef.current = null;
      setEditing(null);
      save(items.filter((_, i) => !indices.includes(i)));
    },
    noun: ["entry", "entries"],
  });
  const remove = (index: number) => {
    freshRef.current = null;
    setEditing(null);
    save(items.filter((_, i) => i !== index));
  };

  // The edited item's input gets the caret (where its text was clicked, else at the end).
  const inputId = (i: number) => `${uid}-list-${i}`;
  useLayoutEffect(() => {
    if (!editing) return;
    const input = document.getElementById(inputId(editing.index));
    // A wrapped item's text box places its caret itself.
    if (!(input instanceof HTMLInputElement)) return;
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(Math.min(editing.range?.start ?? end, end), Math.min(editing.range?.end ?? end, end));
    // Only when another item starts being edited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  /** Enter adds an item below, Escape stops (an empty item goes); for the input and the wrapped box alike. */
  const onItemKey = (i: number) => (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      insert(i + 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (!items[i].text.trim()) remove(i);
      else finish();
    }
  };
  /** Leaving the item saves it; moving into another of its items' inputs (Enter adding one) isn't leaving. */
  const onItemBlur = (e: FocusEvent<HTMLElement>) => {
    const to = e.relatedTarget as HTMLElement | null;
    if (!to?.id.startsWith(`${uid}-list-`)) finish();
  };
  const setText = (i: number, text: string) => setItems(items.map((x, j) => (j === i ? { ...x, text } : x)));

  const rows = items.length > 0 || editing ? items : [];
  return (
    <div className="view-field">
      <div className="cds--label">
        <FieldLabel field={field} />
      </div>
      <div className="view-field__rows">
        {rows.length === 0 && readOnly && <div className="view-field__value view-field__value--empty" />}
        {rows.map((item, i) => (
          <div key={i} className="checklist-row" {...(readOnly ? {} : reorder.row(i))}>
            {checklist && (
              <span className="checklist-box">
                <ToggleInput
                  icon={field.toggleIcon}
                  id={`${uid}-box-${i}`}
                  label={item.text || `${field.name} ${i + 1}`}
                  checked={item.done}
                  onChange={(done) => save(items.map((x, j) => (j === i ? { ...x, done } : x)))}
                />
              </span>
            )}
            {itemList && editing?.index === i ? (
              <RefCombo
                id={inputId(i)}
                field={field}
                label={`${field.name} ${i + 1}`}
                options={options}
                chosen={items.map((x) => x.text)}
                value={item.text}
                placeholder={`Choose ${target?.name ?? "an item"}`}
                onChange={(id) => {
                  freshRef.current = null;
                  setEditing(null);
                  save(items.map((x, j) => (j === i ? { ...x, text: id } : x)));
                }}
                onLeave={finish}
              />
            ) : editing?.index === i && editing.wrapped ? (
              <WrappedTextBox
                id={inputId(i)}
                field={field}
                label={`${field.name} ${i + 1}`}
                value={item.text}
                start={{ point: { x: 0, y: 0 }, range: editing.range }}
                onChange={(v) => setText(i, String(v ?? ""))}
                onKeyDown={onItemKey(i)}
                onBlur={onItemBlur}
              />
            ) : editing?.index === i ? (
              <TextInput
                size="sm"
                id={inputId(i)}
                labelText={`${field.name} ${i + 1}`}
                hideLabel
                value={item.text}
                onChange={(e) => setText(i, e.target.value)}
                onBlur={onItemBlur}
                onKeyDown={onItemKey(i)}
              />
            ) : (
              <div
                className={`view-field__value${readOnly ? "" : " view-field__editable"}${checklist && item.done ? ` checklist-row__done${field.strikeThrough ? " checklist-row__done--struck" : ""}` : ""}${(itemList ? labelOf(options, item.text) : item.text) ? "" : " view-field__value--empty"}`}
                {...(readOnly
                  ? {}
                  : {
                      role: "button",
                      tabIndex: 0,
                      "aria-label": `Edit ${field.name} ${i + 1}`,
                      // Mouse: editing starts on the click, caret where clicked (no focus first,
                      // which would start it before the click position is known). Keyboard: on focus.
                      onMouseDown: (e: MouseEvent<HTMLDivElement>) => e.preventDefault(),
                      onClick: (e: MouseEvent<HTMLDivElement>) => {
                        const start = captureEditStart(e.currentTarget, e);
                        edit(i, start.range, !itemList && start.wrapped);
                      },
                      onFocus: () => edit(i),
                    })}
              >
                {itemList ? (
                  labelOf(options, item.text) !== undefined && (
                    <RelatedLink path={`/collections/${field.targetCollectionId}/items/${item.text}`}>
                      <Highlight text={labelOf(options, item.text) ?? ""} query="" />
                    </RelatedLink>
                  )
                ) : (
                  <Highlight text={item.text} query="" links />
                )}
              </div>
            )}
            {!readOnly && (
              <IconButton autoAlign kind="ghost" size="sm" align="top" label="Remove item" onMouseDown={(e) => e.preventDefault()} {...reorder.remove(i, () => remove(i))}>
                <TrashCan />
              </IconButton>
            )}
            {/* The drag handle is always a row's last icon. */}
            {!readOnly && reorder.handle(i)}
          </div>
        ))}
        {!readOnly && (
          <div className={`list-input__row list-input__add ${rows.length === 0 ? "list-input__add--empty" : "list-input__add--rows"}`}>
            {/* Under the checkboxes when there are any; else at the left. */}
            {checklist && rows.length > 0 && <span className="checklist-box" />}
            <IconButton autoAlign kind="ghost" size="sm" align="right" label="Add item" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(items.length)}>
              <Add />
            </IconButton>
          </div>
        )}
      </div>
      {reorder.dialog}
    </div>
  );
}
