import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { Heading, IconButton, InlineNotification } from "@carbon/react";
import { Filter, Renew } from "@carbon/icons-react";
import { useStore, useCollection } from "../app/store";
import { useDataChanges } from "../app/useDataChanges";
import { useFreshLoads } from "../app/useFreshLoads";
import { newName, now, newId, type Collection } from "../domain/model";
import { firstShownFields, isReadOnly, isRemote, sourcePeriod } from "../domain/sources";
import { defaultViewState, isFullWidth, newBlock, movedId, NOTHING_COLLAPSED, sameView, type Collapsed, type CollectionView, type ViewBlock, type ViewState } from "../domain/views";
import { NotFound } from "../ui/NotFound";
import { CollectionIcon } from "../ui/collectionIcons";
import { BookmarkButton } from "../ui/BookmarkButton";
import { collectionViewLink } from "../domain/bookmarks";
import { NewButton } from "../ui/NewButton";
import { collectionsCrumb, PageHeader } from "../ui/PageHeader";
import { ViewsBar } from "../ui/ViewsBar";
import { ViewSettingsPanel } from "../ui/ViewSettingsPanel";
import { useViewSearch, ViewSearchBar, ViewSearchButton } from "../ui/ViewSearch";
import { findBlock, useLinkTarget } from "../ui/useLinkTarget";
import { errorMessage, useConfirm } from "../ui/useConfirm";
import { blockType, normalizeBlock, normalizeView } from "../views";
import { BlockListEditor } from "../views/BlockListEditor";
import type { NewBlockSpec } from "../views/AddBlockButton";
import { BlockView } from "../views/BlockView";
import { BlockRows, besideOf, rowCollapse } from "../views/BlockRows";
import { useBlockArrangement } from "../views/useBlockArrangement";
import { withCopy } from "../domain/blockRows";
import { FilterBar } from "../views/FilterBar";
import { QueryEditor } from "../views/QueryEditor";
import { useCollectionData } from "../views/useCollectionData";
import { ListData } from "../views/useListData";
import { isListCollectionId } from "../domain/listEntries";
import { findCollection } from "../domain/backlinks";
import { ToolbarPopover, usePanelsOpen } from "../ui/ToolbarPopover";

export function CollectionPage() {
  const { collectionId } = useParams();
  const collection = useCollection(collectionId);
  if (!collection) return <NotFound />;
  return <CollectionContent key={collection.id} collection={collection} />;
}

/** A view state valid for this collection (stored blocks may be outdated; a block of a list field's entries for those: `collections`). */
const normalized = (collection: Collection, state: ViewState, collections: Collection[]): ViewState =>
  normalizeView(collection, { filters: state.filters, blocks: state.blocks, editable: state.editable }, collections);

/** A view with "Show filter bar" set or taken off (absent when off). */
const withFilterBar = (view: CollectionView, on: boolean): CollectionView => {
  const { filterBar: _old, ...rest } = view;
  return on ? { ...rest, filterBar: true } : rest;
};

/** A view with "Full width" set (stored as set: on or off). */
const withFullWidth = (view: CollectionView, on: boolean): CollectionView => ({ ...view, fullWidth: on });

/** Id of the virtual "All" view of a space that has no stored view of the collection. */
const VIRTUAL_VIEW = "default";


