import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { Button, Dropdown, Form, FormGroup, IconButton, InlineNotification, MultiSelect, Stack, TextArea, TextInput } from "@carbon/react";
import { Add, TrashCan } from "@carbon/icons-react";
import { useStore, useCollection } from "../app/store";
import { useItemCounts } from "../app/useItemCounts";
import { fieldKindList, fieldKinds, offeredKind } from "../domain/fieldKinds";
import {
  blankField,
  isReferenceKind,
  newId,
  suggestPlural,
  collectionDraft,
  type FieldKind,
  type FieldDraft,
  type Collection,
  type CollectionDraft,
} from "../domain/model";
import type { Component } from "../domain/components";
import { FieldKindLabel } from "../ui/fieldKindIcons";
import { FieldSettings, hasSettings, newKindPatch, settingsProblem, type Target } from "../ui/FieldSettings";
import { IconPicker } from "../ui/IconPicker";
import { SpaceLabel } from "../ui/SpaceSwitcher";
import type { Space } from "../domain/spaces";
import { NotFound } from "../ui/NotFound";
import { PageHeader } from "../ui/PageHeader";
import { errorMessage, useConfirm } from "../ui/useConfirm";
import { moveBlock, useReorder } from "../ui/useReorder";

export function CollectionEditorPage() {
  const { collectionId } = useParams();
  const existing = useCollection(collectionId);
  if (collectionId && !existing) return <NotFound />;
  return <CollectionEditor key={collectionId ?? "new"} existing={existing} />;
}

type DraftField = CollectionDraft["fields"][number];

/** A new field in a draft: a string field without a name. */
export function draftField(name = "", kind: FieldKind = "string"): FieldDraft {
  const { collectionId: _c, position: _p, ...field } = blankField(newId(), name, kind);
  return field;
}

function initialDraft(existing?: Collection): CollectionDraft {
  if (existing) return collectionDraft(existing);
  return {
    id: newId(),
    name: "",
    pluralName: "",
    // New collections start with the cube (the app icon); the picker shows an unset icon as empty.
    icon: "Cube",
    description: "",
    spaceIds: null,
    fields: [draftField("Name")],
  };
}

function validate(draft: CollectionDraft, components: Component[]) {
  const fieldErrors: Record<string, string> = {};
  const targetErrors: Record<string, string> = {};
  const seen = new Set<string>();
  for (const f of draft.fields) {
    const key = f.name.trim().toLowerCase();
    if (!key) fieldErrors[f.id] = "Name is required";
    else if (seen.has(key)) fieldErrors[f.id] = "Duplicate field name";
    seen.add(key);
    const problem = settingsProblem(f, components);
    if (problem) targetErrors[f.id] = problem;
  }
  const nameError = draft.name.trim() ? undefined : "Name is required";
  const pluralError = draft.pluralName.trim() ? undefined : "Plural name is required";
  // A collection always has a field (the last one can't be removed).
  const valid =
    !nameError &&
    !pluralError &&
    draft.fields.length > 0 &&
    Object.keys(fieldErrors).length === 0 &&
    Object.keys(targetErrors).length === 0;
  return { nameError, pluralError, fieldErrors, targetErrors, valid };
}

