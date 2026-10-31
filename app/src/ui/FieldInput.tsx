import { useId, useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  ComboBox,
  DatePicker,
  DatePickerInput,
  FormGroup,
  IconButton,
  Stack,
  TextInput,
  TimePicker,
} from "@carbon/react";
import { Add, TrashCan } from "@carbon/icons-react";
import { itemString, parseItem, type ChecklistItem } from "../domain/checklist";
import { formatDate, formatTime } from "../domain/fieldKinds";
import { stringList, type FieldDef, type FieldKind, type FieldValue, type Collection } from "../domain/model";
import type { EditStart } from "./editStart";
import { FieldLabel } from "./fieldKindIcons";
import { ImageInput } from "./images";
import { MarkdownEditor } from "./MarkdownEditor";
import { ComponentCodeEditor } from "./ComponentCodeEditor";
import { RefCombo } from "./RefCombo";
import { ToggleInput } from "./ToggleInput";
import { choicesFor, type RefOption } from "./useReferenceOptions";
import { moveBlock, useReorder } from "./useReorder";

/**
 * Raw editor state: strings for text-like inputs, boolean for checkboxes,
 * string[] for lists. Datetime is kept as "YYYY-MM-DDTHH:mm" (local), either part may be empty.
 */
export type InputValue = string | boolean | string[];

export function toInputValue(kind: FieldKind, value: FieldValue | undefined): InputValue {
  switch (kind) {
    case "component":
    case "ai":
      return ""; // computed or generated, never entered
    case "checkbox":
      return value === true;
    case "number":
      return typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
    case "datetime": {
      if (typeof value !== "string") return "";
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? "" : `${formatDate(d)}T${formatTime(d)}`;
    }
    case "string_list":
    case "number_list":
    case "checklist":
    case "item_list":
      return stringList(value);
    case "string":
    case "markdown":
    case "html":
    case "date":
    case "image":
    case "item":
      return typeof value === "string" ? value : "";
  }
}

export function parseInputValue(kind: FieldKind, raw: InputValue): { value: FieldValue } | { error: string } {
  const s = typeof raw === "string" ? raw.trim() : "";
  switch (kind) {
    case "component":
    case "ai":
      return { value: null };
    case "checkbox":
      return { value: raw === true };
    case "string":
    case "markdown":
    case "html":
      return { value: s === "" ? null : String(raw) };
    case "image":
    case "item":
      return { value: s || null };
    case "string_list": {
      const items = withoutTrailingEmpty((raw as string[]).map((x) => x.trim()), (x) => x === "");
      return { value: items.length > 0 ? items : null };
    }
    case "number_list": {
      const entries = withoutTrailingEmpty((raw as string[]).map((x) => x.trim()), (x) => x === "").filter((x) => x !== "");
      const numbers = entries.map(Number);
      if (numbers.some((n) => !Number.isFinite(n))) return { error: "Each entry is a number" };
      return { value: numbers.length > 0 ? numbers : null };
    }
    case "checklist": {
      // Each item keeps its "[x] " / "[ ] " marker.
      const items = withoutTrailingEmpty((raw as string[]).map(parseItem).map((i) => ({ ...i, text: i.text.trim() })), (i) => i.text === "");
      return { value: items.length > 0 ? items.map(itemString) : null };
    }
    case "item_list": {
      const ids = (raw as string[]).filter(Boolean);
      return { value: ids.length > 0 ? ids : null };
    }
    case "number": {
      if (s === "") return { value: null };
      const n = Number(s);
      return Number.isFinite(n) ? { value: n } : { error: "Not a valid number" };
    }
    case "date":
      // The picker only reports days it parsed, so the text is always yyyy-mm-dd (or empty).
      return { value: s === "" ? null : s };
    case "datetime": {
      const [date = "", time = ""] = s.split("T");
      if (!date && !time) return { value: null };
      if (!date) return { error: "Pick a date" };
      const t = time || "00:00";
      if (!TIME_24H.test(t)) return { error: "Use hh:mm (24h)" };
      // No zone → local time; the date is the picker's, so always valid.
      return { value: new Date(`${date}T${t}`).toISOString() };
    }
  }
}

const TIME_24H = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A list's items without the empty ones at its end (a row added but left empty); empty items in between are kept. */
function withoutTrailingEmpty<T>(items: T[], isEmpty: (item: T) => boolean): T[] {
  let end = items.length;
  while (end > 0 && isEmpty(items[end - 1])) end--;
  return items.slice(0, end);
}

