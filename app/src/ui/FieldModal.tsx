import { useState } from "react";
import { createPortal } from "react-dom";
import { Dropdown, InlineNotification, Modal, Stack, TextInput } from "@carbon/react";
import { useStore } from "../app/store";
import { fieldKindList, fieldKinds } from "../domain/fieldKinds";
import { isReferenceKind, newId, typeDraft, type FieldDef, type FieldKind, type ObjectType, type TemplateArg } from "../domain/model";
import type { Template } from "../domain/templates";
import { FieldKindLabel } from "./fieldKindIcons";
import { TOGGLE_CHOICES, TOGGLE_ICONS, ToggleIconLabel } from "./ToggleInput";
import { ObjectTypeLabel } from "./typeIcons";
import { ChoiceFilterEditor } from "./ChoiceFilterEditor";
import { TemplateArgInput } from "./TemplateArgInput";
import type { FilterRule } from "../domain/query";
import { errorMessage, useConfirm } from "./useConfirm";

/**
 * Adds a field to a type, or edits a template field, from a view's field picker (table
 * columns, card fields, object page layout): name and type, plus the referenced type or the
 * template and its variables (a field or a fixed value each). It is an ordinary field of the
 * type, shown everywhere like fields added in the type editor, and the picker shows it in
 * its own view. Type and reference target can't change once created.
 */
export function FieldModal({
  type,
  field,
  onClose,
  onSaved,
}: {
  type: ObjectType;
  /** The field to edit; null to add one. */
  field: FieldDef | null;
  onClose(): void;
  /** After saving: the field's id (a new one is then shown in the view it was added from). */
  onSaved(fieldId: string): void;
}) {
  const { repo, templates, types } = useStore();
  const { confirm, dialog } = useConfirm();
  const [name, setName] = useState(field?.name ?? "");
  const [kind, setKind] = useState<FieldKind>(field?.kind ?? "string");
  const [targetTypeId, setTargetTypeId] = useState<string | null>(field?.targetTypeId ?? null);
  const [templateId, setTemplateId] = useState<string | null>(field?.templateId ?? null);
  const [args, setArgs] = useState<Record<string, TemplateArg>>(field?.templateArgs ?? {});
  const [choiceFilter, setChoiceFilter] = useState<FilterRule[]>(field?.choiceFilter ?? []);
  const [toggleIcon, setToggleIcon] = useState<string | null>(field?.toggleIcon ?? null);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const template = templates.find((t) => t.id === templateId);
  const target = types.find((t) => t.id === targetTypeId);
  const taken = type.fields.some((f) => f.id !== field?.id && f.name.trim().toLowerCase() === name.trim().toLowerCase());
  const nameError = !name.trim() ? "Name is required" : taken ? "Another field has this name" : undefined;
  const choiceError =
    kind === "template" && !templateId ? "Choose a template" : isReferenceKind(kind) && !targetTypeId ? "Choose a type" : undefined;
  const sources = type.fields.filter((f) => f.id !== field?.id);

  async function save() {
    if (nameError || choiceError) {
      setSubmitted(true);
      return;
    }
    // The field belongs to the type, not to the view this was opened from.
    if (!field) {
      const ok = await confirm({
        title: `Add “${name.trim()}” to ${type.pluralName}?`,
        body: `This adds a field to the type ${type.name}, so it exists for all its objects and views, not just this one.`,
        confirmLabel: "Add field",
        danger: false,
      });
      if (!ok) return;
    }
    setSaving(true);
    const draft = typeDraft(type);
    const id = field?.id ?? newId();
    const own = {
      id,
      name: name.trim(),
      kind,
      targetTypeId: isReferenceKind(kind) ? targetTypeId : null,
      templateId: kind === "template" ? templateId : null,
      templateArgs: kind === "template" ? args : {},
      choiceFilter: isReferenceKind(kind) ? choiceFilter : [],
      toggleIcon: kind === "checkbox" || kind === "checklist" ? toggleIcon : null,
    };
    draft.fields = field
      ? draft.fields.map((f) => (f.id === id ? { ...f, ...own } : f))
      : [...draft.fields, own];
    try {
      await repo.saveType(draft);
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
          placeholder={kind === "template" ? "e.g. Reading time" : "e.g. Published"}
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
            // The dropdowns the new type brings along start without errors.
            setSubmitted(false);
          }}
        />
        {isReferenceKind(kind) && (
          <Dropdown<ObjectType>
            autoAlign
            size="sm"
            id="field-modal-target"
            titleText="Refers to"
            label="Choose…"
            items={types}
            // Carbon accepts null (nothing chosen yet) at runtime; its types only say undefined.
            selectedItem={(target ?? null) as ObjectType}
            disabled={!!field}
            itemToString={(t) => t?.pluralName ?? ""}
            itemToElement={(t) => <ObjectTypeLabel type={{ name: t.pluralName, icon: t.icon }} />}
            renderSelectedItem={(t) => <ObjectTypeLabel type={{ name: t.pluralName, icon: t.icon }} />}
            onChange={({ selectedItem: t }) => {
              setTargetTypeId(t?.id ?? null);
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
        {kind === "template" && (
          <Dropdown<Template>
            autoAlign
            size="sm"
            id="field-modal-template"
            titleText="Template"
            label={templates.length ? "Choose…" : "No templates yet"}
            items={templates}
            // Carbon accepts null (nothing chosen yet) at runtime; its types only say undefined.
            selectedItem={(template ?? null) as Template}
            itemToString={(t) => t?.name ?? ""}
            onChange={({ selectedItem: t }) => {
              setTemplateId(t?.id ?? null);
              setArgs({});
            }}
            invalid={submitted && !!choiceError}
            invalidText={choiceError}
          />
        )}
        {kind === "template" &&
          template?.params.map((p) => (
            <TemplateArgInput
              key={`${template.id}-${p}`}
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
          A field of the type: it can be shown in other views too, sorted and filtered on, and read by templates as $object["
          {name.trim() || "Name"}"].
        </p>
      </Stack>
    </Modal>
    {dialog}
    </>,
    document.querySelector(".app-root") ?? document.body,
  );
}
