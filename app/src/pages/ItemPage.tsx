import { isEmptyValue as isEmpty } from "../domain/query";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { Button, Checkbox, Dropdown, Heading, IconButton, InlineNotification, Stack, Tab, TabList, Tabs, TextInput } from "@carbon/react";
import { Add, Checkmark, Edit, Information, Pin, PinFilled, SettingsAdjust, Star, StarFilled, TrashCan, Undo, Save } from "@carbon/icons-react";
import { NOTHING_COLLAPSED, type Collapsed, type ViewBlock } from "../domain/views";
import { blockType, normalizeBlock, type PageItem } from "../views";
import { BlockView, newPageBlock } from "../views/BlockView";
import { useBlockName } from "../views/BlockListEditor";
import { useCollectionData } from "../views/useCollectionData";
import { useStore, useCollection } from "../app/store";
import { useDataChanges } from "../app/useDataChanges";
import { formatDate, formatTime } from "../domain/fieldKinds";
import {
  itemLabel,
  labelField,
  newName,
  fieldValue,
  isMetaField,
  pickableFields,
  type FieldDef,
  type FieldValue,
  type Item,
  type Collection,
} from "../domain/model";
import { captureEditStart, type EditStart } from "../ui/editStart";
import { FieldEditor } from "../ui/FieldEditor";
import { ComponentFieldEditor } from "../ui/ComponentFieldEditor";
import { ListField } from "../ui/ListField";
import { Highlight } from "../ui/Highlight";
import { ItemLink } from "../ui/ItemLink";
import { ToggleInput } from "../ui/ToggleInput";
import { ImageInput, useFileUrl } from "../ui/images";
import { MarkdownView } from "../ui/MarkdownView";
import { NotFound } from "../ui/NotFound";
import { formatDateTime } from "../domain/fieldKinds";
import { ERROR_PREFIX, outputOf, withComputed } from "../domain/components";
import { HtmlFrame, ComponentValue } from "../ui/ComponentValue";
import { BookmarkButton } from "../ui/BookmarkButton";
import {
  itemPageFields,
  itemViewOf,
  FULL_LAYOUT,
  isRestricted,
  newItemViewId,
  sameLayout,
  type ItemLayout,
  type ItemView,
} from "../domain/fieldLayout";
import { FieldOrderEditor } from "../ui/FieldOrderEditor";
import { FieldLabel } from "../ui/fieldKindIcons";
import { CollectionIcon } from "../ui/collectionIcons";
import { SpaceLabel } from "../ui/SpaceSwitcher";
import type { Space } from "../domain/spaces";
import { PageHeader } from "../ui/PageHeader";
import { ToolbarPopover, usePanelsOpen } from "../ui/ToolbarPopover";
import { errorMessage, useConfirm } from "../ui/useConfirm";
import { refLabelOf, useReferenceOptions, type RefOptions } from "../ui/useReferenceOptions";

// An item's page: every field in the user's order, each read-only until clicked,
// then edited in place (one at a time). The full form is only for new items.

export function ItemPage() {
  const { collectionId, itemId } = useParams();
  const collection = useCollection(collectionId);
  if (!collection || !itemId) return <NotFound />;
  return <ItemContent key={itemId} collection={collection} itemId={itemId} />;
}


function ImageValue({ fileId, alt }: { fileId: string; alt: string }) {
  const url = useFileUrl(fileId);
  return url ? <img className="item-view__image" src={url} alt={alt} data-lightbox /> : null;
}

function PropertyValue({ field, value, refs, onFrameClick }: { field: FieldDef; value: FieldValue; refs: RefOptions; /** HTML: a click on its plain content. */ onFrameClick?(): void }): ReactNode {
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
    case "item":
      return <ItemLink field={field} id={String(value)} refs={refs} />;
    case "item_list":
      return (
        <span className="item-view__links">
          {(value as string[]).map((id) => (
            <ItemLink key={id} field={field} id={id} refs={refs} />
          ))}
        </span>
      );
    case "markdown":
      return <MarkdownView source={String(value)} />;
    case "html":
      // In a sandboxed frame, sized like a component's HTML result.
      return <HtmlFrame html={String(value)} onContentClick={onFrameClick} />;
    case "image":
      return <ImageValue fileId={String(value)} alt={field.name} />;
    case "component":
      return value == null ? null : <MarkdownView source={String(value)} />;
    case "checkbox":
    case "string_list":
    case "checklist":
      return null; // laid out by ViewField
  }
}