/** After "Add item": the new row's text input gets the caret (once it has rendered). */
const focusRow = (inputId: string) => requestAnimationFrame(() => document.getElementById(inputId)?.focus());

interface Props {
  field: FieldDef;
  value: InputValue;
  error?: string;
  /** Selectable items and their collection, for reference kinds. */
  options?: RefOption[];
  target?: Collection;
  onChange(value: InputValue): void;
  /** Called for every file stored while editing (images), so unsaved ones can be released. */
  onFileStored?(fileId: string): void;
  /** Markdown only: where editing should start (caret / selection placed there). */
  start?: EditStart;
  /** Table cells: small inputs with hidden labels (string, number, date(time), item, checkbox). */
  compact?: boolean;
  /** Prefix for element ids, so one field can be rendered twice (e.g. a cell and the add row). */
  idPrefix?: string;
  /** Text inputs: placeholder. */
  placeholder?: string;
  /** Compact strings only: a box that wraps (the value stays one line; Enter still saves). */
  multiline?: boolean;
}

export function FieldInput({
  field,
  value,
  error,
  options = [],
  target,
  onChange,
  onFileStored,
  start,
  compact,
  idPrefix = "field",
  placeholder,
  multiline,
}: Props) {
  const uid = useId();
  const id = `${uid}-${idPrefix}-${field.id}`;
  const invalid = { invalid: !!error, invalidText: error };
  // Compact (table cells): Carbon's small size, labels kept only for screen readers.
  const small = compact ? { size: "sm" as const, hideLabel: true } : {};

  switch (field.kind) {
    case "checkbox": {
      // In a table cell just the box; in a form the box with the field's name to its right,
      // laid out like a checklist item (as on the item page).
      const box = (
        <ToggleInput icon={field.toggleIcon} id={id} label={field.name} checked={value === true} onChange={onChange} />
      );
      if (compact) return box;
      return (
        <div className="cds--form-item">
          <div className="cds--label">
            <FieldLabel field={field} />
          </div>
          <div className="checklist-row">
            <span className="checklist-box">{box}</span>
            <label htmlFor={id} className={`checkbox-field__name${value === true ? ` checklist-row__done${field.strikeThrough ? " checklist-row__done--struck" : ""}` : ""}`}>
              {field.name}
            </label>
          </div>
        </div>
      );
    }

    case "number":
      return (
        // A text input with a decimal keyboard rather than Carbon's NumberInput: the text stays
        // exactly as typed (no "4.90" turning into 4.9 mid-typing).
        <TextInput size="sm"
          id={id}
          labelText={<FieldLabel field={field} />}
          inputMode="decimal"
          autoComplete="off"
          placeholder={placeholder}
          value={String(value)}
          // The iOS decimal keyboard types a comma where a dot is expected.
          onChange={(e) => onChange(e.target.value.replace(",", "."))}
          {...small}
          {...invalid}
        />
      );

    case "date":
      return (
        <DatePicker
          datePickerType="single"
          dateFormat="Y-m-d"
          value={String(value)}
          onChange={(dates) => onChange(dates[0] ? formatDate(dates[0]) : "")}
        >
          <DatePickerInput size="sm" id={id} labelText={<FieldLabel field={field} />} placeholder="yyyy-mm-dd" {...small} {...invalid} />
        </DatePicker>
      );

    case "datetime": {
      const [date = "", time = ""] = String(value).split("T");
      // One error for the pair; show it on the part that is wrong.
      const timeWrong = !!error && time !== "" && !TIME_24H.test(time);
      const dateError = timeWrong ? {} : invalid;
      const timeError = timeWrong ? invalid : {};
      return (
        <div className="datetime-input">
          <DatePicker
            datePickerType="single"
            dateFormat="Y-m-d"
            value={date}
            onChange={(dates) => onChange(`${dates[0] ? formatDate(dates[0]) : ""}T${time}`)}
          >
            <DatePickerInput size="sm" id={id} labelText={<FieldLabel field={field} />} placeholder="yyyy-mm-dd" {...small} {...dateError} />
          </DatePicker>
          <TimePicker size="sm"
            id={`${id}-time`}
            labelText="Time"
            placeholder="hh:mm"
            maxLength={5}
            value={time}
            onChange={(e) => onChange(`${date}T${e.target.value}`)}
            {...small}
            {...timeError}
          />
        </div>
      );
    }

    case "item":
      return (
        <ComboBox<RefOption> autoAlign size="sm"
          id={id}
          titleText={compact ? undefined : <FieldLabel field={field} />}
          aria-label={field.name}
          placeholder={`Choose ${target?.name ?? "an item"}`}
          items={choicesFor(field, options, value ? [value as string] : [])}
          itemToString={(o) => o?.label ?? ""}
          selectedItem={options.find((o) => o.id === value) ?? null}
          onChange={({ selectedItem }) => onChange(selectedItem?.id ?? "")}
          {...invalid}
        />
      );

    case "item_list": {
      const ids = value as string[];
      return (
        <ListInput<string>
          id={id}
          field={field}
          items={ids}
          empty=""
          textOf={(item) => item}
          withText={(_, text) => text}
          control={(item, i, set) => (
            <RefCombo
              id={`${id}-${i}`}
              field={field}
              label={`${field.name} ${i + 1}`}
              options={options}
              chosen={ids}
              value={item}
              placeholder={`Choose ${target?.name ?? "an item"}`}
              onChange={set}
            />
          )}
          onChange={onChange}
        />
      );
    }

    case "string_list":
    case "number_list":
      return (
        <ListInput<string>
          id={id}
          field={field}
          items={value as string[]}
          empty=""
          textOf={(item) => item}
          withText={(_, text) => text}
          onChange={onChange}
        />
      );

    case "checklist":
      // Each item's checkbox in front of its text.
      return (
        <ListInput<ChecklistItem>
          id={id}
          field={field}
          items={(value as string[]).map(parseItem)}
          empty={{ text: "", done: false }}
          textOf={(item) => item.text}
          withText={(item, text) => ({ ...item, text })}
          lead={(item, i, set) => (
            <ToggleInput
              icon={field.toggleIcon}
              id={`${id}-${i}-done`}
              label={`${field.name} ${i + 1} done`}
              checked={item.done}
              onChange={(done) => set({ ...item, done })}
            />
          )}
          onChange={(items) => onChange(items.map(itemString))}
        />
      );

    case "component":
    case "ai":
      return null; // computed or generated, never entered

    case "markdown":
      return (
        <MarkdownEditor
          label={<FieldLabel field={field} />}
          value={String(value)}
          onChange={onChange}
          onFileStored={onFileStored}
          start={start}
        />
      );

    case "html":
      // The source, highlighted (with {{ }} sections, as in the component editor).
      return <ComponentCodeEditor id={id} labelText={<FieldLabel field={field} />} value={String(value)} html onChange={onChange} />;

    case "image":
      return (
        <ImageInput
          id={id}
          label={<FieldLabel field={field} />}
          value={String(value)}
          error={error}
          onChange={onChange}
          onFileStored={onFileStored}
        />
      );

    case "string":
      // A text shown over several lines edits in a box that wraps it the same way, so nothing moves.
      if (multiline) {
        const box = <WrappedTextBox id={id} field={field} value={String(value)} start={start} compact={compact} onChange={onChange} />;
        return compact ? (
          box
        ) : (
          <div className="view-field">
            <label htmlFor={id} className="cds--label">
              <FieldLabel field={field} />
            </label>
            {box}
          </div>
        );
      }
      return (
        <TextInput size="sm"
          id={id}
          labelText={<FieldLabel field={field} />}
          placeholder={placeholder}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          {...small}
          {...invalid}
        />
      );
  }
}

