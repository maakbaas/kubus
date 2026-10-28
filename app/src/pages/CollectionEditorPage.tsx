import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { Button, Dropdown, FilterableMultiSelect, Form, FormGroup, IconButton, InlineNotification, MultiSelect, Stack, TextArea, TextInput } from "@carbon/react";
import { Add, TrashCan, ViewOff } from "@carbon/icons-react";
import { useStore, useCollection } from "../app/store";
import { useItemCounts } from "../app/useItemCounts";
import { fieldKinds, offeredKind } from "../domain/fieldKinds";
import { isRemote, offeredKinds, withHiddenColumns } from "../domain/sources";
import { SourceSettings } from "../ui/SourceSettings";
import {
  blankField,
  isReferenceKind,
  canBeTitle,
  NO_TITLE,
  newId,
  suggestSingular,
  collectionDraft,
  type FieldKind,
  type FieldDraft,
  type Collection,
  type CollectionDraft,
} from "../domain/model";
import { FieldKindLabel } from "../ui/fieldKindIcons";
import { draftProblems } from "../domain/collectionDraft";
import { FieldSettings, hasSettings, newKindPatch, type Target } from "../ui/FieldSettings";
import { IconPicker } from "../ui/IconPicker";
import { SpaceLabel } from "../ui/SpaceSwitcher";
import type { Space } from "../domain/spaces";
import { NotFound } from "../ui/NotFound";
import { PageHeader } from "../ui/PageHeader";
import { errorMessage, useConfirm } from "../ui/useConfirm";
import { moveBlock, useReorder } from "../ui/useReorder";
import { useLinkTarget } from "../ui/useLinkTarget";

/** The title choice "the first text field with a value" (titleField null). */
const AUTO_TITLE = "auto";

/**
 * The collection editor: under Collections for a native collection, under Remotes (`remote`: the
 * routes `/remotes/new`, `/remotes/:id/edit`) for a remote one, its items read from one of the
 * server's remote connections. A collection opened under the other one's path is sent to its own.
 */
export function CollectionEditorPage({ remote = false }: { remote?: boolean }) {
  const { collectionId } = useParams();
  const existing = useCollection(collectionId);
  if (collectionId && !existing) return <NotFound />;
  if (existing && isRemote(existing) !== remote)
    return <Navigate to={`${isRemote(existing) ? "/remotes" : "/collections"}/${existing.id}/edit`} replace />;
  return <CollectionEditor key={collectionId ?? (remote ? "new-remote" : "new")} existing={existing} remote={remote} />;
}

type DraftField = CollectionDraft["fields"][number];

/** A new field in a draft: a string field without a name. */
export function draftField(name = "", kind: FieldKind = "string"): FieldDraft {
  const { collectionId: _c, position: _p, ...field } = blankField(newId(), name, kind);
  return field;
}