function CollectionContent({ collection }: { collection: Collection }) {
  // Element ids unique per instance: the same page can be open in several tabs.
  const uid = useId();
  const { repo, space, sources, collections } = useStore();
  // What a block of a list field's entries is normalized for (read when a view is, not a reason to load views again).
  const allCollections = useRef(collections);
  allCollections.current = collections;
  const navigate = useNavigate();
  // A remote collection's rows are read from its source, read-only (domain/sources.ts).
  const remote = isRemote(collection);
  const readOnly = isReadOnly(collection);
  const { confirm, dialog } = useConfirm();
  // The collection's items (component fields computed), shared with every other pane showing them
  // and current from the change feed; every block of the view lists them.
  const data = useCollectionData(collection);
  const [savedViews, setSavedViews] = useState<CollectionView[] | null>(null); // null = loading
  const [error, setError] = useState<string>();

  // The view currently shown. Changes are ephemeral until saved as / into a saved view. Every
  // collection starts with an ordinary saved "All" view (in the space it was made in). A space
  // without one (the collection is shared from another space) shows `base` as a virtual "All"
  // view, stored once it is changed, renamed or joined by another view; a collection always has a view.
  const base = useMemo(
    () => normalized(collection, defaultViewState(blockType("table").defaultOptions(collection), firstShownFields(collection), !readOnly, sourcePeriod(collection)), allCollections.current),
    [collection, readOnly],
  );
  const virtualView = useMemo<CollectionView>(
    () => ({ ...base, id: VIRTUAL_VIEW, collectionId: collection.id, spaceId: space.id, name: "All", position: 0, isDefault: false, collapsed: NOTHING_COLLAPSED, createdAt: "", updatedAt: "" }),
    [base, collection.id, space.id],
  );
  const withVirtual = (list: CollectionView[]) => (list.length > 0 ? list : [virtualView]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<ViewState>(base);
  // Its search: the box below the views bar, what the blocks search for once typing pauses (ui/ViewSearch.tsx).
  const viewSearch = useViewSearch();
  /** Set after "+": opens View settings with the new view's name selected, to rename it. */
  const [renameRequest, setRenameRequest] = useState(0);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!renameRequest) return;
    // Once the popover has opened and shows the new view's name.
    const frame = requestAnimationFrame(() => {
      nameInput.current?.focus();
      nameInput.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [renameRequest, activeId]);

  // The latest shown state, so a reload of the views (sync, another pane) can tell whether the
  // shown view has unsaved changes of its own.
  const shown = useRef<{ activeId: string | null; view: ViewState; reference: ViewState } | undefined>(undefined);
  // A reload asked before the latest change shown here (or before a later reload) is dropped: it would undo that change for a moment.
  const fresh = useFreshLoads();
  // `saved`: the view just saved from here, shown as stored (no longer changed, whatever the shown state still differs in).
  const loadViews = useCallback((saved?: string) => {
    const isFresh = fresh.ticket();
    return repo.listViews(collection.id, space.id).then((list) => {
      if (!isFresh()) return;
      setSavedViews(list);
      // A shown view without unsaved changes follows its stored settings when they change
      // elsewhere, instead of turning into "changed".
      const cur = shown.current;
      const next = list.find((v) => v.id === (saved ?? cur?.activeId));
      if (cur && next && (saved !== undefined || sameView(cur.view, cur.reference))) setView(normalized(collection, next, allCollections.current));
    }, (e) => setError(errorMessage(e)));
  }, [repo, collection, space.id, fresh]);
  useEffect(() => {
    void loadViews();
  }, [loadViews]);
  // Opening the page shows the starred view, else the first — once, when the views have loaded.
  const openedDefault = useRef(false);
  // The blocks wait for it: shown before, they were made for the base view, then made again for it
  // (their key is the shown view's), a large table twice.
  const [viewChosen, setViewChosen] = useState(false);
  // Views changed elsewhere (another pane) show up here too; items arrive through useItems.
  useDataChanges((change) => {
    if (change.scope === "views" && change.collectionId === collection.id) loadViews();
  });

  const views = savedViews === null ? [] : withVirtual(savedViews);
  const active = views.find((v) => v.id === activeId) ?? null;
  const reference = active ? normalized(collection, active, collections) : base;
  const changed = !sameView(view, reference);
  shown.current = { activeId, view, reference };

  /** A change to what a block shows (filter, sort, grouping, fields): unsaved until Save changes. */
  const setBlock = (block: ViewBlock) => setView((v) => ({ ...v, blocks: v.blocks.map((b) => (b.id === block.id ? block : b)) }));
  const selectView = useCallback(
    (id: string | null, list: CollectionView[] = savedViews ?? []) => {
      const next = withVirtual(list).find((v) => v.id === id);
      setActiveId(next ? next.id : null);
      setView(next ? normalized(collection, next, allCollections.current) : base);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [savedViews, collection, base, virtualView],
  );
  /** The view a collection opens with: the starred one, else the first. */
  const defaultViewOf = (list: CollectionView[]) => (list.find((v) => v.isDefault) ?? withVirtual(list)[0]).id;
  // Before paint, so the first view never flashes ahead of the starred one.
  // A bookmark opens a particular view (?view=…), also when this page is already showing.
  const [params] = useSearchParams();
  const wanted = params.get("view");
  // A link to a block of the view (?block=): scrolled to once the view is shown.
  useLinkTarget(params.get("block"), findBlock, savedViews !== null);
  useLayoutEffect(() => {
    if (openedDefault.current || savedViews === null) return;
    openedDefault.current = true;
    selectView(wanted && savedViews.some((v) => v.id === wanted) ? wanted : defaultViewOf(savedViews), savedViews);
    setViewChosen(true);
  }, [savedViews, selectView, wanted]);
  useEffect(() => {
    // Not the address this page wrote itself (below): that one arrives a moment after the tab was chosen, maybe
    // after another tab was chosen too, and selecting it would switch back (or reset the view just changed).
    if (wanted === written.current) return;
    if (openedDefault.current && wanted && wanted !== shown.current?.activeId && savedViews?.some((v) => v.id === wanted)) selectView(wanted);
    // Only when the requested view changes, not on every edit of the views.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);
  // The shown view goes into the address (replacing it: choosing a view is no step back), so coming
  // back to this page (back from an item, a restored tab) shows that view, not the starred one.
  const written = useRef<string | null>(null);
  useEffect(() => {
    if (!viewChosen || !activeId || activeId === VIRTUAL_VIEW || activeId === wanted) return;
    const next = new URLSearchParams(params);
    next.set("view", activeId);
    written.current = activeId;
    navigate({ search: `?${next}` }, { replace: true });
    // Only when the shown view changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, viewChosen]);

  /** Stores the virtual "All" view (as shown without changes) before something else needs a real one. */
  async function storeVirtual() {
    if (savedViews === null || savedViews.length > 0) return;
    const id = newId();
    const ts = now();
    await repo.saveView({ ...base, id, collectionId: collection.id, spaceId: space.id, name: "All", position: 0, isDefault: false, collapsed: NOTHING_COLLAPSED, createdAt: ts, updatedAt: ts });
    setSavedViews(await repo.listViews(collection.id, space.id));
    if (activeId === VIRTUAL_VIEW) setActiveId(id);
    return id;
  }

  async function saveAsNew(name: string, state: ViewState = view) {
    await storeVirtual();
    const id = newId();
    const ts = now();
    await repo.saveView({ ...state, id, collectionId: collection.id, spaceId: space.id, name, position: Math.max(views.length, 1), isDefault: false, collapsed: active?.collapsed ?? NOTHING_COLLAPSED, createdAt: ts, updatedAt: ts });
    const list = await repo.listViews(collection.id, space.id);
    setSavedViews(list);
    selectView(id, list);
  }

  /**
   * "+": a new view from what is shown, named "New" (then "New 2", …): a copy of the shown view,
   * with its unsaved changes (the shown view itself stays as saved; this is also "save as new
   * view"). It opens with View settings open and its name selected, ready to rename.
   */
  async function addView() {
    await saveAsNew(newName(views.map((v) => v.name)), view);
    setRenameRequest((r) => r + 1);
  }
  const panels = usePanelsOpen();
  // The view's Filter button is on the filter bar while that is shown. It moves only once a panel
  // closes (View settings is where the bar is switched on): leaving the toolbar, it would move the
  // buttons after it, and their open panels with them. The bar itself shows at once, and stays until then when switched off.
  const filterInBar = panels.hold("filterInBar", !!active?.filterBar);
  // "Full width" (View settings): off, the view is the narrow column of an item page. Held while a panel is
  // open, like the filter bar: the width moves the toolbar's buttons, and the open panel with them.
  const fullWidth = panels.hold("fullWidth", isFullWidth("collection", active?.fullWidth));
  // Which blocks are beside another, held likewise: a block put in a row (Block settings) would move its open panel.
  const beside = panels.hold("beside", besideOf(view.blocks));

  async function updateActive() {
    if (!active) return;
    const id = (await storeVirtual()) ?? active.id;
    // Everything Save is offered for (sameView): filters, blocks and "Fields are editable".
    await repo.saveView({ ...active, id, createdAt: active.createdAt || now(), filters: view.filters, blocks: view.blocks, editable: view.editable });
    await loadViews(id);
  }

  /**
   * "Show filter bar": stored with the shown view right away (its unsaved changes left alone), like
   * arranging blocks; it shows no other items, so it is no change to save.
   */
  async function setFilterBar(on: boolean) {
    if (!active) return;
    setSavedViews((list) => list && list.map((v) => (v.id === active.id ? withFilterBar(v, on) : v)));
    await fresh.storing(async () => {
      const id = (await storeVirtual()) ?? active.id;
      await repo.saveView({ ...withFilterBar(active, on), id, createdAt: active.createdAt || now() });
    });
    await loadViews();
  }

  /** "Full width": stored with the shown view right away, as "Show filter bar" (it shows no other items). */
  async function setFullWidth(on: boolean) {
    if (!active) return;
    setSavedViews((list) => list && list.map((v) => (v.id === active.id ? withFullWidth(v, on) : v)));
    await fresh.storing(async () => {
      const id = (await storeVirtual()) ?? active.id;
      await repo.saveView({ ...withFullWidth(active, on), id, createdAt: active.createdAt || now() });
    });
    await loadViews();
  }

  /**
   * Collapsing or expanding a block or a group: stored with the shown view right away (as saved,
   * its unsaved changes left alone), shown at once; not a change to save.
   */
  async function setCollapsed(next: Collapsed) {
    if (!active) return;
    setSavedViews((list) => list && list.map((v) => (v.id === active.id ? { ...v, collapsed: next } : v)));
    await fresh.storing(async () => {
      const id = (await storeVirtual()) ?? active.id;
      await repo.saveView({ ...active, id, createdAt: active.createdAt || now(), collapsed: next });
    });
    await loadViews();
  }

  // Arranging the view's blocks is stored right away with the view (views/useBlockArrangement.ts); a view keeps one block.
  const { arrangeNow, setBlockNow, moveBlocks, rowActions, removeBlocks } = useBlockArrangement({
    blocks: view.blocks,
    storedBlocks: active?.blocks ?? null,
    setBlocks: (change) => setView((v) => ({ ...v, blocks: change(v.blocks) })),
    async store(blocks) {
      if (!active) return;
      setSavedViews((list) => list && list.map((v) => (v.id === active.id ? { ...v, blocks } : v)));
      await fresh.storing(async () => {
        const id = (await storeVirtual()) ?? active.id;
        await repo.saveView({ ...active, id, createdAt: active.createdAt || now(), blocks });
      });
      await loadViews();
    },
    keepOne: true,
    confirm,
    onError: (e) => setError(errorMessage(e)),
  });
  /** "Add block": a new one of a type / component, with the view's filter. */
  const addBlock = (spec: NewBlockSpec) => {
    const block = normalizeBlock(collection, newBlock(spec.kind, spec.options ?? blockType(spec.kind).defaultOptions(collection)));
    arrangeNow((blocks) => [...blocks, block]);
  };

  /** Star the active view as the default, or unstar it (then the first view opens by default). */
  async function toggleDefault() {
    if (!active) return;
    const id = (await storeVirtual()) ?? active.id;
    await repo.setDefaultView(collection.id, space.id, active.isDefault ? null : id);
    await loadViews();
  }

  /** The shown view one place to the left or right among the tabs (with several, all are stored). */
  async function moveActive(by: -1 | 1) {
    if (!active || !savedViews) return;
    const ids = savedViews.map((v) => v.id);
    const next = movedId(ids, active.id, by);
    if (next === ids) return;
    await repo.orderViews(collection.id, space.id, next);
    await loadViews();
  }

  async function renameActive(name: string) {
    if (!active || !name || name === active.name) return;
    const id = (await storeVirtual()) ?? active.id;
    await repo.saveView({ ...active, id, createdAt: active.createdAt || now(), name });
    await loadViews();
  }

  async function deleteActive() {
    if (!active || !(await confirm({ title: `Delete view “${active.name}”?`, body: "Items are not affected." }))) return;
    await repo.deleteView(active.id);
    const rest = await repo.listViews(collection.id, space.id);
    setSavedViews(rest);
    selectView(defaultViewOf(rest), rest);
  }


  // The view's filter (every block uses it unless it has its own), in the toolbar or on the filter bar.
  const filterButton = (
    <ToolbarPopover
      label={view.filters.length > 0 ? `Filter (${view.filters.length})` : "Filter"}
      icon={Filter}
      width="wide"
      active={view.filters.length > 0}
      onOpenChange={panels.onOpenChange}
    >
      <QueryEditor
        collection={collection}
        query={{ filters: view.filters, sort: [], groupBy: null }}
        refs={data.refs}
        part="filter"
        onChange={(q) => setView((v) => ({ ...v, filters: q.filters }))}
      />
    </ToolbarPopover>
  );

  return (
    // Without "Full width", the page keeps to the narrow column of an item page.
    <div className={fullWidth ? "view-page" : "view-page view-page--narrow"}>
      <PageHeader
        current={collection.pluralName}
        title={
          <Heading className="page-header__title title-with-icon">
            <CollectionIcon name={collection.icon} size={32} />
            {collection.pluralName}
          </Heading>
        }
        subtitle={collection.description || (remote ? `Read from ${collection.source!.name}` : undefined)}
        breadcrumbs={[collectionsCrumb(collection)]}
        actions={
          // Like "New collection" and "New component": the page's main action, in its header. A
          // remote collection's rows are the source's: none are added here.
          !readOnly && <NewButton label={`New ${collection.name}`} onClick={() => navigate(`/collections/${collection.id}/items/new`)} />
        }
      />
      {error && <InlineNotification kind="error" title="Error" subtitle={error} onClose={() => setError(undefined)} />}

      {/* Saved views (a new collection gets "All"); the starred one, else the first, opens by default.
          Unsaved changes to the shown view surface as icon buttons beside its star. */}
      {/* Always shown, also for a single view: its name, "+", bookmark and saving stay in one place. */}
      {savedViews !== null && (
        <ViewsBar
          views={views}
          activeId={active?.id}
          changed={changed}
          label="Views"
          onSelect={selectView}
          onAdd={() => addView().catch((e) => setError(errorMessage(e)))}
          saveShown={panels.hold("changed", changed) && !!active}
          onSave={() => updateActive().catch((e) => setError(errorMessage(e)))}
          // The last view can't be deleted (a collection always keeps one); with one there's nothing to star.
          onDelete={active && views.length > 1 ? () => deleteActive().catch((e) => setError(errorMessage(e))) : undefined}
          star={
            active && views.length > 1
              ? { isDefault: active.isDefault, label: active.isDefault ? "Revert default view" : "Star as default view", onToggle: () => toggleDefault().catch((e) => setError(errorMessage(e))) }
              : undefined
          }
          bookmark={
            active && (
              <BookmarkButton
                link={collectionViewLink(collection.id, active.id)}
                // The virtual "All" view is stored first: a bookmark needs a real view.
                prepare={active.id === VIRTUAL_VIEW ? () => storeVirtual().then((id) => (id ? collectionViewLink(collection.id, id) : undefined)) : undefined}
                label={`${collection.pluralName} / ${active.name}`}
                onError={(e) => setError(errorMessage(e))}
              />
            )
          }
        >
          {/* A remote collection's rows, read again from its source (they aren't kept current by themselves). */}
          {remote && (
            <IconButton autoAlign kind="ghost" size="sm" align="bottom" label={`Read again from ${collection.source!.name}`} onClick={() => sources.refresh(collection.id)}>
              <Renew />
            </IconButton>
          )}
          {/* The view's own tools: search in it (a bar below), its filter (every block uses it
              unless it has its own) and its settings. A blue icon = in effect. */}
          <ViewSearchButton state={viewSearch} name={collection.pluralName} />
          {!filterInBar && filterButton}
          <ViewSettingsPanel
            view={active && { id: active.id, name: active.name, index: savedViews?.findIndex((v) => v.id === active.id) ?? -1, count: savedViews?.length ?? 0 }}
            nameInput={nameInput}
            openRequest={renameRequest}
            onOpenChange={panels.onOpenChange}
            onMove={(by) => moveActive(by).catch((e) => setError(errorMessage(e)))}
            onRename={(name) => renameActive(name).catch((e) => setError(errorMessage(e)))}
            filterBar={active && { checked: !!active.filterBar, onChange: (on) => setFilterBar(on).catch((e) => setError(errorMessage(e))) }}
            fullWidth={active && { checked: isFullWidth("collection", active.fullWidth), onChange: (on) => setFullWidth(on).catch((e) => setError(errorMessage(e))) }}
            editable={readOnly ? null : { checked: view.editable, onChange: (on) => setView((v) => ({ ...v, editable: on })) }}
          >
            <BlockListEditor
              blocks={view.blocks}
              onMove={moveBlocks}
              onRemove={(ids, asked) => removeBlocks(ids, asked).catch((e) => setError(errorMessage(e)))}
              onAdd={addBlock}
              onHeader={(id, shown) => setBlockNow(id, { hideHeader: shown ? undefined : true })}
              onDuplicate={(id) => {
                const copy = newId();
                arrangeNow((blocks) => withCopy(blocks, id, copy));
              }}
            />
          </ViewSettingsPanel>
        </ViewsBar>
      )}

      {/* The filter bar ("Show filter bar" in View settings): the view's Filter button and date period. */}
      {savedViews !== null && (active?.filterBar || filterInBar) && (
        <FilterBar collection={collection} filters={view.filters} onChange={(filters) => setView((v) => ({ ...v, filters }))}>
          {filterInBar && filterButton}
        </FilterBar>
      )}

      {/* Search in the view (all its blocks), opened from its icon; never saved. Escape on an
          empty box, or leaving it empty, closes it. */}
      <ViewSearchBar state={viewSearch} name={collection.pluralName} id={`${uid}-items-search`} />

      {/* The blocks once the items are in (a fraction of a second), all at once: shown before, each
          block's header would stand alone and be pushed down as the blocks above it fill. */}
      {savedViews !== null &&
        viewChosen &&
        (data.items !== null || data.error) && (
          <BlockRows
            entries={view.blocks}
            beside={beside}
            blockOf={(b) => b}
            onPlace={rowActions.place}
            onShares={rowActions.shares}
            render={(block, placed) => {
              // A block of one of the collection's list fields' entries reads those (not the view's filter: it is over the items);
              // its field gone, it lists the collection again.
              const list = isListCollectionId(block.collectionId) ? findCollection(collections, block.collectionId) : undefined;
              const shown = (listed: Collection, listedData: typeof data) => (
              <BlockView
                // Keyed by the shown view too, so group collapse state isn't carried over to another view.
                key={`${activeId ?? ""}-${block.id}`}
                collection={listed}
                data={listedData}
                block={block}
                viewFilters={listed === collection ? view.filters : null}
                search={viewSearch.searched}
                place="collection"
                page={null}
                editable={view.editable && !readOnly}
                collapsed={active?.collapsed ?? NOTHING_COLLAPSED}
                onCollapse={(next) => setCollapsed(next).catch((e) => setError(errorMessage(e)))}
                onChange={setBlock}
                onSet={(patch) => setBlockNow(block.id, patch)}
                // A view keeps at least one block.
                onRemove={view.blocks.length > 1 ? () => removeBlocks([block.id]).catch((e) => setError(errorMessage(e))) : undefined}
                onError={setError}
                onOpenChange={panels.onOpenChange}
                // Collapsed per block, a row side by side as one (views/BlockRows.tsx rowCollapse).
                collapse={rowCollapse(
                  view.blocks.map((b) => b.id),
                  view.blocks,
                  active?.collapsed ?? NOTHING_COLLAPSED,
                  block,
                  (next) => setCollapsed(next).catch((e) => setError(errorMessage(e))),
                )}
                onDragStart={placed.onDragStart}
                row={rowActions.controls(block)}
              />
              );
              return list ? <ListData key={`${activeId ?? ""}-${block.id}`} list={list}>{(d) => shown(list, d)}</ListData> : shown(collection, data);
            }}
          />
        )}

      {dialog}
    </div>
  );
}