/**
 * A list edited like the table's inline rows: one text input per item with a delete icon at its
 * right, and "+" below the list adding an item. Enter in an item adds a new one below it (the
 * caret moves there; Ctrl/Cmd+Enter still saves the field); Escape in an empty item that isn't
 * the only one removes it again (otherwise Escape cancels the edit). An empty list shows one
 * empty item. Checklists put each item's checkbox in front (`lead`, in a .checklist-box).
 */
function ListInput<T>({
  id,
  field,
  items,
  empty,
  textOf,
  withText,
  lead,
  control,
  onChange,
}: {
  id: string;
  field: FieldDef;
  items: T[];
  empty: T;
  textOf(item: T): string;
  withText(item: T, text: string): T;
  lead?(item: T, index: number, set: (item: T) => void): ReactNode;
  /** Replaces an item's text input (reference lists: a ComboBox; `set` takes the item's text). */
  control?(item: T, index: number, set: (text: string) => void): ReactNode;
  onChange(items: T[]): void;
}) {
  const rows = items.length > 0 ? items : [empty];
  const set = (i: number, item: T) => onChange(rows.map((x, j) => (j === i ? item : x)));
  const reorder = useReorder({
    count: rows.length,
    onMove: (start, end, to) => onChange(moveBlock(rows, start, end, to)),
    onDelete: (indices) => onChange(rows.filter((_, i) => !indices.includes(i))),
    canDelete: (indices) => indices.length < rows.length,
    noun: ["entry", "entries"],
  });
  const insert = (at: number) => {
    onChange([...rows.slice(0, at), empty, ...rows.slice(at)]);
    focusRow(`${id}-${at}`);
  };
  const remove = (i: number) => {
    onChange(rows.filter((_, j) => j !== i));
    focusRow(`${id}-${Math.max(0, i - 1)}`);
  };
  const leadSlot = (content?: ReactNode) => lead && <span className="checklist-box">{content}</span>;
  return (
    <FormGroup legendText={<FieldLabel field={field} />}>
      <Stack gap={3}>
        {rows.map((item, i) => {
          const removable = rows.length > 1 && textOf(item) === "";
          return (
            // Marked for the field editor: Enter here adds an item, Escape in a removable one removes it.
            <div className="list-input__row" key={i} {...reorder.row(i)} data-list-row="" data-list-row-removable={removable ? "" : undefined}>
              {leadSlot(lead?.(item, i, (next) => set(i, next)))}
              {control ? (
                control(item, i, (text) => set(i, withText(item, text)))
              ) : (
                <TextInput
                  size="sm"
                  id={`${id}-${i}`}
                  labelText={`${field.name} ${i + 1}`}
                  hideLabel
                  value={textOf(item)}
                  onChange={(e) => set(i, withText(item, e.target.value))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
                      e.preventDefault();
                      insert(i + 1);
                    } else if (e.key === "Escape" && removable) {
                      e.preventDefault();
                      remove(i);
                    }
                  }}
                />
              )}
              <IconButton
                autoAlign
                kind="ghost"
                size="sm"
                align="top"
                label="Remove item"
                disabled={rows.length === 1 && textOf(item) === ""}
                onClick={() => remove(i)}
              >
                <TrashCan />
              </IconButton>
              {/* The drag handle is always a row's last icon. */}
              {reorder.handle(i)}
            </div>
          );
        })}
        <div className="list-input__row list-input__add">
          {leadSlot()}
          <IconButton autoAlign kind="ghost" size="sm" align="right" label="Add item" onClick={() => insert(rows.length)}>
            <Add />
          </IconButton>
        </div>
      </Stack>
      {reorder.dialog}
    </FormGroup>
  );
}

