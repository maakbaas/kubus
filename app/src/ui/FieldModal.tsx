import { useState } from "react";
import { createPortal } from "react-dom";
import { Button, Dropdown, InlineNotification, Modal, Stack, TextInput } from "@carbon/react";
import { useStore } from "../app/store";
import { fieldKindList, fieldKinds } from "../domain/fieldKinds";
import { isReferenceKind, newId, collectionDraft, type FieldDef, type FieldKind, type Collection, type ComponentArg } from "../domain/model";
import type { Component } from "../domain/components";
import { FieldKindLabel } from "./fieldKindIcons";
import { TOGGLE_CHOICES, TOGGLE_ICONS, ToggleIconLabel } from "./ToggleInput";
import { CollectionLabel } from "./collectionIcons";
import { ChoiceFilterEditor } from "./ChoiceFilterEditor";
import { ComponentArgInput } from "./ComponentArgInput";
import { NewComponentModal } from "./NewComponentModal";
import type { FilterRule } from "../domain/query";
import { errorMessage, useConfirm } from "./useConfirm";

/**
 * Adds a field to a collection, or edits a component field, from a view's field picker (table
 * columns, card fields, item page layout): name and type, plus the referenced collection or the
 * component and its variables (a field or a fixed value each). It is an ordinary field of the
 * collection, shown everywhere like fields added in the collection editor, and the picker shows it in
 * its own view. Type and reference target can't change once created.
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
  const { repo, components, collections } = useStore();
  const { confirm, dialog } = useConfirm();
  const [name, setName] = useState(field?.name ?? "");
  const [kind, setKind] = useState<FieldKind>(field?.kind ?? "string");
  const [targetCollectionId, setTargetCollectionId] = useState<string | null>(field?.targetCollectionId ?? null);
  const [componentId, setComponentId] = useState<string | null>(field?.componentId ?? null);
  const [args, setArgs] = useState<Record<string, ComponentArg>>(field?.componentArgs ?? {});
  const [choiceFilter, setChoiceFilter] = useState<FilterRule[]>(field?.choiceFilter ?? []);
  const [toggleIcon, setToggleIcon] = useState<string | null>(field?.toggleIcon ?? null);
  const [creatingComponent, setCreatingComponent] = useState(false);
  // Just created: the store may not list it yet.
  const [created, setCreated] = useState<Component>();
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const component = components.find((t) => t.id === componentId) ?? (created?.id === componentId ? created : undefined);
  const target = collections.find((t) => t.id === targetCollectionId);
  const taken = collection.fields.some((f) => f.id !== field?.id && f.name.trim().toLowerCase() === name.trim().toLowerCase());
  const nameError = !name.trim() ? "Name is required" : taken ? "Another field has this name" : undefined;
  const choiceError =
    kind === "component" && !componentId ? "Choose a component" : isReferenceKind(kind) && !targetCollectionId ? "Choose a collection" : undefined;
  const sources = collection.fields.filter((f) => f.id !== field?.id);

  async function save() {
    if (nameError || choiceError) {
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
    const draft = collectionDraft(collection);
    const id = field?.id ?? newId();
    const own = {
      id,
      name: name.trim(),
      kind,
      targetCollectionId: isReferenceKind(kind) ? targetCollectionId : null,
      componentId: kind === "component" ? componentId : null,
      componentArgs: kind === "component" ? args : {},
      choiceFilter: isReferenceKind(kind) ? choiceFilter : [],
      toggleIcon: kind === "checkbox" || kind === "checklist" ? toggleIcon : null,
    };
    draft.fields = field
      ? draft.fields.map((f) => (f.id === id ? { ...f, ...own } : f))
      : [...draft.fields, own];
    try {
      await repo.saveCollection(draft);
      onSaved(id);
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
      open
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
          labelText="Name"
          placeholder={kind === "component" ? "e.g. Reading time" : "e.g. Published"}
          value={name}
          onChange={(e) => setName(e.target.value)}
          invalid={submitted && !!nameError}
          invalidText={nameError}
        />
        <Dropdown<FieldKind>
          autoAlign
          size="sm"
          id="field-modal-kind"
          titleText="Field type"
          label="Field type"
          items={fieldKindList}
          selectedItem={kind}
          disabled={!!field}
          itemToString={(k) => (k ? fieldKinds[k].label : "")}
          itemToElement={(k) => <FieldKindLabel kind={k} />}
          renderSelectedItem={(k) => <FieldKindLabel kind={k} />}
          onChange={({ selectedItem: k }) => {
            if (!k) return;
            setKind(k);
            // The dropdowns the new collection brings along start without errors.
            setSubmitted(false);
          }}
        />
        {isReferenceKind(kind) && (
          <Dropdown<Collection>
            autoAlign
            size="sm"
            id="field-modal-target"
            titleText="Refers to"
            label="Choose…"
            items={collections}
            // Carbon accepts null (nothing chosen yet) at runtime; its types only say undefined.
            selectedItem={(target ?? null) as Collection}
            disabled={!!field}
            itemToString={(t) => t?.pluralName ?? ""}
            itemToElement={(t) => <CollectionLabel collection={{ name: t.pluralName, icon: t.icon }} />}
            renderSelectedItem={(t) => <CollectionLabel collection={{ name: t.pluralName, icon: t.icon }} />}
            onChange={({ selectedItem: t }) => {
              setTargetCollectionId(t?.id ?? null);
              setChoiceFilter([]);
            }}
            invalid={submitted && !!choiceError}
            invalidText={choiceError}
          />
        )}
        {isReferenceKind(kind) && target && <ChoiceFilterEditor target={target} filters={choiceFilter} onChange={setChoiceFilter} />}
        {(kind === "checkbox" || kind === "checklist") && (
          <Dropdown<string>
            autoAlign
            size="sm"
            id="field-modal-toggle-icon"
            titleText="Icon"
            label="Icon"
            items={TOGGLE_CHOICES}
            selectedItem={toggleIcon ?? "checkbox"}
            itemToString={(i) => (i ? (TOGGLE_ICONS[i]?.label ?? "Checkbox") : "")}
            itemToElement={(i) => <ToggleIconLabel id={i} />}
            renderSelectedItem={(i) => <ToggleIconLabel id={i} />}
            onChange={({ selectedItem: i }) => i && setToggleIcon(i === "checkbox" ? null : i)}
          />
        )}
        {kind === "component" && (
          <Dropdown<Component>
            autoAlign
            size="sm"
            id="field-modal-component"
            titleText="Component"
            label={components.length ? "Choose…" : "No components yet"}
            items={components}
            // Carbon accepts null (nothing chosen yet) at runtime; its types only say undefined.
            selectedItem={(component ?? null) as Component}
            itemToString={(t) => t?.name ?? ""}
            onChange={({ selectedItem: t }) => {
              setComponentId(t?.id ?? null);
              setArgs({});
            }}
            invalid={submitted && !!choiceError}
            invalidText={choiceError}
          />
        )}
        {kind === "component" && (
          <Button size="sm" kind="tertiary" onClick={() => setCreatingComponent(true)}>
            New component
          </Button>
        )}
        {kind === "component" &&
          component?.params.map((p) => (
            <ComponentArgInput
              key={`${component.id}-${p}`}
              id={`field-modal-arg-${p}`}
              param={p}
              fields={sources}
              value={args[p]}
              onChange={(arg) =>
                setArgs((a) => {
                  const next = { ...a };
                  if (arg) next[p] = arg;
                  else delete next[p];
                  return next;
                })
              }
            />
          ))}
        <p className="helper">
          A field of the collection: it can be shown in other views too, sorted and filtered on, and read by components as $item["
          {name.trim() || "Name"}"].
        </p>
      </Stack>
    </Modal>
    {creatingComponent && (
      <NewComponentModal
        onClose={() => setCreatingComponent(false)}
        onCreated={(t) => {
          setCreated(t);
          setComponentId(t.id);
          setArgs({});
          setCreatingComponent(false);
        }}
      />
    )}
    {dialog}
    </>,
    document.querySelector(".app-root") ?? document.body,
  );
}
