import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { Button, Dropdown, Form, FormGroup, InlineNotification, Stack, TextArea, TextInput } from "@carbon/react";
import { Add, ArrowDown, ArrowUp, TrashCan } from "@carbon/icons-react";
import { useStore, useType } from "../app/store";
import { fieldKindList, fieldKinds } from "../domain/fieldKinds";
import {
  isReferenceKind,
  newId,
  suggestPlural,
  typeDraft,
  type FieldKind,
  type ObjectType,
  type ObjectTypeDraft,
} from "../domain/model";
import { FieldKindLabel } from "../ui/fieldKindIcons";
import { TOGGLE_CHOICES, TOGGLE_ICONS, ToggleIconLabel } from "../ui/ToggleInput";
import { ChoiceFilterEditor } from "../ui/ChoiceFilterEditor";
import { TemplateArgInput } from "../ui/TemplateArgInput";
import type { Template } from "../domain/templates";
import { IconPicker } from "../ui/IconPicker";
import { ObjectTypeLabel as TypeLabel } from "../ui/typeIcons";
import { NotFound } from "../ui/NotFound";
import { PageHeader } from "../ui/PageHeader";
import { errorMessage, useConfirm } from "../ui/useConfirm";

/** A type a reference field can point at (including the one being created). */
interface Target {
  id: string;
  name: string;
  icon: string | null;
}

export function TypeEditorPage() {
  const { typeId } = useParams();
  const existing = useType(typeId);
  if (typeId && !existing) return <NotFound />;
  return <TypeEditor key={typeId ?? "new"} existing={existing} />;
}

type DraftField = ObjectTypeDraft["fields"][number];

function initialDraft(existing?: ObjectType): ObjectTypeDraft {
  if (existing) return typeDraft(existing);
  return {
    id: newId(),
    name: "",
    pluralName: "",
    icon: null,
    description: "",
    fields: [{ id: newId(), name: "Name", kind: "string", targetTypeId: null, templateId: null, templateArgs: {}, choiceFilter: [], toggleIcon: null }],
  };
}

function validate(draft: ObjectTypeDraft) {
  const fieldErrors: Record<string, string> = {};
  const targetErrors: Record<string, string> = {};
  const seen = new Set<string>();
  for (const f of draft.fields) {
    const key = f.name.trim().toLowerCase();
    if (!key) fieldErrors[f.id] = "Name is required";
    else if (seen.has(key)) fieldErrors[f.id] = "Duplicate field name";
    seen.add(key);
    if (isReferenceKind(f.kind) && !f.targetTypeId) targetErrors[f.id] = "Choose a type";
    if (f.kind === "template" && !f.templateId) targetErrors[f.id] = "Choose a template";
  }
  const nameError = draft.name.trim() ? undefined : "Name is required";
  const pluralError = draft.pluralName.trim() ? undefined : "Plural name is required";
  // A type always has a field (the last one can't be removed).
  const valid =
    !nameError &&
    !pluralError &&
    draft.fields.length > 0 &&
    Object.keys(fieldErrors).length === 0 &&
    Object.keys(targetErrors).length === 0;
  return { nameError, pluralError, fieldErrors, targetErrors, valid };
}