/**
 * The editor of a text shown over several lines (a wrapped table cell, a long value on an item
 * page): an editable text block in place of the text. Unlike a <textarea> (a form control, whose
 * text is rounded to the pixel differently) it lays out and draws its text exactly like what it
 * replaces, so nothing moves: in a cell it is styled as Carbon's text area, on an item page it
 * has the read-only value's own class. The caret starts where the text was clicked.
 */
export function WrappedTextBox({
  id,
  field,
  value,
  start,
  compact,
  label,
  onChange,
  onKeyDown,
  onBlur,
}: {
  id: string;
  field: FieldDef;
  value: string;
  start?: EditStart;
  compact?: boolean;
  /** Its name for screen readers (default: the field's). */
  label?: string;
  onChange(value: InputValue): void;
  /** Keys besides Enter's default (no line break), e.g. a list item's Enter and Escape. */
  onKeyDown?(e: KeyboardEvent<HTMLDivElement>): void;
  onBlur?(e: FocusEvent<HTMLDivElement>): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = value; // uncontrolled from here on: React re-renders would move the caret
    const text = el.firstChild;
    el.focus();
    if (!text) return;
    const length = text.textContent?.length ?? 0;
    const caret = document.createRange();
    caret.setStart(text, Math.min(start?.range?.start ?? length, length));
    caret.setEnd(text, Math.min(start?.range?.end ?? length, length));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(caret);
    // Only once, on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      ref={ref}
      id={id}
      role="textbox"
      aria-label={label ?? field.name}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      className={compact ? "cds--text-area cell-textarea" : "view-field__value field-textbox"}
      // One-line value shown wrapped: a pasted line break becomes a space, Enter saves.
      onInput={(e) => onChange((e.currentTarget.textContent ?? "").replace(/[\r\n]+/g, " "))}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.preventDefault();
        onKeyDown?.(e);
      }}
      onBlur={onBlur}
    />
  );
}
