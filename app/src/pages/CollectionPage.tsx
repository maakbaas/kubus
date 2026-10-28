import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { Checkbox, Heading, IconButton, InlineNotification, Search, Tab, TabList, Tabs, TextInput } from "@carbon/react";
import { Add, Filter, Renew, Save, Search as SearchIcon, SettingsAdjust, Star, StarFilled, TrashCan } from "@carbon/icons-react";
import { useStore, useCollection } from "../app/store";
import { useDataChanges } from "../app/useDataChanges";
import { newName, now, newId, type Collection } from "../domain/model";
import { firstShownFields, isRemote } from "../domain/sources";
import { defaultViewState, newBlock, NOTHING_COLLAPSED, sameView, type Collapsed, type CollectionView, type ViewBlock, type ViewState } from "../domain/views";
import { NotFound } from "../ui/NotFound";
import { CollectionIcon } from "../ui/collectionIcons";
import { BookmarkButton } from "../ui/BookmarkButton";
import { NewButton } from "../ui/NewButton";
import { collectionsCrumb, PageHeader } from "../ui/PageHeader";
import { OverflowBar } from "../ui/OverflowBar";
import { TabMenu, useClippedTabs } from "../ui/TabMenu";
import { findBlock, useLinkTarget } from "../ui/useLinkTarget";
import { errorMessage, useConfirm } from "../ui/useConfirm";
import { blockType, normalizeBlock, normalizeView } from "../views";
import { BlockListEditor, useBlockName } from "../views/BlockListEditor";
import type { NewBlockSpec } from "../views/AddBlockButton";
import { BlockView } from "../views/BlockView";
import { QueryEditor } from "../views/QueryEditor";
import { useCollectionData } from "../views/useCollectionData";
import { ToolbarPopover, usePanelsOpen } from "../ui/ToolbarPopover";

export function CollectionPage() {
  const { collectionId } = useParams();
  const collection = useCollection(collectionId);
  if (!collection) return <NotFound />;
  return <CollectionContent key={collection.id} collection={collection} />;
}

/** A view state valid for this collection (stored blocks may be outdated). */
const normalized = (collection: Collection, state: ViewState): ViewState => normalizeView(collection, { filters: state.filters, blocks: state.blocks, editable: state.editable });

/** Id of the virtual "All" view of a space that has no stored view of the collection. */
const VIRTUAL_VIEW = "default";

