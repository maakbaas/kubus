import { isEmptyValue as isEmpty } from "../domain/query";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { Checkbox, Heading, IconButton, InlineNotification, Stack, Tab, TabList, Tabs, TextInput } from "@carbon/react";
import { Add, Checkmark, Edit, Information, Pin, PinFilled, SettingsAdjust, Star, StarFilled, TrashCan, Undo, Save } from "@carbon/icons-react";
import { useStore, useType } from "../app/store";
import { useDataChanges } from "../app/useDataChanges";
import { formatDate, formatTime } from "../domain/fieldKinds";
import {
  objectLabel,
  labelField,
  newName,
  fieldValue,
  isMetaField,
  pickableFields,
  type FieldDef,
  type FieldValue,
  type ObjectInstance,
  type ObjectType,
} from "../domain/model";
import { captureEditStart, type EditStart } from "../ui/editStart";
import { FieldEditor } from "../ui/FieldEditor";
import { ListField } from "../ui/ListField";
import { Highlight } from "../ui/Highlight";
import { ObjectLink } from "../ui/ObjectLink";
import { ToggleInput } from "../ui/ToggleInput";
import { ImageInput, useFileUrl } from "../ui/images";
import { MarkdownView } from "../ui/MarkdownView";
import { NotFound } from "../ui/NotFound";
import { formatDateTime } from "../domain/fieldKinds";
import { ERROR_PREFIX, outputOf, withComputed } from "../domain/templates";
import { TemplateValue } from "../ui/TemplateValue";
import { BookmarkButton } from "../ui/BookmarkButton";
import {
  objectPageFields,
  objectViewOf,
  FULL_LAYOUT,
  isRestricted,
  newObjectViewId,
  sameLayout,
  type ObjectLayout,
  type ObjectView,
} from "../domain/fieldLayout";
import { FieldOrderEditor } from "../ui/FieldOrderEditor";
import { FieldLabel } from "../ui/fieldKindIcons";
import { TypeIcon } from "../ui/typeIcons";
import { PageHeader } from "../ui/PageHeader";
import { ToolbarPopover } from "../ui/ToolbarPopover";
import { errorMessage, useConfirm } from "../ui/useConfirm";
import { refLabelOf, useReferenceOptions, type RefOptions } from "../ui/useReferenceOptions";

// An object's page: every field in the user's order, each read-only until clicked,
// then edited in place (one at a time). The full form is only for new objects.

export function ObjectViewPage() {
  const { typeId, objectId } = useParams();
  const type = useType(typeId);
  if (!type || !objectId) return <NotFound />;
  return <ObjectPage key={objectId} type={type} objectId={objectId} />;
}


function ImageValue({ fileId, alt }: { fileId: string; alt: string }) {
  const url = useFileUrl(fileId);
  return url ? <img className="object-view__image" src={url} alt={alt} /> : null;
}

function PropertyValue({ field, value, refs }: { field: FieldDef; value: FieldValue; refs: RefOptions }): ReactNode {
  switch (field.kind) {
    case "string":
      // Through Highlight: a {{ }} section's warning in it shows as a warning.
      return <Highlight text={String(value)} query="" />;
    // Numbers, dates and times read exactly as in their Carbon inputs (same text, same font,
    // same place), so switching to edit mode changes nothing on screen.
    case "number":
      return typeof value === "number" ? String(value) : null;
    case "date":
      return typeof value === "string" ? value : null;
    case "datetime": {
      if (typeof value !== "string") return null;
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return value;
      return (
        <>
          <span className="view-datetime__date">{formatDate(d)}</span>
          <span className="view-datetime__time">{formatTime(d)}</span>
        </>
      );
    }
    case "object":
      return <ObjectLink field={field} id={String(value)} refs={refs} />;
    case "object_list":
      return (
        <span className="object-view__links">
          {(value as string[]).map((id) => (
            <ObjectLink key={id} field={field} id={id} refs={refs} />
          ))}
        </span>
      );
    case "markdown":
      return <MarkdownView source={String(value)} />;
    case "image":
      return <ImageValue fileId={String(value)} alt={field.name} />;
    case "template":
      return value == null ? null : <MarkdownView source={String(value)} />;
    case "checkbox":
    case "string_list":
    case "checklist":
      return null; // laid out by ViewField
  }
}

