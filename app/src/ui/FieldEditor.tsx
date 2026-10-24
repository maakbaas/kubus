import { useEffect, useRef, useState } from "react";
import { useStore } from "../app/store";
import type { FieldDef, FieldValue } from "../domain/model";
import type { EditStart } from "./editStart";
import { FieldInput, parseInputValue, toInputValue, type InputValue } from "./FieldInput";
import { errorMessage } from "./useConfirm";
import type { RefOptions } from "./useReferenceOptions";

// Edits one field in place, wherever its read-only value is shown (object page, table cell).
// No buttons: Enter / Ctrl+Enter or clicking outside saves, Escape cancels.

interface FieldEditorProps {
  field: FieldDef;
  value: FieldValue;
  refs: RefOptions;
  start?: EditStart;
  /** Table cells: compact input (small, hidden label). */
  compact?: boolean;
  /** Element id prefix (see FieldInput). */
  idPrefix?: string;
  onSave(value: FieldValue): Promise<void>;
  onCancel(): void;
}

/**
 * The field's normal form input, edited in place. Enter (Ctrl/Cmd+Enter in markdown) or
 * clicking outside saves; Escape cancels.
 */
export function FieldEditor({ field, value, refs, start, compact, idPrefix, onSave, onCancel }: FieldEditorProps) {
  const { repo, types } = useStore();
  const [raw, setRaw] = useState<InputValue>(() => toInputValue(field.kind, value));
  const [error, setError] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  // Hold the read-only field's height until the editor has rendered its content: otherwise
  // the page briefly gets shorter and the browser scrolls up (long markdown fields).
  const [holdHeight, setHoldHeight] = useState(start?.fieldHeight);
  useEffect(() => {
    if (!holdHeight) return;
    // Release once the input itself is as tall as the field was (its content has rendered);
    // fall back after a moment in case the edited content is shorter.
    const release = () => setHoldHeight(undefined);
    const timer = window.setTimeout(release, 1500);
    const inner = box.current?.firstElementChild;
    const observer = new ResizeObserver(() => {
      if (inner && inner.getBoundingClientRect().height >= holdHeight - 2) release();
    });
    if (inner) observer.observe(inner);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [holdHeight]);
  // Latest raw value for key/click handlers that run in the same event as an input's onChange.
  const latest = useRef(raw);
  const saving = useRef(false);

  // Images are stored when picked; release this edit's uploads when it ends (saved ones are kept).
  const uploads = useRef(new Set<string>());
  useEffect(() => {
    const pending = uploads.current;
    return () => {
      if (pending.size > 0) repo.releaseFiles([...pending]).catch((e) => console.error("Releasing files failed", e));
    };
  }, [repo]);

  // Focus the input so typing can start right away. The markdown editor creates its
  // editable area asynchronously, so retry briefly until it exists.
  useEffect(() => {
    if (field.kind === "markdown" && start) return; // the markdown editor places caret/selection itself
    let tries = 0;
    const t = window.setInterval(() => {
      // The first text input (not a checklist's checkbox).
      const target = box.current?.querySelector<HTMLElement>(
        "input:not([type=hidden], [type=checkbox]), textarea, [contenteditable=true], [contenteditable=plaintext-only]",
      );
      if (target) {
        target.focus();
        // Single-line text inputs (strings, dates, references) show the same text as the view, so
        // the view's caret/selection maps 1:1. Number inputs can't take a selection.
        const text = (target instanceof HTMLInputElement && target.type === "text") || target instanceof HTMLTextAreaElement;
        if (start?.range && text) {
          const end = (target as HTMLInputElement | HTMLTextAreaElement).value.length;
          (target as HTMLInputElement | HTMLTextAreaElement).setSelectionRange(Math.min(start.range.start, end), Math.min(start.range.end, end));
        }
      }
      if (target || ++tries > 20) window.clearInterval(t);
    }, 50);
    return () => window.clearInterval(t);
  }, [field.kind, start]);

  async function save() {
    if (saving.current) return;
    const parsed = parseInputValue(field.kind, latest.current);
    if ("error" in parsed) return setError(parsed.error);
    saving.current = true;
    try {
      await onSave(parsed.value);
    } catch (e) {
      setError(errorMessage(e));
      saving.current = false;
    }
  }
  const saveRef = useRef(save);
  saveRef.current = save;

  // No buttons (they would push the content below down): clicking outside the field saves.
  // Clicks in its floating parts (date calendar, dropdown menus, link dialog) don't count.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (box.current?.contains(target)) return;
      if (target.closest(".flatpickr-calendar, .cds--popover, .cds--modal, [role=listbox]")) return;
      saveRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  // Keys are caught on the document in the capture phase: some inputs (e.g. Carbon's date
  // picker) stop Enter from bubbling. Enter saves (Ctrl/Cmd+Enter in markdown, where Enter
  // is a new line; multi-selects use Enter to pick); the save runs after the event so an
  // input can apply the key first (a combobox selecting its highlighted item). Escape
  // cancels, unless it is closing an open calendar or dropdown. Keys in dialogs are left alone.
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inField = box.current?.contains(target) || target === document.body || !!target.closest(".flatpickr-calendar");
      if (!inField) return;
      // A list's rows handle these themselves: Enter adds an item, Escape removes an empty one.
      const listRow = target.closest("[data-list-row]");
      if (e.key === "Escape" && target.closest("[data-list-row-removable]")) return;
      if (e.key === "Enter" && listRow && !e.ctrlKey && !e.metaKey) return;
      if (e.key === "Escape") {
        const popupOpen =
          !!document.querySelector(".flatpickr-calendar.open") || !!box.current?.querySelector("[aria-expanded=true]");
        if (popupOpen) return;
        e.preventDefault();
        cancelRef.current();
      } else if (e.key === "Enter") {
        const modified = e.ctrlKey || e.metaKey;
        // Multi-line sources (markdown, HTML): Enter is a new line, Ctrl/Cmd+Enter saves.
        const multiline = field.kind === "markdown" || field.kind === "html";
        if (modified && multiline) {
          // Don't let the editor also handle it (new line / hard break).
          e.preventDefault();
          e.stopPropagation();
        }
        const plainEnterSaves = !multiline && field.kind !== "object_list";
        if (modified || plainEnterSaves) window.setTimeout(() => saveRef.current(), 0);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [field.kind]);

  return (
    <div
      ref={box}
      className={compact ? "field-editor field-editor--compact" : "field-editor"}
      style={holdHeight ? { minHeight: holdHeight } : undefined}
      title={field.kind === "markdown" || field.kind === "html" ? "Ctrl+Enter or click outside to save, Esc to cancel" : "Enter to save, Esc to cancel"}
    >
      <FieldInput
        field={field}
        value={raw}
        error={error}
        options={field.targetTypeId ? refs[field.targetTypeId] : undefined}
        target={types.find((t) => t.id === field.targetTypeId)}
        onChange={(v) => {
          latest.current = v;
          setRaw(v);
          setError(undefined);
        }}
        onFileStored={(fileId) => uploads.current.add(fileId)}
        start={start}
        compact={compact}
        multiline={start?.wrapped}
        idPrefix={idPrefix}
      />
    </div>
  );
}