function CollectionContent({ collection }: { collection: Collection }) {
  // Element ids unique per instance: the same page can be open in several tabs.
  const uid = useId();
  const { repo, space, sources } = useStore();
  const navigate = useNavigate();
  // A remote collection's rows are read from its source, read-only (domain/sources.ts).
  const remote = isRemote(collection);
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
    () => normalized(collection, defaultViewState(blockType("table").defaultOptions(collection), firstShownFields(collection), !isRemote(collection))),
    [collection],
  );
  const virtualView = useMemo<CollectionView>(
    () => ({ ...base, id: VIRTUAL_VIEW, collectionId: collection.id, spaceId: space.id, name: "All", position: 0, isDefault: false, collapsed: NOTHING_COLLAPSED, createdAt: "", updatedAt: "" }),
    [base, collection.id, space.id],
  );
  const withVirtual = (list: CollectionView[]) => (list.length > 0 ? list : [virtualView]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<ViewState>(base);
  const [search, setSearch] = useState("");
  /** The search bar below the tab bar is shown (opened from its icon). */
  const [searchOpen, setSearchOpen] = useState(false);
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
  const loadViews = useCallback(
    () =>
      repo.listViews(collection.id, space.id).then((list) => {
        setSavedViews(list);
        // A shown view without unsaved changes follows its stored settings when they change
        // elsewhere, instead of turning into "changed".
        const cur = shown.current;
        const next = cur?.activeId ? list.find((v) => v.id === cur.activeId) : undefined;
        if (cur && next && sameView(cur.view, cur.reference)) setView(normalized(collection, next));
      }, (e) => setError(errorMessage(e))),
    [repo, collection, space.id],
  );
  useEffect(() => {
    loadViews();
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
  const reference = active ? normalized(collection, active) : base;
  const changed = !sameView(view, reference);
  const viewsBar = useRef<HTMLDivElement>(null);
  const clippedTabs = useClippedTabs(viewsBar);
  shown.current = { activeId, view, reference };

  /** A change to what a block shows (filter, sort, grouping, fields): unsaved until Save changes. */
  const setBlock = (block: ViewBlock) => setView((v) => ({ ...v, blocks: v.blocks.map((b) => (b.id === block.id ? block : b)) }));
  const selectView = useCallback(
    (id: string | null, list: CollectionView[] = savedViews ?? []) => {
      const next = withVirtual(list).find((v) => v.id === id);
      setActiveId(next ? next.id : null);
      setView(next ? normalized(collection, next) : base);
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
    if (openedDefault.current && wanted && savedViews?.some((v) => v.id === wanted)) selectView(wanted);
    // Only when the requested view changes, not on every edit of the views.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);

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
  const addButton = (
    <IconButton autoAlign kind="ghost" size="sm" align="bottom" label="Add view" onClick={() => addView().catch((e) => setError(errorMessage(e)))}>
      <Add />
    </IconButton>
  );
  const panels = usePanelsOpen();

  async function updateActive() {
    if (!active) return;
    const id = (await storeVirtual()) ?? active.id;
    await repo.saveView({ ...active, id, createdAt: active.createdAt || now(), filters: view.filters, blocks: view.blocks });
    await loadViews();
  }

  /**
   * Collapsing or expanding a block or a group: stored with the shown view right away (as saved,
   * its unsaved changes left alone), shown at once; not a change to save.
   */
  async function setCollapsed(next: Collapsed) {
    if (!active) return;
    setSavedViews((list) => list && list.map((v) => (v.id === active.id ? { ...v, collapsed: next } : v)));
    const id = (await storeVirtual()) ?? active.id;
    await repo.saveView({ ...active, id, createdAt: active.createdAt || now(), collapsed: next });
    await loadViews();
  }

  /**
   * Arranging the view (adding, removing and reordering blocks; a block's type, options and
   * name) is stored right away, applied to the shown and the saved view alike, so it is no change
   * to save; what changes the shown items (filters, sort, grouping, fields) waits for Save changes.
   */
  async function arrange(change: (blocks: ViewBlock[]) => ViewBlock[], stored: (blocks: ViewBlock[]) => ViewBlock[] = change) {
    setView((v) => ({ ...v, blocks: change(v.blocks) }));
    if (!active) return;
    const blocks = stored(active.blocks);
    if (JSON.stringify(blocks) === JSON.stringify(active.blocks)) return;
    setSavedViews((list) => list && list.map((v) => (v.id === active.id ? { ...v, blocks } : v)));
    const id = (await storeVirtual()) ?? active.id;
    await repo.saveView({ ...active, id, createdAt: active.createdAt || now(), blocks });
    await loadViews();
  }
  const arrangeNow = (change: (blocks: ViewBlock[]) => ViewBlock[], stored?: (blocks: ViewBlock[]) => ViewBlock[]) =>
    arrange(change, stored).catch((e) => setError(errorMessage(e)));
  /** A block's type, options or name (where the block is: shown, saved or both). */
  const setBlockNow = (id: string, patch: Partial<ViewBlock>) => arrangeNow((blocks) => blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  /** "Add block": a new one of a type / component, with the view's filter. */
  const addBlock = (spec: NewBlockSpec) => {
    const block = normalizeBlock(collection, newBlock(spec.kind, spec.options ?? blockType(spec.kind).defaultOptions(collection)));
    arrangeNow((blocks) => [...blocks, block]);
  };
  /** Reordered blocks; the saved view's blocks follow the same order. */
  const moveBlocks = (order: ViewBlock[]) => {
    const at = (b: ViewBlock) => order.findIndex((o) => o.id === b.id) >>> 0; // not shown: last
    arrangeNow(() => order, (blocks) => [...blocks].sort((a, b) => at(a) - at(b)));
  };
  const blockName = useBlockName();
  /** Removing blocks (a view keeps one): asked first, unless asked already. */
  async function removeBlocks(ids: string[], asked = false) {
    const gone = view.blocks.filter((b) => ids.includes(b.id));
    if (gone.length === 0 || gone.length >= view.blocks.length) return;
    const title = gone.length === 1 ? `Remove block “${blockName(gone[0])}”?` : `Remove ${gone.length} blocks?`;
    if (!asked && !(await confirm({ title, body: "Items are not affected." }))) return;
    await arrange((blocks) => blocks.filter((b) => !ids.includes(b.id)));
  }

  /** Star the active view as the default, or unstar it (then the first view opens by default). */
  async function toggleDefault() {
    if (!active) return;
    const id = (await storeVirtual()) ?? active.id;
    await repo.setDefaultView(collection.id, space.id, active.isDefault ? null : id);
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


  return (
    <>
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
          !remote && <NewButton label={`New ${collection.name}`} onClick={() => navigate(`/collections/${collection.id}/items/new`)} />
        }
      />
      {error && <InlineNotification kind="error" title="Error" subtitle={error} onClose={() => setError(undefined)} />}

      {/* Saved views (a new collection gets "All"); the starred one, else the first, opens by default.
          Unsaved changes to the shown view surface as icon buttons beside its star. */}
      {/* Always shown, also for a single view: its name, "+", bookmark and saving stay in one place. */}
      {savedViews !== null && (
        <div className="views-bar" ref={viewsBar}>
          {views.length > 0 && (
            <Tabs selectedIndex={active ? views.indexOf(active) : -1} onChange={({ selectedIndex }) => selectView(views[selectedIndex].id)}>
              <TabList aria-label="Views" className="views-tabs">
                {/* "*" marks unsaved changes to the shown view (switching views discards them). */}
                {views.map((v) => (
                  <Tab key={v.id}>
                    {v.name}
                    {changed && v.id === active?.id ? " *" : ""}
                  </Tab>
                ))}
              </TabList>
            </Tabs>
          )}
          {clippedTabs && (
            <TabMenu
              label="Views"
              items={views.map((v) => ({ id: v.id, name: v.name + (changed && v.id === active?.id ? " *" : "") }))}
              activeId={active?.id}
              onSelect={selectView}
            />
          )}
          {/* "+" takes the menu arrow's place; with the arrow it joins the icons at the right edge. */}
          {!clippedTabs && <span className="tab-menu">{addButton}</span>}
          <span className="views-bar__spacer" />
          {/* Always in the bar, left of the other buttons (never in the "⋮" menu); held while a panel
              is open, so it appears once the panel closes. Unsaved changes are dropped by opening
              the view again (its tab) or another one. */}
          {panels.hold("changed", changed) && active && (
            <IconButton autoAlign kind="ghost" size="sm" align="bottom" label="Save changes to view" onClick={() => updateActive().catch((e) => setError(errorMessage(e)))}>
              <Save />
            </IconButton>
          )}
          <OverflowBar>
          {clippedTabs && addButton}
          {/* The last view can't be deleted: a collection always keeps one. */}
          {active && views.length > 1 && (
            <IconButton autoAlign kind="ghost" size="sm" align="bottom" label="Delete view" onClick={() => deleteActive().catch((e) => setError(errorMessage(e)))}>
              <TrashCan />
            </IconButton>
          )}
          {/* With one view there's nothing to choose: it opens anyway. */}
          {active && views.length > 1 && (
            <IconButton autoAlign
              kind="ghost"
              size="sm"
              align="bottom"
              label={active.isDefault ? "Revert default view" : "Star as default view"}
              aria-pressed={active.isDefault}
              onClick={() => toggleDefault().catch((e) => setError(errorMessage(e)))}
            >
              {active.isDefault ? <StarFilled /> : <Star />}
            </IconButton>
          )}
          {active && (
            <BookmarkButton
              kind="view"
              collectionId={collection.id}
              targetId={active.id}
              // The virtual "All" view is stored first: a bookmark needs a real view.
              prepare={active.id === VIRTUAL_VIEW ? storeVirtual : undefined}
              label={`${collection.pluralName} / ${active.name}`}
              onError={(e) => setError(errorMessage(e))}
            />
          )}
          {/* A remote collection's rows, read again from its source (they aren't kept current by themselves). */}
          {remote && (
            <IconButton autoAlign kind="ghost" size="sm" align="bottom" label={`Read again from ${collection.source!.name}`} onClick={() => sources.refresh(collection.id)}>
              <Renew />
            </IconButton>
          )}
          {/* The view's own tools: search in it (a bar below), its filter (every block uses it
              unless it has its own) and its settings. A blue icon = in effect. */}
          <IconButton
            autoAlign
            kind="ghost"
            size="sm"
            align="bottom"
            label={searchOpen ? "Close search" : `Search ${collection.pluralName}`}
            isSelected={searchOpen}
            data-active={search ? true : undefined}
            aria-expanded={searchOpen}
            onClick={() => {
              if (searchOpen) setSearch("");
              setSearchOpen(!searchOpen);
            }}
          >
            <SearchIcon />
          </IconButton>
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
          <ToolbarPopover label="View settings" icon={SettingsAdjust} width="narrow" openRequest={renameRequest} onOpenChange={panels.onOpenChange}>
            <div className="view-settings">
              {active && (
                <TextInput
                  size="sm"
                  key={active.id + active.name}
                  id={`${uid}-view-rename`}
                  ref={nameInput}
                  labelText="View name"
                  defaultValue={active.name}
                  onBlur={(e) => renameActive(e.target.value.trim()).catch((err) => setError(errorMessage(err)))}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                />
              )}
              {!remote && (
                <Checkbox id={`${uid}-view-editable`} labelText="Fields are editable" checked={view.editable} onChange={(_, { checked }) => setView((v) => ({ ...v, editable: checked }))} />
              )}
              <BlockListEditor
                blocks={view.blocks}
                onMove={moveBlocks}
                onRemove={(ids, asked) => removeBlocks(ids, asked).catch((e) => setError(errorMessage(e)))}
                onAdd={addBlock}
                onHeader={(id, shown) => setBlockNow(id, { hideHeader: shown ? undefined : true })}
              />
            </div>
          </ToolbarPopover>
          </OverflowBar>
        </div>
      )}

      {/* Search in the view (all its blocks), opened from its icon; never saved. Escape on an
          empty box, or leaving it empty, closes it. */}
      {searchOpen && (
        <div className="items-search">
          <Search
            id={`${uid}-items-search`}
            size="sm"
            autoFocus
            labelText={`Search ${collection.pluralName}`}
            placeholder={`Search ${collection.pluralName}`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && !search && setSearchOpen(false)}
            onBlur={() => !search && setSearchOpen(false)}
          />
        </div>
      )}

      {/* The blocks once the items are in (a fraction of a second), all at once: shown before, each
          block's header would stand alone and be pushed down as the blocks above it fill. */}
      {savedViews !== null &&
        viewChosen &&
        (data.items !== null || data.error) &&
        view.blocks.map((block) => (
          <BlockView
            // Keyed by the shown view too, so group collapse state isn't carried over to another view.
            key={`${activeId ?? ""}-${block.id}`}
            collection={collection}
            data={data}
            block={block}
            viewFilters={view.filters}
            search={search}
            place="collection"
            page={null}
            editable={view.editable && !remote}
            collapsed={active?.collapsed ?? NOTHING_COLLAPSED}
            onCollapse={(next) => setCollapsed(next).catch((e) => setError(errorMessage(e)))}
            onChange={setBlock}
            onSet={(patch) => setBlockNow(block.id, patch)}
            // A view keeps at least one block.
            onRemove={view.blocks.length > 1 ? () => removeBlocks([block.id]).catch((e) => setError(errorMessage(e))) : undefined}
            onError={setError}
            onOpenChange={panels.onOpenChange}
          />
        ))}

      {dialog}
    </>
  );
}
