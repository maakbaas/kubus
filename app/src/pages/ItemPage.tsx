import { isEmptyValue as isEmpty, type FilterRule } from "../domain/query";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { Checkbox, Dropdown, Heading, IconButton, InlineNotification, Stack, Tab, TabList, Tabs, TextInput } from "@carbon/react";
import { Add, Checkmark, Code, Edit, Filter, Information, Pin, PinFilled, Renew, SettingsAdjust, Star, StarFilled, TrashCan, Undo, Save } from "@carbon/icons-react";
import { isFullWidth, NOTHING_COLLAPSED, pageFilterScope, pageFiltersFor, withBlockCollapsed, type Collapsed, type ViewBlock } from "../domain/views";
import { blockType, normalizeBlock, type PageItem } from "../views";
import { BlockView, newPageBlock } from "../views/BlockView";
import { BlockRows, draggedEntry, dragStart, isEntryDrag, rowCollapse, rowControls, shownRows, zoneAt, type RowControls } from "../views/BlockRows";
import { placeBlock, reordered, setRowShares, withoutBlock, type RowZone } from "../domain/blockRows";
import { QueryEditor } from "../views/QueryEditor";
import { useBlockName } from "../views/BlockListEditor";
import { AddBlockButton, type NewBlockSpec } from "../views/AddBlockButton";
import { useCollectionData, type CollectionData } from "../views/useCollectionData";
import { useBacklinkData } from "../views/useBacklinks";
import { findCollection } from "../domain/backlinks";
import { useStore, useCollection } from "../app/store";
import { useAiFill } from "../app/useAi";
import { useDataChanges } from "../app/useDataChanges";
import { aiRequest } from "../domain/ai";
import { AiRegenerate } from "../ui/AiRegenerate";
import { AiStatus } from "../ui/AiStatus";
import { formatDate, formatTime } from "../domain/fieldKinds";
import {
  itemLabel,
  editedTitleField,
  newName,
  fieldValue,
  isMetaField,
  isReferenceKind,
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
import { ERROR_PREFIX, fieldComponent, outputOf, withComputed } from "../domain/components";
import { HtmlFrame, ComponentValue, FramesSizing } from "../ui/ComponentValue";
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
import { collectionsCrumb, PageHeader } from "../ui/PageHeader";
import { OverflowBar } from "../ui/OverflowBar";
import { FieldCollapse, SectionHeader } from "../ui/SectionHeader";
import { TabMenu, useClippedTabs } from "../ui/TabMenu";
import { findBlock, useLinkTarget } from "../ui/useLinkTarget";
import { ToolbarPopover, usePanelsOpen } from "../ui/ToolbarPopover";
import { errorMessage, useConfirm } from "../ui/useConfirm";
import { useShownOnce } from "../ui/useShownOnce";
import { refLabelOf, useReferenceOptions, type RefOptions } from "../ui/useReferenceOptions";
import { isRemote, rowItem, rowKey, sourceShape } from "../domain/sources";

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
      return <Highlight text={String(value)} query="" links />;
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
    case "ai":
      return value == null ? null : field.output === "markdown" ? <MarkdownView source={String(value)} /> : <Highlight text={String(value)} query="" links />;
    case "checkbox":
    case "string_list":
    case "checklist":
      return null; // laid out by ViewField
  }
}