function TypeEditor({ existing }: { existing?: ObjectType }) {
  // Element ids unique per instance: the same page can be open in several tabs.
  const uid = useId();
  const { repo, types, reloadTypes, templates } = useStore();
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();
  const [draft, setDraft] = useState(() => initialDraft(existing));
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  // The plural follows the singular until the user edits it themselves.
  const [pluralTouched, setPluralTouched] = useState(!!existing);

  // A new type starts by naming it.
  useEffect(() => {
    if (!existing) document.getElementById(`${uid}-type-name`)?.focus();
  }, [existing, uid]);

  const persisted = useMemo(() => new Set(existing?.fields.map((f) => f.id)), [existing]);
  const { nameError, pluralError, fieldErrors, targetErrors, valid } = validate(draft);

  // Reference targets: all types, plus this one itself while it is being created.
  const targets: Target[] = existing
    ? types.map((t) => ({ id: t.id, name: t.pluralName, icon: t.icon }))
    : [
        ...types.map((t) => ({ id: t.id, name: t.pluralName, icon: t.icon })),
        { id: draft.id, name: `${draft.pluralName || "This type"} (itself)`, icon: draft.icon },
      ];

  const updateField = (id: string, patch: Partial<DraftField>) =>
    setDraft((d) => ({ ...d, fields: d.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)) }));

  const moveField = (index: number, delta: number) =>
    setDraft((d) => {
      const fields = [...d.fields];
      const [f] = fields.splice(index, 1);
      fields.splice(index + delta, 0, f);
      return { ...d, fields };
    });

  const removeField = (id: string) => setDraft((d) => ({ ...d, fields: d.fields.filter((f) => f.id !== id) }));

  const addField = () =>
    setDraft((d) => ({ ...d, fields: [...d.fields, { id: newId(), name: "", kind: "string", targetTypeId: null, templateId: null, templateArgs: {}, choiceFilter: [], toggleIcon: null }] }));

  async function save(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (!valid) return;

    const removed = existing?.fields.filter((f) => !draft.fields.some((d) => d.id === f.id)) ?? [];
    if (removed.length > 0) {
      const ok = await confirm({
        title: "Remove fields?",
        body: `The values of ${removed.map((f) => `“${f.name}”`).join(", ")} will no longer be shown on any object.`,
        confirmLabel: "Remove and save",
      });
      if (!ok) return;
    }

    setSaving(true);
    try {
      await repo.saveType({
        ...draft,
        name: draft.name.trim(),
        pluralName: draft.pluralName.trim(),
        description: draft.description.trim(),
        fields: draft.fields.map((f) => ({
          ...f,
          name: f.name.trim(),
          targetTypeId: isReferenceKind(f.kind) ? f.targetTypeId : null,
        })),
      });
      await reloadTypes();
      navigate(`/types/${draft.id}/objects`);
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  }

  return (
    <div className="form-page">
      <PageHeader
        current={existing ? `Edit ${existing.pluralName}` : "New type"}
        title={
          // The header is the editor for the type's icon and name.
          <div className="title-edit">
            <IconPicker id={`${uid}-type-icon`} value={draft.icon} onChange={(icon) => setDraft((d) => ({ ...d, icon }))} />
            <TextInput size="sm"
              id={`${uid}-type-name`}
              className="title-edit__name"
              labelText="Name"
              hideLabel
              placeholder="Name, e.g. Author"
              value={draft.name}
              onChange={(e) => {
                const name = e.target.value;
                setDraft((d) => ({ ...d, name, pluralName: pluralTouched ? d.pluralName : suggestPlural(name) }));
              }}
              invalid={submitted && !!nameError}
              invalidText={nameError}
            />
          </div>
        }
        breadcrumbs={[{ label: "Types", href: "#/types" }]}
      />
      {error && <InlineNotification kind="error" title="Could not save" subtitle={error} onClose={() => setError(undefined)} />}
      <Form onSubmit={save} noValidate>
        <Stack gap={6}>
          <TextInput size="sm"
            id={`${uid}-type-plural-name`}
            labelText="Plural name"
            placeholder="e.g. Authors"
            value={draft.pluralName}
            onChange={(e) => {
              setPluralTouched(true);
              setDraft((d) => ({ ...d, pluralName: e.target.value }));
            }}
            invalid={submitted && !!pluralError}
            invalidText={pluralError}
          />
          <TextArea
            id={`${uid}-type-description`}
            labelText="Description (optional)"
            rows={2}
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          />

          <FormGroup legendText="Fields">
            <p className="helper">A field's type cannot change once saved.</p>
            {draft.fields.map((f, i) => (
              <div className={isReferenceKind(f.kind) || f.kind === "template" || f.kind === "checkbox" || f.kind === "checklist" ? "field-row field-row--reference" : "field-row"} key={f.id}>
                <TextInput size="sm"
                  id={`${uid}-field-name-${f.id}`}
                  labelText="Field name"
                  value={f.name}
                  onChange={(e) => updateField(f.id, { name: e.target.value })}
                  invalid={submitted && !!fieldErrors[f.id]}
                  invalidText={fieldErrors[f.id]}
                />
                <Dropdown<FieldKind> autoAlign
                  size="sm"
                  id={`${uid}-field-kind-${f.id}`}
                  titleText="Field type"
                  label="Field type"
                  items={fieldKindList}
                  selectedItem={f.kind}
                  disabled={persisted.has(f.id)}
                  itemToString={(k) => (k ? fieldKinds[k].label : "")}
                  itemToElement={(k) => <FieldKindLabel kind={k} />}
                  renderSelectedItem={(k) => <FieldKindLabel kind={k} />}
                  onChange={({ selectedItem: k }) => k && updateField(f.id, { kind: k })}
                />
                {isReferenceKind(f.kind) && (
                  <Dropdown<Target> autoAlign
                    size="sm"
                    id={`${uid}-field-target-${f.id}`}
                    titleText="Refers to"
                    label="Choose…"
                    items={targets}
                    // Carbon accepts null (nothing chosen yet) at runtime; its types only say undefined.
                    selectedItem={(targets.find((t) => t.id === f.targetTypeId) ?? null) as Target}
                    disabled={persisted.has(f.id)}
                    itemToString={(t) => t?.name ?? ""}
                    itemToElement={(t) => <TypeLabel type={t} />}
                    renderSelectedItem={(t) => <TypeLabel type={t} />}
                    onChange={({ selectedItem: t }) => updateField(f.id, { targetTypeId: t?.id ?? null })}
                    invalid={submitted && !!targetErrors[f.id]}
                    invalidText={targetErrors[f.id]}
                  />
                )}
                {(f.kind === "checkbox" || f.kind === "checklist") && (
                  <Dropdown<string> autoAlign
                    size="sm"
                    id={`${uid}-field-toggle-icon-${f.id}`}
                    titleText="Icon"
                    label="Icon"
                    items={TOGGLE_CHOICES}
                    selectedItem={f.toggleIcon ?? "checkbox"}
                    itemToString={(i) => (i ? (TOGGLE_ICONS[i]?.label ?? "Checkbox") : "")}
                    itemToElement={(i) => <ToggleIconLabel id={i} />}
                    renderSelectedItem={(i) => <ToggleIconLabel id={i} />}
                    onChange={({ selectedItem: i }) => i && updateField(f.id, { toggleIcon: i === "checkbox" ? null : i })}
                  />
                )}
                {f.kind === "template" && (
                  <Dropdown<Template> autoAlign
                    size="sm"
                    id={`${uid}-field-template-${f.id}`}
                    titleText="Template"
                    label={templates.length ? "Choose…" : "No templates yet"}
                    items={templates}
                    // Carbon accepts null (nothing chosen yet) at runtime; its types only say undefined.
                    selectedItem={(templates.find((x) => x.id === f.templateId) ?? null) as Template}
                    itemToString={(x) => x?.name ?? ""}
                    onChange={({ selectedItem: x }) => updateField(f.id, { templateId: x?.id ?? null, templateArgs: {} })}
                    invalid={submitted && !!targetErrors[f.id]}
                    invalidText={targetErrors[f.id]}
                  />
                )}
                <div className="field-row__actions">
                  <Button size="sm" kind="ghost" hasIconOnly renderIcon={ArrowUp} iconDescription="Move up" disabled={i === 0} onClick={() => moveField(i, -1)} />
                  <Button size="sm"
                    kind="ghost"
                    hasIconOnly
                    renderIcon={ArrowDown}
                    iconDescription="Move down"
                    disabled={i === draft.fields.length - 1}
                    onClick={() => moveField(i, 1)}
                  />
                  <Button
                    size="sm"
                    kind="ghost"
                    hasIconOnly
                    renderIcon={TrashCan}
                    iconDescription={draft.fields.length === 1 ? "A type needs at least one field" : "Remove field"}
                    disabled={draft.fields.length === 1}
                    onClick={() => removeField(f.id)}
                  />
                </div>
                {/* A reference field can limit which objects it offers (filters over the target). */}
                {isReferenceKind(f.kind) && (() => {
                  const target = types.find((t) => t.id === f.targetTypeId);
                  return target ? (
                    <div className="field-row__mapping">
                      <ChoiceFilterEditor target={target} filters={f.choiceFilter} onChange={(choiceFilter) => updateField(f.id, { choiceFilter })} />
                    </div>
                  ) : null;
                })()}
                {/* Each of the template's variables takes the value of a field of this type, or a fixed value. */}
                {f.kind === "template" && (() => {
                  const x = templates.find((e) => e.id === f.templateId);
                  if (!x) return null;
                  const sources = draft.fields.filter((o) => o.id !== f.id && o.name.trim());
                  return (
                    <div className="field-row__mapping">
                      {x.params.map((p) => (
                        <TemplateArgInput
                          key={`${x.id}-${p}`}
                          id={`${uid}-field-arg-${f.id}-${p}`}
                          param={p}
                          fields={sources}
                          value={f.templateArgs[p]}
                          onChange={(arg) => {
                            const next = { ...f.templateArgs };
                            if (arg) next[p] = arg;
                            else delete next[p];
                            updateField(f.id, { templateArgs: next });
                          }}
                        />
                      ))}
                    </div>
                  );
                })()}
              </div>
            ))}
            <Button kind="tertiary" size="sm" renderIcon={Add} iconDescription="Add field" onClick={addField} className="add-field">
              Add field
            </Button>
          </FormGroup>

          <div className="form-actions">
            <Button size="sm" kind="secondary" onClick={() => navigate(existing ? `/types/${existing.id}/objects` : "/types")}>
              Cancel
            </Button>
            <Button size="sm" type="submit" disabled={saving}>
              {existing ? "Save changes" : "Create type"}
            </Button>
          </div>
        </Stack>
      </Form>
      {dialog}
    </div>
  );
}