function ItemContent({ collection, itemId }: { collection: Collection; itemId: string }) {
  const { repo, components, cache, spaces } = useStore();
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();
  const refs = useReferenceOptions(collection);
  // undefined = loading, null = not found. Opened from a list, the item is in memory already:
  // shown at once (and read again below, as always).
  const [item, setItem] = useState<Item | null | undefined>(() =>
    cache.items.snapshot(collection.id).items?.find((o) => o.id === itemId),
  );
  /** The field being edited, and where its value was clicked (markdown starts editing there). */
  const [editing, setEditing] = useState<{ fieldId: string; start?: EditStart } | null>(null);
  const [error, setError] = useState<string>();
  // A table row's edit icon opens the page standard (?edit=1).
  const [params] = useSearchParams();
  const [standard, setStandard] = useState(params.get("edit") === "1");
  /** The chosen tab: "item" (this item's own layout) or an item view's id; null = the default. */
  const [tab, setTab] = useState<string | null>(null);
  /** Unsaved changes to the shown view's layout (like a collection page's views: saved explicitly). */
  const [draft, setDraft] = useState<ItemLayout | null>(null);
  /** Set after "+": opens the layout popover with the new view's name selected, to rename it. */
  const [renameRequest, setRenameRequest] = useState(0);
  const panels = usePanelsOpen();
  const blockName = useBlockName();
  /**
   * What is stored right away (collapsed blocks and groups, arranged blocks), by item view, shown
   * until the stored views come back with it.
   */
  const [local, setLocal] = useState<Record<string, { collapsed?: Collapsed; layout?: ItemLayout }>>({});
  useEffect(() => setLocal({}), [collection.itemViews]);

  useEffect(() => {
    repo.getItem(collection, itemId).then(setItem, (e) => setError(errorMessage(e)));
  }, [repo, collection, itemId]);
  // Component fields show their computed results.
  const shown = useMemo(
    () => (item ? withComputed(collection, [item], components, refLabelOf(refs))[0] : null),
    [collection, item, components, refs],
  );
  /** The page's item, for its blocks ($item, filter values "this item"). */
  const page = useMemo<PageItem | null>(() => (shown ? { collection, item: shown, refLabel: refLabelOf(refs) } : null), [collection, shown, refs]);
  // Edits elsewhere (a table cell in another pane, a checkbox) refresh this item.
  // While this page saves a field it reads the item itself afterwards: the change that save
  // announces needn't fetch it a second time.
  const saving = useRef(false);
  useDataChanges((change) => {
    if (change.scope === "items" && change.itemId === itemId && !saving.current) {
      repo.getItem(collection, itemId).then(setItem, (e) => setError(errorMessage(e)));
    }
  });

  const listPath = `/collections/${collection.id}/items`;
  // Nothing until it is in (a fraction of a second): a spinner would only flash.
  if (item === undefined && !error) return null;
  if (item === null) return <NotFound />;

  // The title as shown (its {{ }} sections rendered, like in tables); editing it edits the source.
  const title = shown ? itemLabel(collection, shown) : "";
  // The field shown as the page title is edited there, not repeated among the fields.
  const titleField = shown ? labelField(collection, shown) : undefined;
  const titleSource = titleField && item ? String(item.values[titleField.id] ?? "") : title;
  // The page's layout: the chosen tab's item view, else the one this item is pinned to, else its
  // collection's default (starred, else the first), else the standard one (all fields, editable, with
  // names), which the edit icon also switches to for the time being (`standard`, above).
  const itemViews = collection.itemViews;
  const activeView = itemViews.find((v) => v.id === tab) ?? (item ? itemViewOf(collection, item) : null);
  const pinned = !!activeView && activeView.id === item?.itemViewId;
  const saved = (activeView && local[activeView.id]?.layout) ?? activeView?.layout ?? FULL_LAYOUT;
  const current = draft ?? saved;
  const changed = draft !== null && !sameLayout(draft, saved);
  // The standard page keeps the blocks: they aren't fields.
  const layout = standard ? { ...FULL_LAYOUT, blocks: current.blocks } : current;
  /** A change to what a block shows (filter, sort, grouping, fields): unsaved, like the page's fields. */
  const setBlock = (block: ViewBlock) => setDraft({ ...current, blocks: current.blocks.map((b) => (b.id === block.id ? block : b)) });
  const showTab = (id: string | null) => {
    setTab(id);
    setDraft(null);
    setStandard(false);
  };
  const saveViews = (views: ItemView[]) => repo.saveItemViews(collection.id, views).catch((e) => setError(errorMessage(e)));
  const collapsed = activeView ? (local[activeView.id]?.collapsed ?? activeView.collapsed) : NOTHING_COLLAPSED;
  /** Stores the shown item view with these (the virtual "Default" view is stored then), shown at once. */
  const storeNow = (patch: { collapsed?: Collapsed; layout?: ItemLayout }) => {
    if (!activeView) return;
    setLocal((m) => ({ ...m, [activeView.id]: { ...m[activeView.id], ...patch } }));
    saveViews(itemViews.map((v) => (v.id === activeView.id ? { ...v, layout: saved, collapsed, ...patch } : v)));
  };
  /** Collapsing or expanding a block or a group: stored right away. */
  const setCollapsed = (next: Collapsed) => storeNow({ collapsed: next });
  /**
   * Arranging the page's blocks (adding, removing; a block's type, options, name, collection) is
   * stored right away, in the shown and the saved layout alike, so it is no change to save. Where
   * blocks sit among the fields is field order: saved with Save changes, like the fields.
   */
  const arrange = (change: (layout: ItemLayout) => ItemLayout) => {
    if (draft) setDraft(change(draft));
    storeNow({ layout: change(saved) });
  };
  const setBlockNow = (id: string, patch: Partial<ViewBlock>) =>
    arrange((l) => ({ ...l, blocks: l.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)) }));
  const addBlock = (block: ViewBlock) => arrange((l) => ({ ...l, blocks: [...l.blocks, block], fields: l.fields && [...l.fields, block.id] }));
  async function removeBlock(block: ViewBlock) {
    if (!(await confirm({ title: `Remove block “${blockName(block)}”?`, body: "Items are not affected." }))) return;
    arrange((l) => ({ ...l, blocks: l.blocks.filter((b) => b.id !== block.id), fields: l.fields && l.fields.filter((f) => f !== block.id) }));
  }

  /**
   * "+": a new item view from what is shown, named "New" (then "New 2", …): the shown layout
   * with its unsaved changes (the shown view itself stays as saved; this is also "save as new
   * view"). It opens with the layout popover open and its name selected, ready to rename.
   */
  function addView() {
    const name = newName(itemViews.map((v) => v.name));
    const id = newItemViewId();
    const layout = current;
    showTab(id);
    setRenameRequest((r) => r + 1);
    return saveViews([...itemViews, { id, name, layout, isDefault: false, collapsed }]);
  }
  const addButton = (
    <IconButton autoAlign kind="ghost" size="sm" align="bottom" label="Add view" onClick={addView}>
      <Add />
    </IconButton>
  );

  /** Pin the shown view to this item (it then opens with it, whatever the default), or unpin it. */
  const togglePin = (view: ItemView) =>
    item && repo.pinItemView(item.id, pinned ? null : view.id).catch((e) => setError(errorMessage(e)));

  /** Star the shown view as the default for the collection's items, or unstar it (then the first is). */
  const toggleDefault = (view: ItemView) => saveViews(itemViews.map((v) => ({ ...v, isDefault: v.id === view.id && !view.isDefault })));

  async function deleteView(view: ItemView) {
    if (!(await confirm({ title: `Delete view “${view.name}”?`, body: "Items are not affected." }))) return;
    showTab(null);
    await saveViews(itemViews.filter((v) => v.id !== view.id));
  }
  // Fields and blocks, in the layout's order.
  const blocksById = new Map(layout.blocks.map((b) => [b.id, b]));
  const entries = itemPageFields<FieldDef | ViewBlock>([...pickableFields(collection), ...layout.blocks], layout, titleField?.id).filter(
    (f) => blocksById.has(f.id) || !layout.hideEmpty || editing?.fieldId === f.id || !isEmpty(shown ? fieldValue(shown, f as FieldDef) : null),
  );
  const restricted = !!item && isRestricted(collection, item, layout);

  async function saveField(field: FieldDef, value: FieldValue) {
    if (!item) return;
    saving.current = true;
    try {
      await repo.updateItem(collection, item.id, { [field.id]: value });
      setItem(await repo.getItem(collection, item.id));
    } finally {
      saving.current = false;
    }
    // Clicking another field saves this one; don't close the editor that click just opened.
    setEditing((current) => (current?.fieldId === field.id ? null : current));
  }

  async function remove() {
    if (!item || !(await confirm({ title: `Delete ${collection.name}?`, body: `“${title}” will be removed.` }))) return;
    try {
      await repo.deleteItem(item.id);
      navigate(listPath, { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="form-page item-view">
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
          { label: "Collections", href: "#/collections" },
          { label: collection.pluralName, href: `#${listPath}` },
        ]}
        actions={
          item && (
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
              <BookmarkButton kind="item" collectionId={collection.id} targetId={item.id} label={title} onError={(e) => setError(errorMessage(e))} />
              {/* Metadata lives in a popover; more facts about the item can be added to its list. */}
              <ToolbarPopover label="Details" icon={Information} fit onOpenChange={panels.onOpenChange}>
                <dl className="item-info">
                  <dt>Collection</dt>
                  <dd>
                    <span className="icon-label">
                      <CollectionIcon name={collection.icon} />
                      {collection.name}
                    </span>
                  </dd>
                  {/* Moving it to another space takes it out of this space's lists (the page stays open). */}
                  {spaces.length > 1 && (
                    <>
                      <dt>Space</dt>
                      <dd>
                        <Dropdown<Space>
                          autoAlign
                          id={`${item.id}-space`}
                          size="sm"
                          titleText="Space"
                          hideLabel
                          label="Space"
                          items={spaces}
                          itemToString={(s) => s?.name ?? ""}
                          itemToElement={(s) => <SpaceLabel space={s} />}
                          renderSelectedItem={(s) => <SpaceLabel space={s} />}
                          selectedItem={spaces.find((s) => s.id === item.spaceId)}
                          onChange={({ selectedItem }) =>
                            selectedItem && repo.moveItem(item.id, selectedItem.id).catch((e) => setError(errorMessage(e)))
                          }
                        />
                      </dd>
                    </>
                  )}
                  <dt>Created</dt>
                  <dd>{formatDateTime(item.createdAt)}</dd>
                  <dt>Updated</dt>
                  <dd>{formatDateTime(item.updatedAt)}</dd>
                </dl>
              </ToolbarPopover>
              {/* Subtle: a ghost icon button; the confirmation dialog carries the danger styling. */}
              <IconButton autoAlign size="sm" kind="ghost" align="bottom" label={`Delete ${collection.name}`} onClick={remove}>
                <TrashCan />
              </IconButton>
              {/* The page's layout last. */}
              <ToolbarPopover label="Page layout" icon={SettingsAdjust} fit openRequest={renameRequest} onOpenChange={panels.onOpenChange}>
                <ItemLayoutSettings
                  collection={collection}
                  renameRequest={renameRequest}
                  view={activeView}
                  layout={current}
                  titleFieldId={titleField?.id}
                  onChange={(patch) => setDraft({ ...current, ...patch })}
                  onAddBlock={addBlock}
                  onError={(e) => setError(errorMessage(e))}
                />
              </ToolbarPopover>
            </>
          )
        }
      />
      {error && <InlineNotification kind="error" title="Error" subtitle={error} onClose={() => setError(undefined)} />}

      {/* Once the collection has item views: one tab each, like the views of the collection page. The
          star makes the shown one the default for all items, the pin this item's own choice.
          Layout changes stay unsaved until saved with the icon buttons beside the tabs. */}
      {/* Always shown, also for a single view: its name, "+" and saving stay in one place. */}
      {item && (
        <div className="views-bar">
          <Tabs
            selectedIndex={activeView ? itemViews.indexOf(activeView) : -1}
            onChange={({ selectedIndex }) => showTab(itemViews[selectedIndex].id)}
          >
            <TabList aria-label="Page layouts" className="views-tabs">
              {/* "*" marks unsaved layout changes to the shown view (switching views discards them). */}
              {itemViews.map((t) => (
                <Tab key={t.id}>
                  {t.name}
                  {changed && t.id === activeView?.id ? " *" : ""}
                </Tab>
              ))}
            </TabList>
          </Tabs>
          {addButton}
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
                onClick={() => saveViews(itemViews.map((v) => (v.id === activeView.id ? { ...v, layout: current } : v)))}
              >
                <Save />
              </IconButton>
            </>
          )}
          {activeView && (
            <>
              {/* The last view can't be deleted: a collection always keeps one (like its collection views). */}
              {itemViews.length > 1 && (
                <IconButton autoAlign kind="ghost" size="sm" align="bottom" label="Delete view" onClick={() => deleteView(activeView)}>
                  <TrashCan />
                </IconButton>
              )}
              {/* Pin and star choose between views: with one view it opens anyway. */}
              {itemViews.length > 1 && (
                <>
              <IconButton
                autoAlign
                kind="ghost"
                size="sm"
                align="bottom"
                label={pinned ? `Unpin from this ${collection.name}` : `Always show this ${collection.name} with this view`}
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
                label={activeView.isDefault ? "Revert default view" : `Star as default view for all ${collection.pluralName}`}
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

      {item && (
        <Stack gap={7} className="item-fields">
          {entries.map((entry) => {
            const block = blocksById.get(entry.id);
            if (block) {
              return page && (
                <ItemPageBlock
                  key={block.id}
                  block={block}
                  page={page}
                  collapsed={collapsed}
                  onCollapse={setCollapsed}
                  onChange={setBlock}
                  onSet={(patch) => setBlockNow(block.id, patch)}
                  onRemove={() => removeBlock(block)}
                  onError={setError}
                  onOpenChange={panels.onOpenChange}
                />
              );
            }
            const f = entry as FieldDef;
            const component = f.kind === "component" ? components.find((t) => t.id === f.componentId) : undefined;
            const field =
            editing?.fieldId === f.id && component ? (
              // A component field edits its component (shared: saving asks first).
              <ComponentFieldEditor key={f.id} field={f} component={component} onDone={() => setEditing(null)} />
            ) : editing?.fieldId === f.id ? (
              <FieldEditor
                key={f.id}
                field={f}
                value={item.values[f.id] ?? null}
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
              <div key={f.id} className="item-field--no-label">
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
        className="page-header__title item-title"
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
      className="page-header__title item-title item-title--editing"
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
 * A block on an item page: items of a collection (this one or another), typically those linked to
 * the page's item ("Books by this Author"), or a component. Edited from its header like a
 * collection view's block; changes are layout changes (unsaved until saved from the tab bar).
 */
function ItemPageBlock({
  block,
  page,
  collapsed,
  onCollapse,
  onChange,
  onSet,
  onRemove,
  onError,
  onOpenChange,
}: {
  block: ViewBlock;
  page: PageItem;
  collapsed: Collapsed;
  onCollapse(collapsed: Collapsed): void;
  onChange(block: ViewBlock): void;
  onSet(patch: Partial<ViewBlock>): void;
  onRemove(): void;
  onError(message: string): void;
  onOpenChange(open: boolean): void;
}) {
  const collection = useCollection(block.collectionId ?? page.collection.id);
  if (!collection) {
    return (
      <InlineNotification kind="warning" title="Block without collection" subtitle="The collection this block listed was deleted." onClose={onRemove} />
    );
  }
  return (
    <ItemPageBlockContent
      key={collection.id}
      collection={collection}
      block={block}
      page={page}
      collapsed={collapsed}
      onCollapse={onCollapse}
      onChange={onChange}
      onSet={onSet}
      onRemove={onRemove}
      onError={onError}
      onOpenChange={onOpenChange}
    />
  );
}

function ItemPageBlockContent({
  collection,
  block,
  ...rest
}: Parameters<typeof ItemPageBlock>[0] & { collection: Collection }) {
  // Its items, shared with every pane showing that collection.
  const data = useCollectionData(collection);
  const normalized = useMemo(() => normalizeBlock(collection, block), [collection, block]);
  return <BlockView collection={collection} data={data} block={normalized} viewFilters={null} search="" place="item" {...rest} />;
}

/**
 * The page layout popover: the shown item view's name, and its layout: whether fields are
 * editable and show their names, and which fields and blocks in which order. Layout changes stay
 * unsaved until saved from the tab bar; a rename is saved right away (like a collection page's views).
 */
function ItemLayoutSettings({
  collection,
  renameRequest,
  view,
  layout,
  titleFieldId,
  onChange,
  onAddBlock,
  onError,
}: {
  collection: Collection;
  /** Changes after "+": the new view's name gets focus, selected, to rename it. */
  renameRequest: number;
  /** The shown item view; null when the collection has none yet. */
  view: ItemView | null;
  /** The shown layout, with unsaved changes. */
  layout: ItemLayout;
  /** The field shown as the page title: left out unless chosen. */
  titleFieldId: string | undefined;
  onChange(patch: Partial<ItemLayout>): void;
  /** A new block: stored right away (not a layout change to save). */
  onAddBlock(block: ViewBlock): void;
  onError(e: unknown): void;
}) {
  const { repo, collections } = useStore();
  const blockName = useBlockName();
  const uid = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  /**
   * "Add block": a table of the items linked to this one (of the first collection with a
   * reference to this one), else of this collection; at the end of the page.
   */
  const addBlock = () => {
    const linked = collections.find((c) => c.id !== collection.id && c.fields.some((f) => (f.kind === "item" || f.kind === "item_list") && f.targetCollectionId === collection.id));
    onAddBlock(newPageBlock(linked ?? collection, collection));
  };
  const blockLabel = (b: ViewBlock) => {
    const Icon = blockType(b.kind).icon;
    const name = blockName(b);
    return (
      <span className="view-kind">
        <Icon />
        {name}
      </span>
    );
  };
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
      repo.saveItemViews(collection.id, collection.itemViews.map((v) => (v.id === view.id ? { ...v, name } : v))).catch(onError);
    }
  };

  return (
    <div className="item-layout">
      {view && (
        <TextInput
          size="sm"
          key={view.id + view.name}
          id={`${uid}-item-layout-name`}
          ref={nameInput}
          labelText="View name"
          defaultValue={view.name}
          onBlur={(e) => rename(e.target.value.trim())}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      )}
      <Checkbox id={`${uid}-item-layout-editable`} labelText="Fields are editable" checked={layout.editable} onChange={(_, { checked }) => onChange({ editable: checked })} />
      <Checkbox id={`${uid}-item-layout-hide-empty`} labelText="Hide empty fields" checked={layout.hideEmpty} onChange={(_, { checked }) => onChange({ hideEmpty: checked })} />
      <FieldOrderEditor
        id={`${uid}-item-layout-fields`}
        label="Fields"
        fields={pickableFields(collection)}
        collection={collection}
        value={layout.fields}
        onChange={(fields) => onChange({ fields })}
        hiddenByDefault={titleFieldId ? [titleFieldId] : []}
        hiddenLabels={layout.hiddenLabels}
        onHiddenLabelsChange={(hiddenLabels) => onChange({ hiddenLabels })}
        extra={layout.blocks.map((b) => ({ id: b.id, label: blockLabel(b) }))}
      />
      <Button kind="tertiary" size="sm" renderIcon={Add} className="item-layout__add" onClick={addBlock}>
        Add block
      </Button>
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
  const { components } = useStore();
  const uid = useId();
  if (field.kind === "component") {
    // Computed from the other fields: read-only, laid out like any field, shown by its
    // component's output type (Markdown, text, number, image, HTML in the same width).
    const text = value == null ? "" : String(value);
    // Clicking it edits its component (shared by every item showing it; saving asks first).
    const component = components.find((t) => t.id === field.componentId);
    const editable = !readOnly && !!component;
    const edit = (e: MouseEvent | KeyboardEvent) => {
      // Links in the result keep working.
      if ((e.target as HTMLElement).closest("a")) return;
      onEdit();
    };
    return (
      <div className="view-field">
        <div className="cds--label">
          <FieldLabel field={field} />
        </div>
        <div
          className={`view-field__value view-field__value--component${editable ? " view-field__editable" : ""}${text.startsWith(ERROR_PREFIX) ? " view-field__value--error" : ""}${text ? "" : " view-field__value--empty"}`}
          title={editable ? `Rendered from the component “${component.name}”: click to edit it` : "Rendered from a component"}
          {...(editable && {
            role: "button",
            tabIndex: 0,
            "aria-label": `Edit component ${component.name}`,
            onClick: edit,
            onKeyDown: (e: KeyboardEvent) => {
              if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                edit(e);
              }
            },
          })}
        >
          <ComponentValue
            value={value}
            output={outputOf(field, components)}
            frameRatio={component?.frameRatio}
            variant="page"
            onContentClick={editable ? () => onEdit() : undefined}
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
    // Links inside the value (item references, markdown links) and task checkboxes keep working.
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
  if (field.kind === "checklist" || field.kind === "string_list" || field.kind === "item_list") {
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
            // HTML: a click on its plain content edits it (the frame reports it; links and controls in it keep working).
            <PropertyValue field={field} value={value} refs={refs} onFrameClick={readOnly ? undefined : () => onEdit()} />
          ))}
      </div>
    </div>
  );
}
