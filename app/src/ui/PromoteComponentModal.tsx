import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { InlineNotification, Modal, Stack, TextInput } from "@carbon/react";
import { useStore } from "../app/store";
import { newId, now } from "../domain/model";
import type { Component, ComponentCode } from "../domain/components";
import { errorMessage } from "./useConfirm";
import { useMountedDialog } from "./useMountedDialog";

/**
 * Promotes a local component (written in place) to a shared one: asks for its name, saves it to the
 * components table and hands it back, for the place to pick it instead of its own code. `fresh`:
 * a new (empty) shared component for a place to pick, written on its own page afterwards.
 */
export function PromoteComponentModal({
  local,
  suggestedName = "",
  fresh = false,
  onClose,
  onPromoted,
}: {
  local: ComponentCode;
  suggestedName?: string;
  /** A new component (`local` is its empty code), not a place's own made shared. */
  fresh?: boolean;
  onClose(): void;
  /** After saving: the place picks the new shared component (and drops its own code). */
  onPromoted(component: Component): void | Promise<void>;
}) {
  const uid = useId();
  const open = useMountedDialog();
  const { repo, components } = useStore();
  const [name, setName] = useState(suggestedName);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const taken = components.some((t) => t.name.trim().toLowerCase() === name.trim().toLowerCase());
  const nameError = !name.trim() ? "Give the component a name" : taken ? "Another component has this name" : undefined;

  async function save() {
    setSubmitted(true);
    if (nameError) return;
    setSaving(true);
    const ts = now();
    const component: Component = { ...local, id: newId(), name: name.trim(), description: "", createdAt: ts, updatedAt: ts };
    try {
      await repo.saveComponent(component);
      await onPromoted(component);
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  }

  // At the window level (opened from a popover or another dialog, it would otherwise be laid out
  // inside it), but inside the app root, which carries the theme and Carbon's tokens.
  return createPortal(
    <Modal
      open={open}
      size="xs"
      modalHeading={fresh ? "New component" : "Save as shared component"}
      primaryButtonText={fresh ? "Create" : "Save as shared"}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={saving}
      onRequestClose={onClose}
      onRequestSubmit={save}
    >
      <Stack gap={5}>
        {error && <InlineNotification kind="error" title="Could not save" subtitle={error} lowContrast hideCloseButton />}
        <p>
          {fresh
            ? "It is listed under Components by this name and opens there, beside this page, to be written; other places can pick it too."
            : "It is listed under Components by this name and can be picked in other places too; editing it then changes it everywhere it is used."}
        </p>
        <TextInput
          size="sm"
          id={`${uid}-name`}
          data-modal-primary-focus
          labelText="Name"
          placeholder="e.g. Reading time"
          value={name}
          onChange={(e) => setName(e.target.value)}
          invalid={submitted && !!nameError}
          invalidText={nameError}
        />
      </Stack>
    </Modal>,
    document.querySelector(".app-root") ?? document.body,
  );
}
