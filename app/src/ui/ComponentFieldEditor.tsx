import { useEffect, useId, useRef, useState } from "react";
import { InlineNotification, Modal } from "@carbon/react";
import { useStore } from "../app/store";
import { collectionDraft, now, type Collection, type FieldDef } from "../domain/model";
import { placeProblem, type Component, type ComponentCode } from "../domain/components";
import { FieldLabel } from "./fieldKindIcons";
import { ComponentCodeEditor } from "./ComponentCodeEditor";
import { errorMessage } from "./useConfirm";

/** What to do with a changed component: save it, throw the edit away, or go back to it. */
type Choice = "save" | "discard" | "edit";

/**
 * A component field edited in place on an item page: it edits the field's component itself (its
 * code; name and output stay as they are). Like every field editor: Ctrl/Cmd+Enter or a click
 * outside saves, Escape cancels. The field's own component is saved with the field; a shared one
 * only after a confirmation that it applies everywhere; there the edit can also be discarded
 * (reverted) or taken up again.
 */
export function ComponentFieldEditor({
  collection,
  field,
  component,
  shared,
  onDone,
}: {
  collection: Collection;
  field: FieldDef;
  component: ComponentCode;
  /** The shared component it shows (none: the field's own). */
  shared?: Component;
  onDone(): void;
}) {
  const { repo, space } = useStore();
  const uid = useId();
  // The open confirmation's answer (null: none open).
  const [answer, setAnswer] = useState<((choice: Choice) => void) | null>(null);
  const ask = () => new Promise<Choice>((resolve) => setAnswer(() => resolve));
  const choose = (choice: Choice) => {
    answer?.(choice);
    setAnswer(null);
  };
  const [code, setCode] = useState(component.code);
  const [error, setError] = useState<string>();
  const latest = useRef(code);
  latest.current = code;
  const box = useRef<HTMLDivElement>(null);

  // Open while asking or saving: further save triggers (clicks, keys) wait for the answer.
  const busy = useRef(false);
  async function save() {
    if (busy.current) return;
    const next = latest.current;
    if (next === component.code) return onDone();
    // Code that no longer fits a field (a block's $items, or mixed) isn't saved: the editor says why.
    if (placeProblem({ ...component, code: next }, "field")) return;
    busy.current = true;
    try {
      if (shared) {
        const choice = await ask();
        if (choice === "edit") return;
        if (choice === "discard") return onDone();
        await repo.saveComponent({ ...shared, code: next, updatedAt: now() });
      } else {
        const draft = collectionDraft(collection);
        draft.fields = draft.fields.map((f) => (f.id === field.id ? { ...f, code: next } : f));
        await repo.saveCollection(draft, space.id);
      }
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      busy.current = false;
    }
  }
  const saveRef = useRef(save);
  saveRef.current = save;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  // A click outside saves (not in the confirmation dialog); keys as in FieldEditor.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (box.current?.contains(target) || target.closest(".cds--modal, .cds--popover")) return;
      saveRef.current();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(".cds--modal") || busy.current) return;
      if (!box.current?.contains(target) && target !== document.body) return;
      if (e.key === "Escape") {
        e.preventDefault();
        doneRef.current();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveRef.current();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  // Typing can start right away.
  useEffect(() => {
    box.current?.querySelector("textarea")?.focus();
  }, []);

  return (
    <div ref={box} className="field-editor" title="Ctrl+Enter or click outside to save, Esc to cancel">
      <ComponentCodeEditor
        id={`${uid}-component-${field.id}`}
        labelText={<FieldLabel field={field} />}
        value={code}
        html={component.output === "html"}
        invalidText={placeProblem({ ...component, code }, "field") ?? undefined}
        onChange={setCode}
      />
      {error && <InlineNotification kind="error" lowContrast hideCloseButton title={error} />}
      <Modal
        open={answer !== null}
        size="xs"
        modalHeading={`Change component “${shared?.name ?? ""}”?`}
        primaryButtonText="Change component"
        // Closing the dialog (×, Escape) goes back to editing; nothing is lost.
        secondaryButtons={[
          { buttonText: "Keep editing", onClick: () => choose("edit") },
          { buttonText: "Discard changes", onClick: () => choose("discard") },
        ]}
        onRequestSubmit={() => choose("save")}
        onRequestClose={() => choose("edit")}
      >
        <p>This changes it everywhere it is used, for every item.</p>
      </Modal>
    </div>
  );
}