function ObjectPage({ type, objectId }: { type: ObjectType; objectId: string }) {
  const { repo, templates, cache } = useStore();
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();
  const refs = useReferenceOptions(type);
  // undefined = loading, null = not found. Opened from a list, the object is in memory already:
  // shown at once (and read again below, as always).
  const [object, setObject] = useState<ObjectInstance | null | undefined>(() =>
    cache.objects.snapshot(type.id).items?.find((o) => o.id === objectId),
  );
  /** The field being edited, and where its value was clicked (markdown starts editing there). */
  const [editing, setEditing] = useState<{ fieldId: string; start?: EditStart } | null>(null);
  const [error, setError] = useState<string>();
  // A table row's edit icon opens the page standard (?edit=1).
  const [params] = useSearchParams();
  const [standard, setStandard] = useState(params.get("edit") === "1");
  /** The chosen tab: "object" (this object's own layout) or an object view's id; null = the default. */
  const [tab, setTab] = useState<string | null>(null);
  /** Unsaved changes to the shown view's layout (like the objects page's views: saved explicitly). */
  const [draft, setDraft] = useState<ObjectLayout | null>(null);
  /** Set after "+": opens the layout popover with the new view's name selected, to rename it. */
  const [renameRequest, setRenameRequest] = useState(0);

  useEffect(() => {
    repo.getObject(type, objectId).then(setObject, (e) => setError(errorMessage(e)));
  }, [repo, type, objectId]);
  // Edits elsewhere (a table cell in another pane, a checkbox) refresh this object.
  // While this page saves a field it reads the object itself afterwards: the change that save
  // announces needn't fetch it a second time.
  const saving = useRef(false);
  useDataChanges((change) => {
    if (change.scope === "objects" && change.objectId === objectId && !saving.current) {
      repo.getObject(type, objectId).then(setObject, (e) => setError(errorMessage(e)));
    }
  });

  const listPath = `/types/${type.id}/objects`;
  // Nothing until it is in (a fraction of a second): a spinner would only flash.
  if (object === undefined && !error) return null;
  if (object === null) return <NotFound />;

  // Template fields show their computed results.
  const refLabel = refLabelOf(refs);
  const shown = object ? withComputed(type, [object], templates, refLabel)[0] : null;
  // The title as shown (its {{ }} sections rendered, like in tables); editing it edits the source.
  const title = shown ? objectLabel(type, shown) : "";
  // The field shown as the page title is edited there, not repeated among the fields.
  const titleField = shown ? labelField(type, shown) : undefined;
  const titleSource = titleField && object ? String(object.values[titleField.id] ?? "") : title;
  // The page's layout: the chosen tab's object view, else the one this object is pinned to, else its
  // type's default (starred, else the first), else the standard one (all fields, editable, with
  // names), which the edit icon also switches to for the time being (`standard`, above).
  const objectViews = type.objectViews;
  const activeView = objectViews.find((v) => v.id === tab) ?? (object ? objectViewOf(type, object) : null);
  const pinned = !!activeView && activeView.id === object?.objectViewId;
  const saved = activeView?.layout ?? FULL_LAYOUT;
  const current = draft ?? saved;
  const changed = draft !== null && !sameLayout(draft, saved);
  const layout = standard ? FULL_LAYOUT : current;
  const showTab = (id: string | null) => {
    setTab(id);
    setDraft(null);
    setStandard(false);
  };
  const saveViews = (views: ObjectView[]) => repo.saveObjectViews(type.id, views).catch((e) => setError(errorMessage(e)));

  /**
   * "+": a new object view from what is shown, named "New" (then "New 2", …): the shown layout
   * with its unsaved changes (the shown view itself stays as saved; this is also "save as new
   * view"). It opens with the layout popover open and its name selected, ready to rename.
   */
  function addView() {
    const name = newName(objectViews.map((v) => v.name));
    const id = newObjectViewId();
    const layout = current;
    showTab(id);
    setRenameRequest((r) => r + 1);
    return saveViews([...objectViews, { id, name, layout, isDefault: false }]);
  }
  const addButton = (align: "bottom" | "bottom-end") => (
    <IconButton autoAlign kind="ghost" size="sm" align={align} label="Add view" onClick={addView}>
      <Add />
    </IconButton>
  );
  /** With one view and nothing unsaved there is nothing to choose or save: no tab bar ("+" then sits in the header). */
  const showBar = !!object && (objectViews.length > 1 || changed);

  /** Pin the shown view to this object (it then opens with it, whatever the default), or unpin it. */
  const togglePin = (view: ObjectView) =>
    object && repo.pinObjectView(object.id, pinned ? null : view.id).catch((e) => setError(errorMessage(e)));

  /** Star the shown view as the default for the type's objects, or unstar it (then the first is). */
  const toggleDefault = (view: ObjectView) => saveViews(objectViews.map((v) => ({ ...v, isDefault: v.id === view.id && !view.isDefault })));

  async function deleteView(view: ObjectView) {
    if (!(await confirm({ title: `Delete view “${view.name}”?`, body: "Objects are not affected." }))) return;
    showTab(null);
    await saveViews(objectViews.filter((v) => v.id !== view.id));
  }
  const fields = objectPageFields(pickableFields(type), layout, titleField?.id).filter(
    (f) => !layout.hideEmpty || editing?.fieldId === f.id || !isEmpty(shown ? fieldValue(shown, f) : null),
  );
  const restricted = !!object && isRestricted(type, object, layout);

  async function saveField(field: FieldDef, value: FieldValue) {
    if (!object) return;
    saving.current = true;
    try {
      await repo.updateObject(type, object.id, { [field.id]: value });
      setObject(await repo.getObject(type, object.id));
    } finally {
      saving.current = false;
    }
    // Clicking another field saves this one; don't close the editor that click just opened.
    setEditing((current) => (current?.fieldId === field.id ? null : current));
  }

  async function remove() {
    if (!object || !(await confirm({ title: `Delete ${type.name}?`, body: `“${title}” will be removed.` }))) return;
    try {
      await repo.deleteObject(object.id);
      navigate(listPath, { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="form-page object-view">
      <PageHeader
        title={
          // The title edits in place, unless the layout makes the page read-only.
          titleField && layout.editable ? (
            <EditableTitle
              value={title}
              source={titleSource}
              onSave={(v) => saveField(titleField, v || null).catch((e) => setError(errorMessage(e)))}
            />
          ) : (
            title
          )
        }
        current={title}
        breadcrumbs={[
          { label: "Types", href: "#/types" },
          { label: type.pluralName, href: `#${listPath}` },
        ]}
        actions={
          object && (
            <>
              {(restricted || standard) && (
                <IconButton
                  autoAlign
                  size="sm"
                  kind="ghost"
                  align="bottom"
                  label={standard ? "Back to this page's layout" : "Show all fields, editable"}
                  aria-pressed={standard}
                  onClick={() => setStandard((s) => !s)}
                >
                  {standard ? <Checkmark /> : <Edit />}
                </IconButton>
              )}
              <BookmarkButton kind="object" typeId={type.id} targetId={object.id} label={title} onError={(e) => setError(errorMessage(e))} />
              {/* Metadata lives in a popover; more facts about the object can be added to its list. */}
              <ToolbarPopover label="Details" icon={Information} fit>
                <dl className="object-info">
                  <dt>Type</dt>
                  <dd>
                    <span className="icon-label">
                      <TypeIcon name={type.icon} />
                      {type.name}
                    </span>
                  </dd>
                  <dt>Created</dt>
                  <dd>{formatDateTime(object.createdAt)}</dd>
                  <dt>Updated</dt>
                  <dd>{formatDateTime(object.updatedAt)}</dd>
                </dl>
              </ToolbarPopover>
              {/* Subtle: a ghost icon button; the confirmation dialog carries the danger styling. */}
              <IconButton autoAlign size="sm" kind="ghost" align="bottom" label={`Delete ${type.name}`} onClick={remove}>
                <TrashCan />
              </IconButton>
              {/* The page's layout last: its settings, and "+" for a new layout while there is no tab bar. */}
              <ToolbarPopover label="Page layout" icon={SettingsAdjust} fit openRequest={renameRequest}>
                <ObjectLayoutSettings
                  type={type}
                  renameRequest={renameRequest}
                  view={activeView}
                  layout={current}
                  titleFieldId={titleField?.id}
                  onChange={(patch) => setDraft({ ...current, ...patch })}
                  onError={(e) => setError(errorMessage(e))}
                />
              </ToolbarPopover>
              {!showBar && addButton("bottom-end")}
            </>
          )
        }
      />
      {error && <InlineNotification kind="error" title="Error" subtitle={error} onClose={() => setError(undefined)} />}

      {/* Once the type has object views: one tab each, like the views of the objects page. The
          star makes the shown one the default for all objects, the pin this object's own choice.
          Layout changes stay unsaved until saved with the icon buttons beside the tabs. */}
      {/* With one view and nothing unsaved there is nothing to choose or save: no tab bar. */}
      {showBar && (
        <div className="views-bar">
          <Tabs
            selectedIndex={activeView ? objectViews.indexOf(activeView) : -1}
            onChange={({ selectedIndex }) => showTab(objectViews[selectedIndex].id)}
          >
            <TabList aria-label="Page layouts" className="views-tabs">
              {/* "*" marks unsaved layout changes to the shown view (switching views discards them). */}
              {objectViews.map((t) => (
                <Tab key={t.id}>
                  {t.name}
                  {changed && t.id === activeView?.id ? " *" : ""}
                </Tab>
              ))}
            </TabList>
          </Tabs>
          {addButton("bottom")}
          <span className="views-bar__spacer" />
          {changed && (
            <IconButton autoAlign kind="ghost" size="sm" align="bottom" label="Discard changes" onClick={() => setDraft(null)}>
              <Undo />
            </IconButton>
          )}
          {changed && activeView && (
            <>
              <IconButton
                autoAlign
                kind="ghost"
                size="sm"
                align="bottom"
                label="Save changes to view"
                onClick={() => saveViews(objectViews.map((v) => (v.id === activeView.id ? { ...v, layout: current } : v)))}
              >
                <Save />
              </IconButton>
            </>
          )}
          {activeView && (
            <>
              {/* The last view can't be deleted: a type always keeps one (like its objects views). */}
              {objectViews.length > 1 && (
                <IconButton autoAlign kind="ghost" size="sm" align="bottom" label="Delete view" onClick={() => deleteView(activeView)}>
                  <TrashCan />
                </IconButton>
              )}
              {/* Pin and star choose between views: with one view it opens anyway. */}
              {objectViews.length > 1 && (
                <>
              <IconButton
                autoAlign
                kind="ghost"
                size="sm"
                align="bottom"
                label={pinned ? `Unpin from this ${type.name}` : `Always show this ${type.name} with this view`}
                aria-pressed={pinned}
                onClick={() => togglePin(activeView)}
              >
                {pinned ? <PinFilled /> : <Pin />}
              </IconButton>
              <IconButton
                autoAlign
                kind="ghost"
                size="sm"
                align="bottom-end"
                label={activeView.isDefault ? "Revert default view" : `Star as default view for all ${type.pluralName}`}
                aria-pressed={activeView.isDefault}
                onClick={() => toggleDefault(activeView)}
              >
                {activeView.isDefault ? <StarFilled /> : <Star />}
              </IconButton>
                </>
              )}
            </>
          )}
        </div>
      )}

      {object && (
        <Stack gap={7} className="object-fields">
          {fields.map((f) => {
            const field =
            editing?.fieldId === f.id ? (
              <FieldEditor
                key={f.id}
                field={f}
                value={object.values[f.id] ?? null}
                refs={refs}
                start={editing.start}
                onSave={(v) => saveField(f, v)}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <ViewField
                key={f.id}
                field={f}
                value={shown ? fieldValue(shown, f) : null}
                // A value rendered from its own {{ }} sections: its checkboxes can't be toggled in place.
                computed={!!shown?.sources && f.id in shown.sources}
                refs={refs}
                onEdit={(start) => setEditing({ fieldId: f.id, start })}
                onSave={(v) => saveField(f, v).catch((e) => setError(errorMessage(e)))}
                readOnly={!layout.editable || isMetaField(f)}
              />
            );
            // A field shown without its name (the layout's choice); the wrapper adds no box.
            return layout.hiddenLabels.includes(f.id) ? (
              <div key={f.id} className="object-field--no-label">
                {field}
              </div>
            ) : (
              field
            );
          })}
        </Stack>
      )}
      {dialog}
    </div>
  );
}

/**
 * The page title doubles as the editor of the field it shows: click it (or Enter) to edit in
 * place, at the same size and position. Enter or clicking away saves, Escape cancels. The editor
 * is an editable block with the heading's own style (not an input), so a long title wraps over
 * several lines exactly as it does at rest and nothing jumps; the caret starts where it was clicked.
 * A title rendered from {{ }} sections shows its result (`value`) and edits its source.
 */
function EditableTitle({ value, source, onSave }: { value: string; source: string; onSave(value: string): void }) {
  const [editing, setEditing] = useState<{ range?: { start: number; end: number } } | null>(null);
  const cancelled = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const start = (range?: { start: number; end: number }) => {
    cancelled.current = false;
    setEditing({ range });
  };
  useLayoutEffect(() => {
    const el = box.current;
    if (!editing || !el) return;
    el.textContent = source; // uncontrolled from here on: re-renders would move the caret
    el.focus();
    const text = el.firstChild;
    if (!text) return;
    const length = text.textContent?.length ?? 0;
    const caret = document.createRange();
    caret.setStart(text, Math.min(editing.range?.start ?? length, length));
    caret.setEnd(text, Math.min(editing.range?.end ?? length, length));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(caret);
    // Only once, on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing !== null]);
  if (!editing) {
    return (
      <Heading
        className="page-header__title object-title"
        role="button"
        tabIndex={0}
        aria-label={`Edit title: ${value}`}
        onClick={(e) => start(captureEditStart(e.currentTarget, e).range)}
        onKeyDown={(e) => e.key === "Enter" && start()}
      >
        {value}
      </Heading>
    );
  }
  return (
    <div
      ref={box}
      role="textbox"
      aria-label="Title"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      className="page-header__title object-title object-title--editing"
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === "Escape") {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
      onBlur={(e) => {
        // A pasted line break becomes a space: a title is one line of text, wrapped.
        const text = (e.currentTarget.textContent ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim();
        setEditing(null);
        if (!cancelled.current && text !== source) onSave(text);
      }}
    />
  );
}

/**
 * The page layout popover: the shown object view's name, and its layout: whether fields are
 * editable and show their names, and which fields in which order. Layout changes stay unsaved
 * until saved from the tab bar; a rename is saved right away (like the objects page's views).
 */
function ObjectLayoutSettings({
  type,
  renameRequest,
  view,
  layout,
  titleFieldId,
  onChange,
  onError,
}: {
  type: ObjectType;
  /** Changes after "+": the new view's name gets focus, selected, to rename it. */
  renameRequest: number;
  /** The shown object view; null when the type has none yet. */
  view: ObjectView | null;
  /** The shown layout, with unsaved changes. */
  layout: ObjectLayout;
  /** The field shown as the page title: left out unless chosen. */
  titleFieldId: string | undefined;
  onChange(patch: Partial<ObjectLayout>): void;
  onError(e: unknown): void;
}) {
  const { repo } = useStore();
  const uid = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!renameRequest) return;
    // Once the popover has opened and shows the new view's name.
    const frame = requestAnimationFrame(() => {
      nameInput.current?.focus();
      nameInput.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [renameRequest, view?.id]);
  const rename = (name: string) => {
    if (view && name && name !== view.name) {
      repo.saveObjectViews(type.id, type.objectViews.map((v) => (v.id === view.id ? { ...v, name } : v))).catch(onError);
    }
  };

  return (
    <div className="object-layout">
      {view && (
        <TextInput
          size="sm"
          key={view.id + view.name}
          id={`${uid}-object-layout-name`}
          ref={nameInput}
          labelText="View name"
          defaultValue={view.name}
          onBlur={(e) => rename(e.target.value.trim())}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      )}
      <Checkbox id={`${uid}-object-layout-editable`} labelText="Fields are editable" checked={layout.editable} onChange={(_, { checked }) => onChange({ editable: checked })} />
      <Checkbox id={`${uid}-object-layout-hide-empty`} labelText="Hide empty fields" checked={layout.hideEmpty} onChange={(_, { checked }) => onChange({ hideEmpty: checked })} />
      <FieldOrderEditor
        id={`${uid}-object-layout-fields`}
        label="Fields"
        fields={pickableFields(type)}
        type={type}
        value={layout.fields}
        onChange={(fields) => onChange({ fields })}
        hiddenByDefault={titleFieldId ? [titleFieldId] : []}
        hiddenLabels={layout.hiddenLabels}
        onHiddenLabelsChange={(hiddenLabels) => onChange({ hiddenLabels })}
      />
    </div>
  );
}

interface ViewFieldProps {
  field: FieldDef;
  value: FieldValue;
  refs: RefOptions;
  onEdit(start?: EditStart): void;
  /** For fields that are their own editor (checkbox, image): save a new value right away. */
  onSave(value: FieldValue): void;
  /** Shown, not editable (the page's layout). */
  readOnly?: boolean;
  /** The value was rendered from {{ }} sections in it (the source is what gets edited). */
  computed?: boolean;
}

/** One field, laid out like its input in the form: label on top, value in a read-only box. Click to edit. */
function ViewField({ field, value, refs, onEdit, onSave, readOnly, computed }: ViewFieldProps) {
  const { templates } = useStore();
  const uid = useId();
  if (field.kind === "template") {
    // Computed from the other fields: read-only, laid out like any field, shown by its
    // template's output type (Markdown, text, number, image, HTML in the same width).
    const text = value == null ? "" : String(value);
    return (
      <div className="view-field">
        <div className="cds--label">
          <FieldLabel field={field} />
        </div>
        <div
          className={`view-field__value view-field__value--template${text.startsWith(ERROR_PREFIX) ? " view-field__value--error" : ""}${text ? "" : " view-field__value--empty"}`}
          title="Rendered from a template"
        >
          <TemplateValue
            value={value}
            output={outputOf(field, templates)}
            frameRatio={templates.find((t) => t.id === field.templateId)?.frameRatio}
            variant="page"
          />
        </div>
      </div>
    );
  }
  if (field.kind === "checkbox") {
    const boxId = `${uid}-view-${field.id}`;
    // A checkbox is its own editor: toggling saves immediately. Laid out like a checklist item:
    // the box, then the field's name where an item's text starts (clicking it toggles too).
    return (
      <div className="view-field">
        <div className="cds--label">
          <FieldLabel field={field} />
        </div>
        <div className="checklist-row">
          <span className="checklist-box">
            <ToggleInput icon={field.toggleIcon} id={boxId} label={field.name} checked={value === true} onChange={onSave} />
          </span>
          <label htmlFor={boxId} className={`checkbox-field__name${value === true ? " checklist-row__done" : ""}`}>
            {field.name}
          </label>
        </div>
      </div>
    );
  }
  if (field.kind === "image" && readOnly) {
    return (
      <div className="view-field view-field--image">
        <div className="cds--label">
          <FieldLabel field={field} />
        </div>
        {typeof value === "string" && value && <ImageValue fileId={value} alt={field.name} />}
      </div>
    );
  }
  if (field.kind === "image") {
    // Also its own editor: replace / remove on hover, or drop a new one; each saves right away.
    return (
      <ImageInput
        id={`view-${field.id}`}
        label={<FieldLabel field={field} />}
        value={typeof value === "string" ? value : ""}
        onChange={(fileId) => onSave(fileId || null)}
      />
    );
  }

  const empty = isEmpty(value);
  const startEdit = (e: MouseEvent | KeyboardEvent) => {
    // Links inside the value (object references, markdown links) and task checkboxes keep working.
    if ((e.target as HTMLElement).closest("a, .md-view__task--toggle")) return;
    // Keep a click position or a drag-selection, so editing starts right there.
    onEdit("clientX" in e ? captureEditStart(e.currentTarget as HTMLElement, e) : undefined);
  };
  const editable = readOnly ? {} : {
    role: "button",
    tabIndex: 0,
    title: "Click to edit",
    "aria-label": `Edit ${field.name}`,
    onClick: startEdit,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        startEdit(e);
      }
    },
  };

  // Lists edit one item at a time, in place (ListField saves each change itself).
  if (field.kind === "checklist" || field.kind === "string_list" || field.kind === "object_list") {
    return <ListField field={field} value={value} readOnly={readOnly} refs={refs} onSave={onSave} />;
  }

  return (
    <div className="view-field">
      <div className="cds--label">
          <FieldLabel field={field} />
        </div>
      <div
        className={`view-field__value${readOnly ? "" : " view-field__editable"} view-field__value--${field.kind}${empty ? " view-field__value--empty" : ""}`}
        {...editable}
      >
        {!empty &&
          (field.kind === "markdown" && !computed ? (
            // Task checkboxes toggle right here, saving at once.
            <MarkdownView source={String(value)} onChange={onSave} />
          ) : (
            <PropertyValue field={field} value={value} refs={refs} />
          ))}
      </div>
    </div>
  );
}
