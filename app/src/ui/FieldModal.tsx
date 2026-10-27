import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Dropdown, InlineNotification, Modal, Stack, TextInput } from "@carbon/react";
import { useStore } from "../app/store";
import { useItemCounts } from "../app/useItemCounts";
import { fieldKindList, fieldKinds, offeredKind } from "../domain/fieldKinds";
import { blankField, isReferenceKind, newId, collectionDraft, type FieldDef, type FieldDraft, type Collection } from "../domain/model";
import { FieldKindLabel } from "./fieldKindIcons";
import { FieldSettings, newKindPatch, settingsProblem, type Target } from "./FieldSettings";
import { errorMessage, useConfirm } from "./useConfirm";
import { useMountedDialog } from "./useMountedDialog";

/**
 * Adds a field to a collection, or edits one, from a view's field picker (table columns, card
 * fields, item page layout): name and field type, plus what the type brings (FieldSettings, as in
 * the collection editor: the referenced collection, a checkbox's icon, a component field's
 * component, written here or shared, asking AI or not). It is an ordinary field of the collection,
 * shown everywhere like fields added in the collection editor, and the picker shows it in its own
 * view. Type and reference target can't change once created.
 */
export function FieldModal({
  collection,
  field,
  onClose,
  onSaved,
}: {
  collection: Collection;
  /** The field to edit; null to add one. */
  field: FieldDef | null;
  onClose(): void;
  /** After saving: the field's id (a new one is then shown in the view it was added from). */
  onSaved(fieldId: string): void;
}) {
  const { repo, components, collections, space } = useStore();
  const { confirm, dialog } = useConfirm();
  const open = useMountedDialog();
  const [draft, setDraft] = useState<FieldDraft>(() => {
    const { collectionId: _c, position: _p, ...own } = field ?? blankField(newId(), "", "string");
    return own;
  });
  const update = (patch: Partial<FieldDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const counts = useItemCounts();
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const name = draft.name;
  const kind = draft.kind;
  const targets = useMemo<Target[]>(() => collections.map((t) => ({ id: t.id, name: t.pluralName, icon: t.icon })), [collections]);
  const taken = collection.fields.some((f) => f.id !== field?.id && f.name.trim().toLowerCase() === name.trim().toLowerCase());
  const nameError = !name.trim() ? "Name is required" : taken ? "Another field has this name" : undefined;
  const problem = settingsProblem(draft, components);

  async function save() {
    if (nameError || problem) {
      setSubmitted(true);
      return;
    }
    // The field belongs to the collection, not to the view this was opened from.
    if (!field) {
      const ok = await confirm({
        title: `Add “${name.trim()}” to ${collection.pluralName}?`,
        body: `This adds a field to the collection ${collection.name}, so it exists for all its items and views, not just this one.`,
        confirmLabel: "Add field",
        danger: false,
      });
      if (!ok) return;
    }
    setSaving(true);
    const collectionAsDraft = collectionDraft(collection);
    const own: FieldDraft = {
      ...draft,
      name: name.trim(),
      targetCollectionId: isReferenceKind(kind) ? draft.targetCollectionId : null,
      choiceFilter: isReferenceKind(kind) ? draft.choiceFilter : [],
    };
    collectionAsDraft.fields = field
      ? collectionAsDraft.fields.map((f) => (f.id === own.id ? own : f))
      : [...collectionAsDraft.fields, own];
    try {
      await repo.saveCollection(collectionAsDraft, space.id);
      onSaved(own.id);
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  }

  // At the window level (opened from a popover, it would otherwise be laid out inside it), but
  // inside the app root, which carries the theme and Carbon's tokens.
  return createPortal(
    <>
    <Modal
      open={open}
      size="xs"
      className="modal--menus"
      modalHeading={field ? `Edit ${field.name}` : "Add field"}
      primaryButtonText={field ? "Save" : "Add"}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={saving}
      onRequestClose={onClose}
      onRequestSubmit={save}
    >
      <Stack gap={5}>
        {error && <InlineNotification kind="error" title="Could not save" subtitle={error} lowContrast hideCloseButton />}
        <TextInput
          size="sm"
          id="field-modal-name"
          data-modal-primary-focus
          labelText="Name"
          placeholder={kind === "component" || kind === "ai" ? "e.g. Reading time" : "e.g. Published"}
          value={name}
          onChange={(e) => update({ name: e.target.value })}
          invalid={submitted && !!nameError}
          invalidText={nameError}
        />
        <Dropdown<FieldDraft["kind"]>
          autoAlign
          size="sm"
          id="field-modal-kind"
          titleText="Field type"
          label="Field type"
          items={fieldKindList}
          selectedItem={offeredKind(kind)}
          disabled={!!field}
          itemToString={(k) => (k ? fieldKinds[k].label : "")}
          itemToElement={(k) => <FieldKindLabel kind={k} />}
          renderSelectedItem={(k) => <FieldKindLabel kind={k} />}
          onChange={({ selectedItem: k }) => {
            if (!k) return;
            update(newKindPatch(k));
            // The inputs the new type brings along start without errors.
            setSubmitted(false);
          }}
        />
        <FieldSettings id="field-modal" field={draft} persisted={!!field} targets={targets} problem={submitted ? problem : undefined} itemCount={counts[collection.id] ?? 0} onChange={update} />
        <p className="helper">
          A field of the collection: it can be shown in other views too, sorted and filtered on, and read by components as $item["
          {name.trim() || "Name"}"].
        </p>
      </Stack>
    </Modal>
    {dialog}
    </>,
    document.querySelector(".app-root") ?? document.body,
  );
}