function initialDraft(existing?: Collection, remote = false): CollectionDraft {
  if (existing) return collectionDraft(existing);
  // Its fields come from the columns it reads.
  if (remote) {
    return {
      id: newId(),
      name: "",
      pluralName: "",
      icon: "DataBase",
      description: "",
      spaceIds: null,
      source: { name: "", target: { table: { schema: null, name: "" } }, key: "", columns: [] },
      fields: [],
    };
  }
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

function CollectionEditor({ existing, remote: newRemote = false }: { existing?: Collection; remote?: boolean }) {
  // Element ids unique per instance: the same page can be open in several tabs.
  const uid = useId();
  const { repo, collections, reloadCollections, components, spaces, space } = useStore();
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();
  const [draft, setDraft] = useState(() => initialDraft(existing, newRemote));
  const remote = isRemote(draft);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  // The singular follows the plural (the name shown most: lists, menus, blocks) until the user edits it themselves.
  const [singularTouched, setSingularTouched] = useState(!!existing);

  // A new collection starts by naming it.
  useEffect(() => {
    if (!existing) document.getElementById(`${uid}-collection-plural-name`)?.focus();
  }, [existing, uid]);

  // A link to one of the fields (?field=, e.g. a local component's from the Components page):
  // scrolled to and flashed.
  const [params] = useSearchParams();
  useLinkTarget(params.get("field"), (id) =>
    [...document.querySelectorAll(`.field-row[data-field-id="${CSS.escape(id)}"]`)].find((el) => !el.closest("[hidden]")),
  );

  const counts = useItemCounts();
  const persisted = useMemo(() => new Set(existing?.fields.map((f) => f.id)), [existing]);
  const { nameError, pluralError, fieldErrors, targetErrors, sourceError, valid } = draftProblems(draft, components);
  // Names typed by hand stay; until then a remote collection is named after its table.
  const [namesTyped, setNamesTyped] = useState(!!existing);

  // Reference targets: all native collections (a remote one's rows aren't stored to point at),
  // plus this one itself while it is being created.
  const native = collections.filter((t) => !isRemote(t));
  const targets: Target[] = existing
    ? native.map((t) => ({ id: t.id, name: t.pluralName, icon: t.icon }))
    : [
        ...native.map((t) => ({ id: t.id, name: t.pluralName, icon: t.icon })),
        { id: draft.id, name: `${draft.pluralName || "This collection"} (itself)`, icon: draft.icon },
      ];

  const updateField = (id: string, patch: Partial<DraftField>) =>
    setDraft((d) => ({ ...d, fields: d.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)) }));

  const reorder = useReorder({
    count: draft.fields.length,
    onMove: (start, end, to) => setDraft((d) => ({ ...d, fields: moveBlock(d.fields, start, end, to) })),
    // A remote collection's column fields are hidden, not removed (they'd come back when its columns are read).
    onDelete: (indices) =>
      setDraft((d) => {
        const columns = d.source ? d.fields.flatMap((f, i) => (indices.includes(i) && f.column ? [f.column] : [])) : [];
        const rest = { ...d, fields: d.fields.filter((f, i) => !indices.includes(i) || (d.source && f.column)) };
        return columns.length ? withHiddenColumns(rest, [...(d.source?.hiddenColumns ?? []), ...columns]) : rest;
      }),
    canDelete: (indices) => indices.length < draft.fields.length, // a collection needs a field
    noun: ["field", "fields"],
  });

  /** A column's type as the source names it, for its field's helper text. */
  const columnType = (column: string) => {
    const type = draft.source?.columns.find((c) => c.name === column)?.type;
    return type ? ` (${type})` : "";
  };

  // Title choices: its text fields (as they are now), the first with a value, or none.
  // What can be the title: a text, number or date field (automatic: the first text field with a value).
  const titleCandidates = draft.fields.filter(canBeTitle);
  const removeField = (id: string) => setDraft((d) => ({ ...d, fields: d.fields.filter((f) => f.id !== id) }));
  const hideColumns = (hidden: string[]) => setDraft((d) => withHiddenColumns(d, hidden));
  const hiddenColumns = draft.source?.hiddenColumns ?? [];

  // A remote collection's own fields are component fields: its stored values are the source's.
  const addField = () =>
    setDraft((d) => ({ ...d, fields: [...d.fields, remote ? { ...draftField(), ...newKindPatch("component") } : draftField()] }));

  async function save(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (!valid) return;

    // Hidden columns aren't asked about: the source's values stay where they are.
    const removed = existing?.fields.filter((f) => !draft.fields.some((d) => d.id === f.id) && !(draft.source && f.column)) ?? [];
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
        current={existing ? `Edit ${existing.pluralName}` : remote ? "New remote collection" : "New collection"}
        title={
          // The header is the editor for the collection's icon and its (plural) name.
          <div className="title-edit">
            <IconPicker id={`${uid}-collection-icon`} value={draft.icon} onChange={(icon) => setDraft((d) => ({ ...d, icon }))} />
            <TextInput size="sm"
              id={`${uid}-collection-plural-name`}
              className="title-edit__name"
              labelText="Name"
              hideLabel
              placeholder="Name, e.g. Authors"
              value={draft.pluralName}
              onChange={(e) => {
                const pluralName = e.target.value;
                setNamesTyped(true);
                setDraft((d) => ({ ...d, pluralName, name: singularTouched ? d.name : suggestSingular(pluralName) }));
              }}
              invalid={submitted && !!pluralError}
              invalidText={pluralError}
            />
          </div>
        }
        breadcrumbs={[remote ? { label: "Remotes", href: "#/remotes" } : { label: "Collections", href: "#/collections" }]}
      />
      {error && <InlineNotification kind="error" title="Could not save" subtitle={error} onClose={() => setError(undefined)} />}
      <Form onSubmit={save} noValidate>
        <Stack gap={6}>
          <TextInput size="sm"
            id={`${uid}-collection-name`}
            labelText="Singular name"
            helperText={`One of them: “New ${draft.name.trim() || "Author"}”, “This ${draft.name.trim() || "Author"}”.`}
            placeholder="e.g. Author"
            value={draft.name}
            onChange={(e) => {
              setSingularTouched(true);
              setNamesTyped(true);
              setDraft((d) => ({ ...d, name: e.target.value }));
            }}
            invalid={submitted && !!nameError}
            invalidText={nameError}
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

          {draft.source && (
            <FormGroup legendText="Source">
              <SourceSettings draft={draft} isNew={!existing} namesFree={!namesTyped} problem={submitted ? sourceError : undefined} onChange={setDraft} />
            </FormGroup>
          )}

          <FormGroup legendText="Fields">
            <p className="helper">
              {remote
                ? "Its fields show the source's columns (a text column also as Markdown or HTML); fields added here are component fields."
                : "A field's type cannot change once saved."}
            </p>
            {draft.fields.map((f, i) => (
              <div className="field-row" key={f.id} data-field-id={f.id} {...reorder.row(i)}>
                <TextInput size="sm"
                  id={`${uid}-field-name-${f.id}`}
                  labelText="Field name"
                  value={f.name}
                  helperText={f.column ? `Column ${f.column}${columnType(f.column)}` : undefined}
                  onChange={(e) => updateField(f.id, { name: e.target.value })}
                  invalid={submitted && !!fieldErrors[f.id]}
                  invalidText={fieldErrors[f.id]}
                />
                <Dropdown<FieldKind> autoAlign
                  size="sm"
                  id={`${uid}-field-kind-${f.id}`}
                  titleText="Field type"
                  label="Field type"
                  items={offeredKinds(draft, f)}
                  selectedItem={offeredKind(f.kind)}
                  disabled={offeredKinds(draft, f).length < 2 || (persisted.has(f.id) && !remote)}
                  itemToString={(k) => (k ? fieldKinds[k].label : "")}
                  itemToElement={(k) => <FieldKindLabel kind={k} />}
                  renderSelectedItem={(k) => <FieldKindLabel kind={k} />}
                  onChange={({ selectedItem: k }) => k && updateField(f.id, newKindPatch(k))}
                />
                <div className="field-row__actions">
                  {/* A column's field is hidden (and stays so when the columns are read again), not removed. */}
                  <IconButton
                    autoAlign
                    size="sm"
                    kind="ghost"
                    label={draft.fields.length === 1 ? "A collection needs at least one field" : remote && f.column ? "Hide column" : "Remove field"}
                    disabled={draft.fields.length === 1}
                    onClick={() => (remote && f.column ? hideColumns([...hiddenColumns, f.column]) : removeField(f.id))}
                  >
                    {remote && f.column ? <ViewOff /> : <TrashCan />}
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
                        collection={existing}
                        onChange={(patch) => updateField(f.id, patch)}
                      />
                    </Stack>
                  </div>
                )}
              </div>
            ))}
            {draft.source && hiddenColumns.length > 0 && (
              <FilterableMultiSelect<string>
                autoAlign
                size="sm"
                id={`${uid}-hidden-columns`}
                titleText="Hidden columns"
                helperText="Not shown as fields; take one out to show it again."
                placeholder="Hide columns"
                items={draft.source.columns.map((c) => c.name)}
                itemToString={(c) => c ?? ""}
                selectedItems={hiddenColumns}
                selectionFeedback="fixed"
                onChange={({ selectedItems }) => hideColumns(selectedItems ?? [])}
              />
            )}
            <Button kind="tertiary" size="sm" renderIcon={Add} iconDescription="Add field" onClick={addField} className="add-field">
              Add field
            </Button>
            {reorder.dialog}
          </FormGroup>

          {/* Which text field an item is called by (lists, links, its page's heading), or none: then by the collection's name. */}
          <Dropdown<string>
            autoAlign
            size="sm"
            id={`${uid}-title-field`}
            titleText="Title"
            label="Title"
            helperText={`What an item is called in lists, links and on its page. Without a title it is called “${draft.name.trim() || "Item"}”.`}
            items={[AUTO_TITLE, ...titleCandidates.map((f) => f.id), NO_TITLE]}
            selectedItem={draft.titleField === NO_TITLE ? NO_TITLE : titleCandidates.some((f) => f.id === draft.titleField) ? draft.titleField! : AUTO_TITLE}
            itemToString={(id) =>
              id === AUTO_TITLE ? "The first text field with a value" : id === NO_TITLE ? "No title" : (titleCandidates.find((f) => f.id === id)?.name.trim() || "Unnamed field")
            }
            onChange={({ selectedItem }) => setDraft((d) => ({ ...d, titleField: !selectedItem || selectedItem === AUTO_TITLE ? null : selectedItem }))}
          />

          <div className="form-actions">
            <Button size="sm" kind="secondary" onClick={() => navigate(existing ? `/collections/${existing.id}/items` : remote ? "/remotes" : "/collections")}>
              Cancel
            </Button>
            <Button size="sm" type="submit" disabled={saving}>
              {existing ? "Save changes" : remote ? "Add collection" : "Create collection"}
            </Button>
          </div>
        </Stack>
      </Form>
      {dialog}
    </div>
  );
}