function CollectionEditor({ existing }: { existing?: Collection }) {
  // Element ids unique per instance: the same page can be open in several tabs.
  const uid = useId();
  const { repo, collections, reloadCollections, components, spaces, space } = useStore();
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();
  const [draft, setDraft] = useState(() => initialDraft(existing));
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  // The plural follows the singular until the user edits it themselves.
  const [pluralTouched, setPluralTouched] = useState(!!existing);

  // A new collection starts by naming it.
  useEffect(() => {
    if (!existing) document.getElementById(`${uid}-collection-name`)?.focus();
  }, [existing, uid]);

  const counts = useItemCounts();
  const persisted = useMemo(() => new Set(existing?.fields.map((f) => f.id)), [existing]);
  const { nameError, pluralError, fieldErrors, targetErrors, valid } = validate(draft, components);

  // Reference targets: all collections, plus this one itself while it is being created.
  const targets: Target[] = existing
    ? collections.map((t) => ({ id: t.id, name: t.pluralName, icon: t.icon }))
    : [
        ...collections.map((t) => ({ id: t.id, name: t.pluralName, icon: t.icon })),
        { id: draft.id, name: `${draft.pluralName || "This collection"} (itself)`, icon: draft.icon },
      ];

  const updateField = (id: string, patch: Partial<DraftField>) =>
    setDraft((d) => ({ ...d, fields: d.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)) }));

  const reorder = useReorder({
    count: draft.fields.length,
    onMove: (start, end, to) => setDraft((d) => ({ ...d, fields: moveBlock(d.fields, start, end, to) })),
    onDelete: (indices) => setDraft((d) => ({ ...d, fields: d.fields.filter((_, i) => !indices.includes(i)) })),
    canDelete: (indices) => indices.length < draft.fields.length, // a collection needs a field
    noun: ["field", "fields"],
  });

  const removeField = (id: string) => setDraft((d) => ({ ...d, fields: d.fields.filter((f) => f.id !== id) }));

  const addField = () =>
    setDraft((d) => ({ ...d, fields: [...d.fields, draftField()] }));

  async function save(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (!valid) return;

    const removed = existing?.fields.filter((f) => !draft.fields.some((d) => d.id === f.id)) ?? [];
    if (removed.length > 0) {
      const ok = await confirm({
        title: "Remove fields?",
        body: `The values of ${removed.map((f) => `“${f.name}”`).join(", ")} will no longer be shown on any item.`,
        confirmLabel: "Remove and save",
      });
      if (!ok) return;
    }

    setSaving(true);
    try {
      await repo.saveCollection({
        ...draft,
        name: draft.name.trim(),
        pluralName: draft.pluralName.trim(),
        description: draft.description.trim(),
        fields: draft.fields.map((f) => ({
          ...f,
          name: f.name.trim(),
          targetCollectionId: isReferenceKind(f.kind) ? f.targetCollectionId : null,
        })),
      }, space.id);
      await reloadCollections();
      navigate(`/collections/${draft.id}/items`);
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  }

  return (
    <div className="form-page">
      <PageHeader
        current={existing ? `Edit ${existing.pluralName}` : "New collection"}
        title={
          // The header is the editor for the collection's icon and name.
          <div className="title-edit">
            <IconPicker id={`${uid}-collection-icon`} value={draft.icon} onChange={(icon) => setDraft((d) => ({ ...d, icon }))} />
            <TextInput size="sm"
              id={`${uid}-collection-name`}
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
        breadcrumbs={[{ label: "Collections", href: "#/collections" }]}
      />
      {error && <InlineNotification kind="error" title="Could not save" subtitle={error} onClose={() => setError(undefined)} />}
      <Form onSubmit={save} noValidate>
        <Stack gap={6}>
          <TextInput size="sm"
            id={`${uid}-collection-plural-name`}
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
            id={`${uid}-collection-description`}
            labelText="Description (optional)"
            rows={2}
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          />
          {/* Where it shows: every space unless some are chosen (its items stay in their own space). */}
          {spaces.length > 1 && (
            <MultiSelect<Space>
              autoAlign
              id={`${uid}-collection-spaces`}
              size="sm"
              titleText="Spaces"
              label={draft.spaceIds === null ? "All spaces" : spaces.filter((s) => draft.spaceIds!.includes(s.id)).map((s) => s.name).join(", ")}
              helperText="Shown in every space while none is chosen."
              items={spaces}
              itemToString={(s) => s?.name ?? ""}
              itemToElement={(s) => <SpaceLabel space={s} />}
              selectedItems={spaces.filter((s) => draft.spaceIds?.includes(s.id))}
              onChange={({ selectedItems }) =>
                setDraft((d) => ({ ...d, spaceIds: selectedItems && selectedItems.length > 0 ? selectedItems.map((s) => s.id) : null }))
              }
            />
          )}

          <FormGroup legendText="Fields">
            <p className="helper">A field's type cannot change once saved.</p>
            {draft.fields.map((f, i) => (
              <div className="field-row" key={f.id} {...reorder.row(i)}>
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
                  selectedItem={offeredKind(f.kind)}
                  disabled={persisted.has(f.id)}
                  itemToString={(k) => (k ? fieldKinds[k].label : "")}
                  itemToElement={(k) => <FieldKindLabel kind={k} />}
                  renderSelectedItem={(k) => <FieldKindLabel kind={k} />}
                  onChange={({ selectedItem: k }) => k && updateField(f.id, newKindPatch(k))}
                />
                <div className="field-row__actions">
                  <IconButton
                    autoAlign
                    size="sm"
                    kind="ghost"
                    label={draft.fields.length === 1 ? "A collection needs at least one field" : "Remove field"}
                    disabled={draft.fields.length === 1}
                    onClick={() => removeField(f.id)}
                  >
                    <TrashCan />
                  </IconButton>
                  {/* The drag handle is always a row's last icon. */}
                  {reorder.handle(i)}
                </div>
                {/* What the field's type brings (its target, icon, component): a part of the field, under it. */}
                {hasSettings(f.kind) && (
                  <div className="field-row__settings">
                    <Stack gap={5}>
                      <FieldSettings
                        id={`${uid}-field-${f.id}`}
                        field={f}
                        persisted={persisted.has(f.id)}
                        targets={targets}
                        problem={submitted ? targetErrors[f.id] : undefined}
                        itemCount={existing ? (counts[existing.id] ?? 0) : 0}
                        onChange={(patch) => updateField(f.id, patch)}
                      />
                    </Stack>
                  </div>
                )}
              </div>
            ))}
            <Button kind="tertiary" size="sm" renderIcon={Add} iconDescription="Add field" onClick={addField} className="add-field">
              Add field
            </Button>
            {reorder.dialog}
          </FormGroup>

          <div className="form-actions">
            <Button size="sm" kind="secondary" onClick={() => navigate(existing ? `/collections/${existing.id}/items` : "/collections")}>
              Cancel
            </Button>
            <Button size="sm" type="submit" disabled={saving}>
              {existing ? "Save changes" : "Create collection"}
            </Button>
          </div>
        </Stack>
      </Form>
      {dialog}
    </div>
  );
}
