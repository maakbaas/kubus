import { useEffect, useId, useRef, useState } from "react";
import { InlineNotification, Modal } from "@carbon/react";
import { useStore } from "../app/store";
import { now, type FieldDef } from "../domain/model";
import { parseParams, type Component } from "../domain/components";
import { FieldLabel } from "./fieldKindIcons";
import { ComponentCodeEditor } from "./ComponentCodeEditor";
import { errorMessage } from "./useConfirm";

/** What to do with a changed component: save it, throw the edit away, or go back to it. */
type Choice = "save" | "discard" | "edit";

/**
 * A component field edited in place on an item page: it edits the field's component itself
 * (its code; name, output and the field's variable mapping stay as they are). Like every
 * field editor: Ctrl/Cmd+Enter or a click outside saves, Escape cancels. The component is shared,
 * so a change is saved only after a confirmation that it applies everywhere; there the edit can also be discarded (reverted) or taken up again.
 */
export function ComponentFieldEditor({ field, component, onDone }: { field: FieldDef; component: Component; onDone(): void }) {
  const { repo } = useStore();
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
    busy.current = true;
    try {
      const choice = await ask();
      if (choice === "edit") return;
      if (choice === "discard") return onDone();
      await repo.saveComponent({ ...component, code: next, params: parseParams(next), updatedAt: now() });
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
        onChange={setCode}
      />
      {error && <InlineNotification kind="error" lowContrast hideCloseButton title={error} />}
      <Modal
        open={answer !== null}
        size="sm"
        modalHeading={`Change component “${component.name}”?`}
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