function ItemContent({ collection, itemId }: { collection: Collection; itemId: string }) {
  const { repo, components, collections, cache, spaces, ai, sources } = useStore();
  // A remote collection's item is a row of its source, read by its key; it is only shown.
  const remote = isRemote(collection);
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();
  const refs = useReferenceOptions(collection);
  // undefined = loading, null = not found. Opened from a list, the item is in memory already:
  // shown at once (and read again below, as always).
  const [item, setItem] = useState<Item | null | undefined>(() =>
    remote ? sources.shownItem(collection.id, itemId) : cache.items.snapshot(collection.id).items?.find((o) => o.id === itemId),
  );
  /** The field being edited, and where its value was clicked (markdown starts editing there). */
  const [editing, setEditing] = useState<{ fieldId: string; start?: EditStart } | null>(null);
  const [error, setError] = useState<string>();
  // A table row's edit icon opens the page standard (?edit=1).
  const [params] = useSearchParams();
  const [standard, setStandard] = useState(params.get("edit") === "1");
  /** The chosen tab: "item" (this item's own layout) or an item view's id; null = the default. */
  const [tab, setTab] = useState<string | null>(params.get("view"));
  // Another link to this page while it is open (?view=): shows that item view.
  const linkedView = params.get("view");
  useEffect(() => {
    if (!linkedView) return;
    setTab(linkedView);
    setDraft(null);
    setStandard(false);
  }, [linkedView]);
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
  const [local, setLocal] = useState<Record<string, { collapsed?: Collapsed; layout?: ItemLayout; fullWidth?: boolean }>>({});
  useEffect(() => setLocal({}), [collection.itemViews]);

  const latest = useRef(collection);
  latest.current = collection;
  // A remote row is read again only when what it is read as changes (its source, columns, fields), not
  // whenever any collection changes (each is a new object then).
  const readAs = collection.source
    ? JSON.stringify([collection.source.name, sourceShape(collection), collection.fields.map((f) => [f.id, f.column ?? null])])
    : collection;
  /** Reads the item (a remote one's row) again. */
  const load = useCallback((): Promise<Item | null> => {
    const collection = latest.current;
    if (!collection.source) return repo.getItem(collection, itemId);
    const key = rowKey(itemId);
    if (key === null) return Promise.resolve(null);
    const shape = sourceShape(collection);
    return sources.row(collection.source.name, { ...shape, keyValue: key }).then((row) => row && rowItem(collection, shape, row));
  }, [repo, sources, readAs, itemId]); // eslint-disable-line react-hooks/exhaustive-deps
  // The latest read only: a late answer to an earlier one doesn't overwrite it.
  const reads = useRef(0);
  const read = useCallback(() => {
    const n = ++reads.current;
    load().then(
      (found) => reads.current === n && setItem(found),
      (e) => reads.current === n && setError(errorMessage(e)),
    );
  }, [load]);
  useEffect(read, [read]);
  // "Read again" on the collection's page reads this row again too.
  useEffect(() => (remote ? sources.onRefresh((id) => (id === null || id === collection.id) && read()) : undefined), [remote, sources, collection.id, read]);
  // Component fields show their computed results.
  const shown = useMemo(
    () => (item ? withComputed(collection, [item], components, refLabelOf(refs))[0] : null),
    [collection, item, components, refs],
  );
  /** The page's item, for its blocks (filter values "this item"). */
  const page = useMemo<PageItem | null>(() => (shown ? { collection, item: shown, refLabel: refLabelOf(refs) } : null), [collection, shown, refs]);
  // AI values that have gone stale (another prompt, or an edit it reads) are generated, once what
  // the prompts read (referenced items' labels) is in.
  const refLabel = useMemo(() => refLabelOf(refs), [refs]);
  const shownItems = useMemo(() => (shown ? [shown] : null), [shown]);
  const refsLoaded = !collection.fields.some((f) => isReferenceKind(f.kind) && f.targetCollectionId && !refs[f.targetCollectionId]);
  useAiFill(collection, shownItems, refLabel, refsLoaded);
  const regenerate = (f: FieldDef, hint: string) => {
    if (!shown) return;
    const request = aiRequest(collection, f, shown, refLabel, components);
    if ("problem" in request) setError(request.problem);
    else ai.regenerate({ collection, field: f, itemId: shown.id, request, hint: hint || undefined });
  };
  // Edits elsewhere (a table cell in another pane, a checkbox) refresh this item.
  // While this page saves a field it reads the item itself afterwards: the change that save
  // announces needn't fetch it a second time. A count: two saves can overlap (a field saved by the
  // press on a checkbox, the checkbox saved by its click), and the first to end mustn't let the
  // second's change through as if it came from elsewhere.
  const saving = useRef(0);
  useDataChanges((change) => {
    if (!remote && change.scope === "items" && change.itemId === itemId && saving.current === 0) {
      repo.getItem(collection, itemId).then(setItem, (e) => setError(errorMessage(e)));
    }
  });

  const listPath = `/collections/${collection.id}/items`;
  // A link to a field or block of the page (?field=, ?block=): scrolled to and highlighted. Fields
  // are the children of the list, in the order of its rows (see `entries` below; a row of blocks is one child).
  const fieldList = useRef<HTMLDivElement>(null);
  const fieldIndex = useRef<string[]>([]);
  const linkedField = params.get("field");
  const linkedBlock = params.get("block");
  useLinkTarget(
    linkedField ?? linkedBlock,
    (id) => (linkedBlock ? findBlock(id) : fieldList.current?.children[fieldIndex.current.indexOf(id)]),
    item != null,
  );
  const viewsBar = useRef<HTMLDivElement>(null);
  const clippedTabs = useClippedTabs(viewsBar);
  // The same error as the page's blocks (the server can't be reached) shows once.
  const showError = useShownOnce(error);
  // Nothing until it is in (a fraction of a second): a spinner would only flash.
  if (item === undefined && !error) return null;
  if (item === null) return <NotFound />;

  // The title as shown ("Untitled …" when empty); editing it edits the field's value.
  const title = shown ? itemLabel(collection, shown) : "";
  // The field shown as the page title is edited there, not repeated among the fields.
  // A number or date title is edited among the fields (editedTitleField).
  const titleField = shown ? editedTitleField(collection, shown) : undefined;
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
  // The standard page keeps the blocks: they aren't fields. A remote item is never editable.
  const shownLayout = standard ? { ...FULL_LAYOUT, blocks: current.blocks, filters: current.filters } : current;
  const layout = remote ? { ...shownLayout, editable: false } : shownLayout;
  /** A change to what a block shows (filter, sort, grouping, fields): unsaved until Save changes, as on collection pages. */
  const setBlock = (block: ViewBlock) => setDraft({ ...current, blocks: current.blocks.map((b) => (b.id === block.id ? block : b)) });
  // With more than one block listing items the page gets a filter for all of them (on top of their own).
  const listing = layout.blocks.filter((b) => blockType(b.kind).uses(b.options, components).query);
  const pageScope = [...new Set(listing.map((b) => b.collectionId ?? collection.id))]
    .map((id) => findCollection(collections, id))
    .filter((c): c is Collection => !!c);
  const pageFilters = listing.length > 1 ? layout.filters : [];
  const showTab = (id: string | null) => {
    setTab(id);
    setDraft(null);
    setStandard(false);
  };
  const saveViews = (views: ItemView[]) => repo.saveItemViews(collection.id, views).catch((e) => setError(errorMessage(e)));
  const collapsed = activeView ? (local[activeView.id]?.collapsed ?? activeView.collapsed) : NOTHING_COLLAPSED;
  /** The shown view's "Full width" as stored (absent: off). */
  const storedFullWidth = activeView ? (local[activeView.id]?.fullWidth ?? activeView.fullWidth) : undefined;
  // The page's width follows it as it is clicked (the panel open: the page is seen changing).
  const fullWidth = isFullWidth("item", storedFullWidth);
  /** Stores the shown item view with these (the virtual "Default" view is stored then), shown at once. */
  const storeNow = (patch: { collapsed?: Collapsed; layout?: ItemLayout; fullWidth?: boolean }) => {
    if (!activeView) return;
    setLocal((m) => ({ ...m, [activeView.id]: { ...m[activeView.id], ...patch } }));
    saveViews(itemViews.map((v) => (v.id === activeView.id ? { ...v, layout: saved, collapsed, ...(storedFullWidth !== undefined && { fullWidth: storedFullWidth }), ...patch } : v)));
  };
  /** Collapsing or expanding a block or a group: stored right away. */
  const setCollapsed = (next: Collapsed) => storeNow({ collapsed: next });
  /**
   * Arranging the page is stored right away, in the shown and the saved layout alike, so it is no
   * change to save: the page layout (fields and blocks and their order, names shown, editable, hide
   * empty) and its blocks (adding, removing; a block's type, options, name, collection). Only what
   * changes which items a block shows (filter, sort, grouping, fields) waits for Save changes, as on
   * collection pages.
   */
  const arrange = (change: (layout: ItemLayout) => ItemLayout, placed = false) => {
    // A block no longer right under the one it was beside (the Fields list reordered) leaves its row; one placed by a drop
    // is where the drop put it.
    const applied = (l: ItemLayout) => {
      const next = change(l);
      return placed ? next : { ...next, blocks: reordered(orderOf(l), orderOf(next), next.blocks) };
    };
    if (draft) setDraft(applied(draft));
    storeNow({ layout: applied(saved) });
  };
  const setBlockNow = (id: string, patch: Partial<ViewBlock>) =>
    arrange((l) => ({ ...l, blocks: l.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)) }));
  const addBlock = (block: ViewBlock) => arrange((l) => ({ ...l, blocks: [...l.blocks, block], fields: l.fields && [...l.fields, block.id] }));
  async function removeBlock(block: ViewBlock) {
    if (!(await confirm({ title: `Remove block “${blockName(block)}”?`, body: "Items are not affected." }))) return;
    arrange((l) => ({ ...l, blocks: withoutBlock(orderOf(l), l.blocks, block.id), fields: l.fields && l.fields.filter((f) => f !== block.id) }));
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
  // Blocks side by side (rows: views/BlockRows.tsx): blocks next to each other on the page.
  fieldIndex.current = shownRows(entries, (e) => blocksById.get(e.id)).map((r) => r[0].id);
  /** The page's order of fields and blocks, empty ones too (what "Beside the block above" looks at). */
  const orderOf = (l: ItemLayout) => itemPageFields<{ id: string }>([...pickableFields(collection), ...l.blocks], l, titleField?.id).map((e) => e.id);
  /**
   * A field or block dropped on another (dragged by its name), as blocks are on other pages: the layout lists its fields
   * and blocks in the order shown from then on ("all fields" becomes that list).
   */
  const placeOnPage = (dragId: string, targetId: string, zone: RowZone) =>
    arrange((l) => {
      const r = placeBlock(orderOf(l), l.blocks, dragId, targetId, zone);
      if (r.blocks === l.blocks) return l;
      const at = (id: string) => r.order.indexOf(id);
      return { ...l, blocks: [...r.blocks].sort((a, b) => at(a.id) - at(b.id)), fields: r.order };
    }, true);
  const canPlace = !!activeView && !standard;
  // A field (not a row of blocks: its cells take their own drops) under a drag: above or below it, marked like a drop zone.
  const dropTarget = (e: React.DragEvent): { el: HTMLElement; id: string } | null => {
    const list = fieldList.current;
    const child = list && [...list.children].find((c) => c.contains(e.target as Node));
    if (!child || child.classList.contains("block-row")) return null;
    const id = fieldIndex.current[[...list.children].indexOf(child)];
    // A field shown without its name is a wrapper without a box (display: contents): its field is.
    const el = (child.classList.contains("item-field--no-label") ? child.firstElementChild : child) as HTMLElement | null;
    return el && id ? { el, id } : null;
  };
  const clearDrop = () => fieldList.current?.querySelectorAll("[data-drop]").forEach((el) => el.removeAttribute("data-drop"));
  const fieldDrops = canPlace
    ? {
        onDragOver: (e: React.DragEvent) => {
          const target = isEntryDrag(e) && dropTarget(e);
          if (!target) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const zone = zoneAt(e, target.el);
          if (target.el.dataset.drop !== zone) {
            clearDrop();
            target.el.dataset.drop = zone;
          }
        },
        onDragLeave: (e: React.DragEvent) => !e.currentTarget.contains(e.relatedTarget as Node) && clearDrop(),
        onDrop: (e: React.DragEvent) => {
          const target = isEntryDrag(e) && dropTarget(e);
          clearDrop();
          if (!target) return;
          e.preventDefault();
          const dragId = draggedEntry(e);
          if (dragId) placeOnPage(dragId, target.id, zoneAt(e, target.el));
        },
        onDragEnd: clearDrop,
      }
    : {};
  const blockRowControls = (block: ViewBlock): RowControls =>
    rowControls(orderOf(layout), layout.blocks, block, (change) => arrange((l) => ({ ...l, blocks: change(l.blocks, orderOf(l)) })));
  const restricted = !!item && isRestricted(collection, item, remote ? { ...shownLayout, editable: true } : layout);

  async function saveField(field: FieldDef, value: FieldValue) {
    if (!item) return;
    saving.current++;
    try {
      await repo.updateItem(collection, item.id, { [field.id]: value });
      setItem(await repo.getItem(collection, item.id));
    } finally {
      saving.current--;
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
    // "Full width" (Page layout) on: the page at the pane's width, as a collection view; else the narrow column.
    <div className={fullWidth ? "form-page item-view item-view--full" : "form-page item-view"}>
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
            <Heading className="page-header__title">
              <Highlight text={title} query="" />
            </Heading>
          )
        }
        current={title}
        breadcrumbs={[
          collectionsCrumb(collection),
          { label: collection.pluralName, href: `#${listPath}` },
        ]}
        actions={
          item && (
            <OverflowBar>
              {/* Held while a panel is open: the button appearing (a layout change made in the panel) would move the header. */}
              {panels.hold("standard-switch", restricted || standard) && (
                <IconButton
                  autoAlign
                  size="sm"
                  kind="ghost"
                  align="bottom"
                  label={standard ? "Back to this page's layout" : remote ? "Show all fields" : "Show all fields, editable"}
                  aria-pressed={standard}
                  onClick={() => setStandard((s) => !s)}
                >
                  {standard ? <Checkmark /> : <Edit />}
                </IconButton>
              )}
              <BookmarkButton kind="item" ownerId={collection.id} targetId={item.id} label={title} onError={(e) => setError(errorMessage(e))} />
              {/* Metadata lives in a popover; more facts about the item can be added to its list. */}
              <ToolbarPopover label="Details" icon={Information} fit onOpenChange={panels.onOpenChange}>
                <dl className="item-info">
                  <dt>Collection</dt>
                  <dd>
                    <span className="icon-label">
                      <CollectionIcon name={collection.icon} />
                      <span className="icon-label__text">{collection.name}</span>
                    </span>
                  </dd>
                  {/* Moving it to another space takes it out of this space's lists (the page stays open). */}
                  {remote && (
                    <>
                      <dt>Read from</dt>
                      <dd>{collection.source!.name}</dd>
                    </>
                  )}
                  {!remote && spaces.length > 1 && (
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
                  {!remote && (
                    <>
                      <dt>Created</dt>
                      <dd>{formatDateTime(item.createdAt)}</dd>
                      <dt>Updated</dt>
                      <dd>{formatDateTime(item.updatedAt)}</dd>
                    </>
                  )}
                </dl>
              </ToolbarPopover>
              {/* Subtle: a ghost icon button; the confirmation dialog carries the danger styling. */}
              {!remote && (
                <IconButton autoAlign size="sm" kind="ghost" align="bottom" label={`Delete ${collection.name}`} onClick={remove}>
                  <TrashCan />
                </IconButton>
              )}
              {/* Held while a panel is open: adding a block in the layout panel mustn't move its button. */}
              {panels.hold("pageFilter", listing.length > 1 && pageScope.length > 0) && pageScope.length > 0 && (
                <PageFilter scope={pageScope} filters={layout.filters} onChange={(filters) => setDraft({ ...current, filters })} onOpenChange={panels.onOpenChange} />
              )}
              {/* The page's layout last. */}
              <ToolbarPopover label="Page layout" icon={SettingsAdjust} fit openRequest={renameRequest} onOpenChange={panels.onOpenChange}>
                <ItemLayoutSettings
                  collection={collection}
                  renameRequest={renameRequest}
                  view={activeView}
                  layout={current}
                  titleFieldId={titleField?.id}
                  fullWidth={isFullWidth("item", storedFullWidth)}
                  onFullWidth={(on) => storeNow({ fullWidth: on })}
                  onChange={(patch) => arrange((l) => ({ ...l, ...patch }))}
                  onAddBlock={addBlock}
                  onError={(e) => setError(errorMessage(e))}
                />
              </ToolbarPopover>
            </OverflowBar>
          )
        }
      />
      {showError && <InlineNotification kind="error" title="Error" subtitle={error} onClose={() => setError(undefined)} />}

      {/* Once the collection has item views: one tab each, like the views of the collection page. The
          star makes the shown one the default for all items, the pin this item's own choice.
          Changes to what a block shows stay unsaved until saved with the icon buttons beside the tabs. */}
      {/* Always shown, also for a single view: its name, "+" and saving stay in one place. */}
      {item && (
        <div className="views-bar" ref={viewsBar}>
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
          {clippedTabs && (
            <TabMenu
              label="Page layouts"
              items={itemViews.map((v) => ({ id: v.id, name: v.name + (changed && v.id === activeView?.id ? " *" : "") }))}
              activeId={activeView?.id}
              onSelect={showTab}
            />
          )}
          {/* "+" takes the menu arrow's place; with the arrow it joins the icons at the right edge. */}
          {!clippedTabs && <span className="tab-menu">{addButton}</span>}
          <span className="views-bar__spacer" />
          {/* Always in the bar, left of the other buttons (never in the "⋮" menu), as on collection
              pages; held while a panel is open, so they appear once the panel closes. */}
          {panels.hold("changed", changed) && (
            <IconButton autoAlign kind="ghost" size="sm" align="bottom" label="Discard changes" onClick={() => setDraft(null)}>
              <Undo />
            </IconButton>
          )}
          {panels.hold("changed", changed) && activeView && (
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
          )}
          <OverflowBar>
          {clippedTabs && addButton}
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
              {/* A remote item has nothing stored to pin a view to. */}
              {!remote && <IconButton
                autoAlign
                kind="ghost"
                size="sm"
                align="bottom"
                label={pinned ? `Unpin from this ${collection.name}` : `Always show this ${collection.name} with this view`}
                aria-pressed={pinned}
                onClick={() => togglePin(activeView)}
              >
                {pinned ? <PinFilled /> : <Pin />}
              </IconButton>}
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
          </OverflowBar>
        </div>
      )}

      {/* Hidden (in place) until its HTML frames know their height, so nothing below one jumps. */}
      {item && (
        <FramesSizing>
        <Stack ref={fieldList} gap={7} className="item-fields" {...fieldDrops}>
          <BlockRows
            entries={entries}
            blockOf={(e) => blocksById.get(e.id)}
            onPlace={canPlace ? placeOnPage : undefined}
            onShares={(row, shares) => arrange((l) => ({ ...l, blocks: setRowShares(l.blocks, row, shares) }))}
            render={(entry, placed) => {
              const block = blocksById.get(entry.id);
              if (block) {
                return page && (
                  <ItemPageBlock
                    key={block.id}
                    block={block}
                    page={page}
                    pageFilters={pageFilters}
                    editable={layout.editable}
                    headerHidden={layout.hiddenLabels.includes(block.id)}
                    collapsed={collapsed}
                    onCollapse={setCollapsed}
                    onChange={setBlock}
                    onSet={(patch) => setBlockNow(block.id, patch)}
                    onRemove={() => removeBlock(block)}
                    onError={setError}
                    onOpenChange={panels.onOpenChange}
                    row={activeView ? blockRowControls(block) : undefined}
                    onDragStart={placed.onDragStart}
                    // A row collapses as one (views/BlockRows.tsx rowCollapse).
                    collapse={rowCollapse(orderOf(layout), layout.blocks, collapsed, block, setCollapsed)}
                  />
                );
              }
              const f = entry as FieldDef;
              // Its own component (written in its settings), or the shared one it picks.
              const component = f.kind === "component" ? fieldComponent(f, components) : undefined;
              const shared = component && f.code === null ? components.find((t) => t.id === f.componentId) : undefined;
              const labelHidden = layout.hiddenLabels.includes(f.id);
              // An AI field's "Generate again", in its label row (none without its name), also while collapsed or edited.
              const regenerateButton = f.kind === "ai" && (
                <RegenerateButton generatedAt={item.aiGeneratedAt?.[f.id]} edited={!!item.aiEdited?.[f.id]} onRegenerate={(hint) => regenerate(f, hint)} />
              );
              // A component field's "Edit component", in its label row: its value is computed, so a click
              // on it edits nothing; a shared component changes everywhere, so editing it is asked for explicitly.
              const editComponentButton = component && layout.editable && <EditComponentButton name={shared?.name} onEdit={() => setEditing({ fieldId: f.id })} />;
              const editor = editing?.fieldId === f.id && (
                <FieldEditor
                  key={f.id}
                  field={f}
                  value={item.values[f.id] ?? null}
                  refs={refs}
                  start={editing.start}
                  onSave={(v) => saveField(f, v)}
                  onCancel={() => setEditing(null)}
                />
              );
              const field =
              editing?.fieldId === f.id && component ? (
                // A component field edits its component (shared: saving asks first).
                <ComponentFieldEditor key={f.id} collection={collection} field={f} component={component} shared={shared} onDone={() => setEditing(null)} />
              ) : editor && regenerateButton && !labelHidden ? (
                // Its buttons stay where they were while it is edited: over the input's label row.
                <div key={f.id} className="view-field">
                  {editor}
                  <SectionHeader label={null} overlay>
                    {regenerateButton}
                  </SectionHeader>
                </div>
              ) : editor ? (
                editor
              ) : (
                <ViewField
                  key={f.id}
                  field={f}
                  value={shown ? fieldValue(shown, f) : null}
                  refs={refs}
                  onEdit={(start) => setEditing({ fieldId: f.id, start })}
                  onSave={(v) => saveField(f, v).catch((e) => setError(errorMessage(e)))}
                  onRegenerate={f.kind === "ai" ? (hint) => regenerate(f, hint) : undefined}
                  componentButton={editComponentButton || undefined}
                  generatedAt={f.kind === "ai" ? item.aiGeneratedAt?.[f.id] : undefined}
                  edited={f.kind === "ai" ? !!item.aiEdited?.[f.id] : undefined}
                  itemId={item.id}
                  labelHidden={labelHidden}
                  readOnly={!layout.editable || isMetaField(f)}
                  fixed={remote}
                />
              );
              // A field shown without its name (the layout's choice); the wrapper adds no box. Without
              // a label it has no caret, so it can't collapse.
              if (labelHidden) {
                return (
                  <div key={f.id} className="item-field--no-label">
                    {field}
                  </div>
                );
              }
              if (!activeView) return field;
              // Collapsible like a block (the caret is in its label), stored with the item view right away.
              const fieldCollapsed = collapsed.blocks.includes(f.id);
              const toggle = () => {
                if (editing?.fieldId === f.id) setEditing(null);
                setCollapsed(withBlockCollapsed(collapsed, f.id, !fieldCollapsed));
              };
              return (
                <FieldCollapse.Provider key={f.id} value={{ collapsed: fieldCollapsed, onToggle: toggle, ...(canPlace && { onDragStart: dragStart(f.id, "field") }) }}>
                  {fieldCollapsed ? (
                    // Only the label row, its buttons kept (like a collapsed block's menus).
                    <div className="view-field">
                      <SectionHeader label={<FieldLabel field={f} />}>{regenerateButton || editComponentButton}</SectionHeader>
                    </div>
                  ) : (
                    field
                  )}
                </FieldCollapse.Provider>
              );
            }}
          />
        </Stack>
        </FramesSizing>
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
 * `value` is what shows (an empty title reads "Untitled …"), `source` what is edited.
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
    const text = el.firstChild!; // the source is never empty (editedTitleField needs a value)
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
        <Highlight text={value} query="" />
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
 * collection view's block; changes to what it shows are unsaved until saved from the tab bar, the
 * rest is stored right away (see `arrange`).
 */
function ItemPageBlock({
  block,
  page,
  pageFilters,
  editable,
  headerHidden,
  collapsed,
  onCollapse,
  onChange,
  onSet,
  onRemove,
  onError,
  onOpenChange,
  row,
  onDragStart,
  collapse,
}: {
  block: ViewBlock;
  page: PageItem;
  /** The page-wide filter (each collection takes its own fields' rules). */
  pageFilters: FilterRule[];
  editable: boolean;
  headerHidden: boolean;
  collapsed: Collapsed;
  onCollapse(collapsed: Collapsed): void;
  onChange(block: ViewBlock): void;
  onSet(patch: Partial<ViewBlock>): void;
  onRemove(): void;
  onError(message: string): void;
  onOpenChange(open: boolean): void;
  /** Its place in a row (Block settings). */
  row?: RowControls;
  /** Its name drags it to another place on the page. */
  onDragStart?(e: React.DragEvent): void;
  /** Its row's collapse (a row collapses as one). */
  collapse?: { collapsed: boolean; onToggle(): void };
}) {
  const { collections } = useStore();
  const collection = findCollection(collections, block.collectionId ?? page.collection.id);
  if (!collection) {
    return (
      <section className="block" data-block-id={block.id}>
        <InlineNotification kind="warning" title="Block without collection" subtitle="The collection this block listed was deleted." onClose={onRemove} />
      </section>
    );
  }
  const Content = collection.virtual === "backlinks" ? BacklinksBlockContent : ItemPageBlockContent;
  return (
    <Content
      key={collection.id}
      collection={collection}
      block={block}
      page={page}
      pageFilters={pageFilters}
      editable={editable}
      headerHidden={headerHidden}
      collapsed={collapsed}
      onCollapse={onCollapse}
      onChange={onChange}
      onSet={onSet}
      onRemove={onRemove}
      onError={onError}
      onOpenChange={onOpenChange}
      row={row}
      onDragStart={onDragStart}
      collapse={collapse}
    />
  );
}

type ContentProps = Parameters<typeof ItemPageBlock>[0] & { collection: Collection };

function ItemPageBlockContent(props: ContentProps) {
  // Its items, shared with every pane showing that collection.
  const data = useCollectionData(props.collection);
  return <PageBlockView {...props} data={data} />;
}

/** A block of the Backlinks collection: the items linking to the page's item (not in the shared item cache: they depend on the page's item). */
function BacklinksBlockContent(props: ContentProps) {
  const data = useBacklinkData(props.page);
  return <PageBlockView {...props} data={data} />;
}

/** The block with its collection's data: normalized for it, under the page-wide filter's rules for its fields. */
function PageBlockView({ collection, block, pageFilters, ...rest }: ContentProps & { data: CollectionData }) {
  const normalized = useMemo(() => normalizeBlock(collection, block), [collection, block]);
  const applying = useMemo(() => pageFiltersFor(collection, pageFilters), [collection, pageFilters]);
  return <BlockView collection={collection} block={normalized} viewFilters={applying} search="" place="item" {...rest} />;
}

/**
 * The page-wide filter of an item page with several blocks listing items: the same panel as a
 * collection view's filter (QueryEditor), over the fields of all their collections, remote ones too
 * (their sources filter by it). A rule narrows the blocks whose collection has its field; the rest
 * are left alone.
 */
function PageFilter({ scope, filters, onChange, onOpenChange }: { scope: Collection[]; filters: FilterRule[]; onChange(filters: FilterRule[]): void; onOpenChange(open: boolean): void }) {
  const merged = pageFilterScope(scope);
  const refs = useReferenceOptions(merged);
  return (
    <ToolbarPopover label={filters.length > 0 ? `Filter all blocks (${filters.length})` : "Filter all blocks"} icon={Filter} width="wide" active={filters.length > 0} onOpenChange={onOpenChange}>
      <QueryEditor
        collection={merged}
        query={{ filters, sort: [], groupBy: null }}
        refs={refs}
        part="filter"
        title="Filter all blocks"
        emptyText="No filter: every block shows what its own filter lets through."
        owners={scope}
        onChange={(q) => onChange(q.filters)}
      />
    </ToolbarPopover>
  );
}

/**
 * The page layout popover: the shown item view's name, and its layout: whether fields are
 * editable and show their names, and which fields and blocks in which order. All of it is stored
 * right away, like a rename (arranging the page, not changing what its blocks show).
 */
function ItemLayoutSettings({
  collection,
  renameRequest,
  view,
  layout,
  titleFieldId,
  fullWidth,
  onFullWidth,
  onChange,
  onAddBlock,
  onError,
}: {
  collection: Collection;
  /** Changes after "+": the new view's name gets focus, selected, to rename it. */
  renameRequest: number;
  /** The shown item view; null when the collection has none yet. */
  view: ItemView | null;
  /** The shown layout, with unsaved block changes. */
  layout: ItemLayout;
  /** The field shown as the page title: left out unless chosen. */
  titleFieldId: string | undefined;
  /** "Full width": the shown view's, and setting it (stored right away). */
  fullWidth: boolean;
  onFullWidth(on: boolean): void;
  /** A layout change: stored right away. */
  onChange(patch: Partial<ItemLayout>): void;
  /** A new block: stored right away. */
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
  const addBlock = (spec: NewBlockSpec) => {
    const linked = collections.find((c) => c.id !== collection.id && c.fields.some((f) => (f.kind === "item" || f.kind === "item_list") && f.targetCollectionId === collection.id));
    onAddBlock(newPageBlock(linked ?? collection, collection, spec));
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
      <div className="view-options__checks">
        {view && <Checkbox id={`${uid}-item-layout-full-width`} labelText="Full width" checked={fullWidth} onChange={(_, { checked }) => onFullWidth(checked)} />}
        {!isRemote(collection) && (
          <Checkbox id={`${uid}-item-layout-editable`} labelText="Fields are editable" checked={layout.editable} onChange={(_, { checked }) => onChange({ editable: checked })} />
        )}
        <Checkbox id={`${uid}-item-layout-hide-empty`} labelText="Hide empty fields" checked={layout.hideEmpty} onChange={(_, { checked }) => onChange({ hideEmpty: checked })} />
      </div>
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
      <AddBlockButton className="item-layout__add" onAdd={addBlock} />
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
  /** Nothing changes it (a remote item's): a checkbox doesn't toggle either, as it does on a read-only page. */
  fixed?: boolean;
  /** Component fields: the label row's "Edit component" button (their value can't be clicked to edit). */
  componentButton?: ReactNode;
  /** AI fields: generate the value again. */
  onRegenerate?(hint: string): void;
  /** AI fields: when the value was generated, if known. */
  generatedAt?: string;
  /** AI fields: the value was typed by the user. */
  edited?: boolean;
  /** AI fields: the item the value belongs to (what it is waiting for shows by it). */
  itemId?: string;
  /** Shown without its name (the layout's choice): its label row goes with its buttons. */
  labelHidden?: boolean;
}

/** An AI field's "Generate again" button, in its label row (also while the field is collapsed). */
function RegenerateButton({ generatedAt, edited, onRegenerate }: { generatedAt?: string; edited?: boolean; onRegenerate(hint: string): void }) {
  return (
    <ToolbarPopover label="Generate again" icon={Renew} width="narrow">
      {(close) => (
        <AiRegenerate
          generatedAt={generatedAt}
          edited={edited}
          onGenerate={(hint) => {
            close();
            onRegenerate(hint);
          }}
        />
      )}
    </ToolbarPopover>
  );
}

/** A component field's "Edit component" button, in its label row (`name`: its shared component's; none: its own). */
function EditComponentButton({ name, onEdit }: { name?: string; onEdit(): void }) {
  return (
    <IconButton autoAlign kind="ghost" size="sm" align="left" label={name ? `Edit component “${name}” (used everywhere it is shown)` : "Edit this field's component"} onClick={onEdit}>
      <Code />
    </IconButton>
  );
}

/** One field, laid out like its input in the form: label on top, value in a read-only box. Click to edit. (Exported for the help page, which is shown as an item.) */
export function ViewField({ field, value, refs, onEdit, onSave, readOnly, fixed, onRegenerate, componentButton, generatedAt, edited, itemId, labelHidden }: ViewFieldProps) {
  const { components } = useStore();
  const uid = useId();
  if (field.kind === "component") {
    // Computed from the other fields: read-only, laid out like any field, shown by its
    // component's output type (Markdown, text, number, image, HTML in the same width).
    const text = value == null ? "" : String(value);
    // Not clickable: the value is computed, and its component is shared by every item showing it
    // (it is edited from the label row's "Edit component", which asks before saving).
    const component = field.code === null ? components.find((t) => t.id === field.componentId) : undefined;
    return (
      <div className="view-field">
        <SectionHeader label={<FieldLabel field={field} />} hidden={labelHidden}>
          {componentButton}
        </SectionHeader>
        <div
          className={`view-field__value view-field__value--component${text.startsWith(ERROR_PREFIX) ? " view-field__value--error" : ""}${text ? "" : " view-field__value--empty"}`}
          title={component ? `Computed by the component “${component.name}”` : "Computed by its component"}
        >
          <ComponentValue value={value} output={outputOf(field, components)} variant="page" />
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
            <ToggleInput icon={field.toggleIcon} id={boxId} label={field.name} checked={value === true} readOnly={fixed} onChange={onSave} />
          </span>
          <label htmlFor={boxId} className={`checkbox-field__name${value === true ? ` checklist-row__done${field.strikeThrough ? " checklist-row__done--struck" : ""}` : ""}`}>
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

  // Written by the model from the field's prompt, or typed over by the user (then never made again
  // by itself). The button asking for another value sits in the label's row, where a block's menus sit.
  if (field.kind === "ai") {
    return (
      <div className="view-field">
        <SectionHeader label={<FieldLabel field={field} />} hidden={labelHidden}>
          {onRegenerate && <RegenerateButton generatedAt={generatedAt} edited={edited} onRegenerate={onRegenerate} />}
        </SectionHeader>
        <div
          className={`view-field__value view-field__value--component view-field__value--ai${readOnly ? "" : " view-field__editable"}${empty ? " view-field__value--empty" : ""}`}
          {...editable}
          title={readOnly ? "Written by AI from this field's prompt" : "Click to edit. What you type is kept: it is not generated again by itself."}
        >
          <AiStatus itemId={itemId ?? ""} fieldId={field.id}>
            {!empty && (field.output === "markdown" ? <MarkdownView source={String(value)} /> : <Highlight text={String(value)} query="" links />)}
          </AiStatus>
        </div>
      </div>
    );
  }

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
          (field.kind === "markdown" ? (
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
