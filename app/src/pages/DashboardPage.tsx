import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { Checkbox, Heading, IconButton, InlineNotification, MultiSelect, Search, Tab, TabList, Tabs, TextArea, TextInput, Tile } from "@carbon/react";
import { Add, Filter, Renew, Save, Search as SearchIcon, Settings, SettingsAdjust, Star, StarFilled, TrashCan } from "@carbon/icons-react";
import { useDashboard, useStore } from "../app/store";
import { useDataChanges } from "../app/useDataChanges";
import { findCollection } from "../domain/backlinks";
import { DASHBOARD_ICON, findTab, dashboardBlockCollection,
 dashboardIcon, dashboardScope, FIRST_TAB_NAME, newDashboardBlock, type Dashboard, type DashboardView } from "../domain/dashboards";

import { newId, newName, now, type Collection } from "../domain/model";
import { isRemote } from "../domain/sources";
import type { Space } from "../domain/spaces";
import { isFullWidth, NOTHING_COLLAPSED, sameView, type Collapsed, type ViewBlock, type ViewState } from "../domain/views";
import { BookmarkButton } from "../ui/BookmarkButton";
import { CollectionIcon } from "../ui/collectionIcons";
import { IconPicker } from "../ui/IconPicker";
import { NotFound } from "../ui/NotFound";
import { OverflowBar } from "../ui/OverflowBar";
import { PageHeader } from "../ui/PageHeader";
import { SpaceLabel } from "../ui/SpaceSwitcher";
import { TabMenu, useClippedTabs } from "../ui/TabMenu";
import { ToolbarPopover, usePanelsOpen } from "../ui/ToolbarPopover";
import { findBlock, useLinkTarget } from "../ui/useLinkTarget";
import { errorMessage, useConfirm } from "../ui/useConfirm";
import { useReferenceOptions } from "../ui/useReferenceOptions";
import { blockType, normalizeBlock } from "../views";
import type { NewBlockSpec } from "../views/AddBlockButton";
import { AddBlockButton } from "../views/AddBlockButton";
import { BlockListEditor, useBlockName } from "../views/BlockListEditor";
import { BlockView } from "../views/BlockView";
import { FilterBar } from "../views/FilterBar";
import { QueryEditor } from "../views/QueryEditor";
import { useCollectionData } from "../views/useCollectionData";

// A dashboard: tabs (its views, per space like a collection's: domain/dashboards.ts) of blocks, each block listing
// collections of its own (one, or several read as one). Built like a collection view (CollectionPage): what changes the
// shown items (the tab's filter, a block's filter, sort, grouping and fields, "Fields are editable") is unsaved until
// Save changes (*); arranging the tab (blocks added, removed, moved, a block's type, options, name and collections), its
// name, "Show filter bar", "Full width" and collapsing are stored at once. A space without tabs of its own shows copies
// of another space's (virtual): they are stored in this space (all at once) before one changes.

export function DashboardPage() {
  const { dashboardId } = useParams();
  const dashboard = useDashboard(dashboardId);
  if (!dashboard) return <NotFound />;
  return <DashboardContent key={dashboard.id} dashboard={dashboard} />;
}

/** The view state of a tab (what Save changes compares and stores). */
const stateOf = (v: DashboardView): ViewState => ({ filters: v.filters, blocks: v.blocks, editable: v.editable });

/** A tab without the mark of a virtual one, under its stored id. */
const storedAs = (v: DashboardView, id: string): DashboardView => {
  const { virtual: _virtual, ...rest } = v;
  return { ...rest, id };
};

/** The view's search box filters once typing pauses this long (as a collection view's). */
const SEARCH_DELAY_MS = 150;

/** What a tab-less dashboard shows (it can lose its tabs only by sync): an empty tab, stored once it changes. */
const EMPTY_TAB = "empty";

/** The collections a block lists (those that still exist). */
const blockCollections = (block: ViewBlock, collections: Collection[]): Collection[] =>
  (block.collectionIds && block.collectionIds.length > 0 ? block.collectionIds : [block.collectionId]).flatMap((id) => {
    const c = findCollection(collections, id);
    return c ? [c] : [];
  });

function DashboardContent({ dashboard }: { dashboard: Dashboard }) {
  const uid = useId();
  const { repo, space, spaces, collections, spaceCollections, sources } = useStore();
  const navigate = useNavigate();
  const location = useLocation();
  const { confirm, dialog } = useConfirm();
  const [savedViews, setSavedViews] = useState<DashboardView[] | null>(null); // null = loading
  const [error, setError] = useState<string>();
  const fail = (e: unknown) => setError(errorMessage(e));

  const emptyTab = useMemo<DashboardView>(
    () => ({ id: EMPTY_TAB, dashboardId: dashboard.id, spaceId: space.id, name: FIRST_TAB_NAME, position: 0, isDefault: false, filters: [], blocks: [], editable: true, collapsed: NOTHING_COLLAPSED, virtual: true, createdAt: "", updatedAt: "" }),
    [dashboard.id, space.id],
  );
  const withEmpty = useCallback((list: DashboardView[]) => (list.length > 0 ? list : [emptyTab]), [emptyTab]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<ViewState>(stateOf(emptyTab));
  const [search, setSearch] = useState("");
  const [searched, setSearched] = useState("");
  useEffect(() => {
    if (!search) return setSearched("");
    const timer = window.setTimeout(() => setSearched(search), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [search]);
  const [searchOpen, setSearchOpen] = useState(false);
  /** Set after "+": opens Tab settings with the new tab's name selected, to rename it. */
  const [renameRequest, setRenameRequest] = useState(0);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!renameRequest) return;
    const frame = requestAnimationFrame(() => {
      nameInput.current?.focus();
      nameInput.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [renameRequest, activeId]);
  /** A dashboard just made (the Dashboards page's New dashboard) opens with Dashboard settings open and its name selected. */
  const [settingsRequest] = useState(() => ((location.state as { rename?: boolean } | null)?.rename ? 1 : 0));
  const dashboardName = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!settingsRequest) return;
    const frame = requestAnimationFrame(() => {
      dashboardName.current?.focus();
      dashboardName.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [settingsRequest]);

  const shown = useRef<{ activeId: string | null; view: ViewState; reference: ViewState } | undefined>(undefined);
  const loadViews = useCallback(
    () =>
      repo.listDashboardViews(dashboard.id, space.id).then((list) => {
        setSavedViews(list);
        // A shown tab without unsaved changes follows its stored settings when they change elsewhere.
        const cur = shown.current;
        const next = cur?.activeId ? list.find((v) => v.id === cur.activeId) : undefined;
        if (cur && next && sameView(cur.view, cur.reference)) setView(stateOf(next));
      }, fail),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repo, dashboard.id, space.id],
  );
  useEffect(() => {
    loadViews();
  }, [loadViews]);
  useDataChanges((change) => {
    if (change.scope === "dashboardViews" && change.dashboardId === dashboard.id) loadViews();
  });
  const openedDefault = useRef(false);
  const [viewChosen, setViewChosen] = useState(false);

  const views = savedViews === null ? [] : withEmpty(savedViews);
  const active = views.find((v) => v.id === activeId) ?? null;
  const reference = active ? stateOf(active) : stateOf(emptyTab);
  const changed = !sameView(view, reference);
  const viewsBar = useRef<HTMLDivElement>(null);
  const clippedTabs = useClippedTabs(viewsBar);
  shown.current = { activeId, view, reference };

  const selectView = useCallback(
    (id: string | null, list: DashboardView[] = savedViews ?? []) => {
      const next = withEmpty(list).find((v) => v.id === id) ?? withEmpty(list)[0];
      setActiveId(next.id);
      setView(stateOf(next));
    },
    [savedViews, withEmpty],
  );
  const defaultViewOf = (list: DashboardView[]) => (list.find((v) => v.isDefault) ?? withEmpty(list)[0]).id;
  const [params] = useSearchParams();
  // A link or bookmark opens a particular tab (?view=…): a tab of this space, or the copy of another space's tab shown here.
  const wantedId = params.get("view");
  const wanted = (wantedId && savedViews && findTab(savedViews, wantedId)?.id) || null;
  useLinkTarget(params.get("block"), findBlock, savedViews !== null);
  useLayoutEffect(() => {
    if (openedDefault.current || savedViews === null) return;
    openedDefault.current = true;
    selectView(wanted ?? defaultViewOf(savedViews), savedViews);
    setViewChosen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedViews, selectView, wanted]);
  useEffect(() => {
    if (openedDefault.current && wanted) selectView(wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedId]);
  // The shown tab is gone (deleted elsewhere, or a virtual one stored in another pane): the default one shows.
  useEffect(() => {
    if (savedViews !== null && viewChosen && activeId && !active) selectView(defaultViewOf(savedViews), savedViews);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedViews, activeId, active, viewChosen]);

  /**
   * The shown tab as stored in this space, before it changes: a virtual one (a copy of another space's) is stored with
   * the others shown (all at once: a stored one would hide the rest), the empty one of a tab-less dashboard as a new tab.
   */
  async function stored(): Promise<DashboardView | null> {
    if (!active) return null;
    if (!active.virtual) return active;
    let tab: DashboardView | null;
    if (active.id === EMPTY_TAB) {
      const ts = now();
      tab = storedAs({ ...active, createdAt: ts, updatedAt: ts }, newId());
      await repo.saveDashboardView(tab);
    } else {
      const id = (await repo.storeDashboardViews(dashboard.id, space.id)).get(active.id);
      tab = id ? storedAs(active, id) : null;
    }
    if (!tab) return null;
    // The stored tabs and the shown one's new id at once (in between, the shown tab would seem gone).
    const list = await repo.listDashboardViews(dashboard.id, space.id);
    setSavedViews(list);
    setActiveId(tab.id);
    return tab;
  }

  /** Stores a change to the shown tab right away (shown at once). */
  async function storeNow(patch: Partial<DashboardView>) {
    if (!active) return;
    const shownWith = (id: string) => (list: DashboardView[] | null) => list && list.map((v) => (v.id === id ? { ...v, ...patch } : v));
    setSavedViews(shownWith(active.id));
    const tab = await stored();
    if (!tab) return;
    if (tab.id !== active.id) setSavedViews(shownWith(tab.id));
    await repo.saveDashboardView({ ...tab, ...patch });
    await loadViews();
  }


  async function addView() {
    const base = await stored();
    const list = await repo.listDashboardViews(dashboard.id, space.id);
    const id = newId();
    const ts = now();
    await repo.saveDashboardView({
      ...view,
      id,
      dashboardId: dashboard.id,
      spaceId: space.id,
      name: newName(list.map((v) => v.name)),
      position: Math.max(list.length, 1),
      isDefault: false,
      collapsed: base?.collapsed ?? NOTHING_COLLAPSED,
      ...(base?.filterBar && { filterBar: true as const }),
      ...(base?.fullWidth !== undefined && { fullWidth: base.fullWidth }),
      createdAt: ts,
      updatedAt: ts,
    });
    const next = await repo.listDashboardViews(dashboard.id, space.id);
    setSavedViews(next);
    selectView(id, next);
    setRenameRequest((r) => r + 1);
  }
  const addButton = (
    <IconButton autoAlign kind="ghost" size="sm" align="bottom" label="Add tab" onClick={() => addView().catch(fail)}>
      <Add />
    </IconButton>
  );
  const panels = usePanelsOpen();
  // As a collection view's: the Filter button moves to the filter bar, and the width changes, once the panels close.
  const filterInBar = panels.hold("filterInBar", !!active?.filterBar);
  const fullWidth = panels.hold("fullWidth", isFullWidth("dashboard", active?.fullWidth));

  async function updateActive() {
    const tab = await stored();
    if (!tab) return;
    await repo.saveDashboardView({ ...tab, ...view });
    await loadViews();
  }

  /** Arranging the tab (blocks added, removed, moved; a block's type, options, name, collections): stored right away. */
  async function arrange(change: (blocks: ViewBlock[]) => ViewBlock[], storedChange: (blocks: ViewBlock[]) => ViewBlock[] = change) {
    setView((v) => ({ ...v, blocks: change(v.blocks) }));
    if (!active) return;
    const blocks = storedChange(active.blocks);
    if (JSON.stringify(blocks) === JSON.stringify(active.blocks)) return;
    await storeNow({ blocks });
  }
  const arrangeNow = (change: (blocks: ViewBlock[]) => ViewBlock[], storedChange?: (blocks: ViewBlock[]) => ViewBlock[]) => arrange(change, storedChange).catch(fail);
  const setBlockNow = (id: string, patch: Partial<ViewBlock>) => arrangeNow((blocks) => blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const setBlock = (block: ViewBlock) => setView((v) => ({ ...v, blocks: v.blocks.map((b) => (b.id === block.id ? block : b)) }));
  // A new block lists the collection of the last block that has one (the next is often of the same), else the space's first.
  const lastCollection = [...view.blocks].reverse().map((b) => findCollection(collections, dashboardBlockCollection(b))).find((c) => c);
  const newBlockCollection = lastCollection ?? spaceCollections[0] ?? collections[0];
  const addBlock = (spec: NewBlockSpec) => {
    if (!newBlockCollection) return;
    const block = normalizeBlock(newBlockCollection, newDashboardBlock(spec.kind, spec.options ?? blockType(spec.kind).defaultOptions(newBlockCollection), newBlockCollection));
    arrangeNow((blocks) => [...blocks, block]);
  };
  const moveBlocks = (order: ViewBlock[]) => {
    const at = (b: ViewBlock) => order.findIndex((o) => o.id === b.id) >>> 0;
    arrangeNow(() => order, (blocks) => [...blocks].sort((a, b) => at(a) - at(b)));
  };
  const blockName = useBlockName();
  /** Removing blocks (a dashboard's tab may be left without any): asked first, unless asked already. */
  async function removeBlocks(ids: string[], asked = false) {
    const gone = view.blocks.filter((b) => ids.includes(b.id));
    if (gone.length === 0) return;
    const title = gone.length === 1 ? `Remove block “${blockName(gone[0])}”?` : `Remove ${gone.length} blocks?`;
    if (!asked && !(await confirm({ title, body: "Items are not affected." }))) return;
    await arrange((blocks) => blocks.filter((b) => !ids.includes(b.id)));
  }

  async function toggleDefault() {
    const tab = await stored();
    if (!tab) return;
    await repo.setDefaultDashboardView(dashboard.id, space.id, tab.isDefault ? null : tab.id);
    await loadViews();
  }

  async function renameActive(name: string) {
    if (!active || !name || name === active.name) return;
    await storeNow({ name });
  }

  async function deleteActive() {
    if (!active || !(await confirm({ title: `Delete tab “${active.name}”?`, body: "Items are not affected." }))) return;
    const tab = await stored();
    if (!tab) return;
    await repo.deleteDashboardView(tab.id);
    const rest = await repo.listDashboardViews(dashboard.id, space.id);
    setSavedViews(rest);
    selectView(defaultViewOf(rest), rest);
  }

  /** The dashboard's own settings (name, icon, description, spaces): stored at once. */
  const saveDashboard = (patch: Partial<Pick<Dashboard, "name" | "icon" | "description" | "spaceIds">>) =>
    repo.saveDashboard({ id: dashboard.id, name: dashboard.name, icon: dashboard.icon, description: dashboard.description, spaceIds: dashboard.spaceIds, ...patch }, space.id).catch(fail);

  async function deleteDashboard() {
    if (!(await confirm({ title: `Delete dashboard “${dashboard.name}”?`, body: "Its tabs go too, in every space. Items are not affected.", danger: true }))) return;
    await repo.deleteDashboard(dashboard.id);
    navigate("/dashboards");
  }

  // The collections the tab's blocks list: the filter is edited over their fields (with "Date": each block's own).
  const listed = useMemo(() => {
    const seen = new Map<string, Collection>();
    for (const b of view.blocks) for (const c of blockCollections(b, collections)) seen.set(c.id, c);
    return [...seen.values()];
  }, [view.blocks, collections]);
  const scope = useMemo(() => dashboardScope(listed), [listed]);
  const refs = useReferenceOptions(scope);
  const readsSource = listed.some(isRemote);

  const filterButton = (
    <ToolbarPopover label={view.filters.length > 0 ? `Filter (${view.filters.length})` : "Filter"} icon={Filter} width="wide" active={view.filters.length > 0} onOpenChange={panels.onOpenChange}>
      <QueryEditor
        collection={scope}
        query={{ filters: view.filters, sort: [], groupBy: null }}
        refs={refs}
        part="filter"
        emptyText="No filter: every block shows what its own filter lets through. A rule on Date applies to each block's first date field, a rule on a field to the blocks listing it."
        owners={listed}
        onChange={(q) => setView((v) => ({ ...v, filters: q.filters }))}
      />
    </ToolbarPopover>
  );

  const addBlockButton = <AddBlockButton disabled={!newBlockCollection} onAdd={addBlock} />;

  return (
    <div className={fullWidth ? "view-page" : "view-page view-page--narrow"}>
      <PageHeader
        current={dashboard.name}
        title={
          <Heading className="page-header__title title-with-icon">
            <CollectionIcon name={dashboardIcon(dashboard)} size={32} />
            {dashboard.name}
          </Heading>
        }
        subtitle={dashboard.description || undefined}
        breadcrumbs={[{ label: "Dashboards", href: "#/dashboards" }]}
        actions={
          <>
            <ToolbarPopover label="Dashboard settings" icon={Settings} width="narrow" openRequest={settingsRequest} onOpenChange={panels.onOpenChange}>
              <DashboardSettings dashboard={dashboard} spaces={spaces} nameInput={dashboardName} onSave={saveDashboard} />
            </ToolbarPopover>
            <IconButton autoAlign size="sm" kind="ghost" align="bottom" label="Delete dashboard" onClick={() => deleteDashboard().catch(fail)}>
              <TrashCan />
            </IconButton>
          </>
        }
      />
      {error && <InlineNotification kind="error" title="Error" subtitle={error} onClose={() => setError(undefined)} />}

      {savedViews !== null && (
        <div className="views-bar" ref={viewsBar}>
          <Tabs selectedIndex={active ? views.indexOf(active) : -1} onChange={({ selectedIndex }) => selectView(views[selectedIndex].id)}>
            <TabList aria-label="Tabs" className="views-tabs">
              {views.map((v) => (
                <Tab key={v.id}>
                  {v.name}
                  {changed && v.id === active?.id ? " *" : ""}
                </Tab>
              ))}
            </TabList>
          </Tabs>
          {clippedTabs && (
            <TabMenu label="Tabs" items={views.map((v) => ({ id: v.id, name: v.name + (changed && v.id === active?.id ? " *" : "") }))} activeId={active?.id} onSelect={selectView} />
          )}
          {!clippedTabs && <span className="tab-menu">{addButton}</span>}
          <span className="views-bar__spacer" />
          {panels.hold("changed", changed) && active && (
            <IconButton autoAlign kind="ghost" size="sm" align="bottom" label="Save changes to tab" onClick={() => updateActive().catch(fail)}>
              <Save />
            </IconButton>
          )}
          <OverflowBar>
            {clippedTabs && addButton}
            {active && views.length > 1 && (
              <IconButton autoAlign kind="ghost" size="sm" align="bottom" label="Delete tab" onClick={() => deleteActive().catch(fail)}>
                <TrashCan />
              </IconButton>
            )}
            {active && views.length > 1 && (
              <IconButton
                autoAlign
                kind="ghost"
                size="sm"
                align="bottom"
                label={active.isDefault ? "Revert default tab" : "Star as default tab"}
                aria-pressed={active.isDefault}
                onClick={() => toggleDefault().catch(fail)}
              >
                {active.isDefault ? <StarFilled /> : <Star />}
              </IconButton>
            )}
            {active && (
              <BookmarkButton
                kind="dashboard"
                ownerId={dashboard.id}
                targetId={active.id}
                // A virtual tab is stored first: a bookmark needs a real one.
                prepare={active.virtual ? () => stored().then((t) => t?.id) : undefined}
                label={`${dashboard.name} / ${active.name}`}
                onError={fail}
              />
            )}
            {readsSource && (
              <IconButton autoAlign kind="ghost" size="sm" align="bottom" label="Read the remote collections again" onClick={() => sources.refresh(null)}>
                <Renew />
              </IconButton>
            )}
            <IconButton
              autoAlign
              kind="ghost"
              size="sm"
              align="bottom"
              label={searchOpen ? "Close search" : `Search ${dashboard.name}`}
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
            {!filterInBar && filterButton}
            <ToolbarPopover label="Tab settings" icon={SettingsAdjust} width="narrow" openRequest={renameRequest} onOpenChange={panels.onOpenChange}>
              <div className="view-settings">
                {active && (
                  <TextInput
                    size="sm"
                    key={active.id + active.name}
                    id={`${uid}-tab-rename`}
                    ref={nameInput}
                    labelText="Tab name"
                    defaultValue={active.name}
                    onBlur={(e) => renameActive(e.target.value.trim()).catch(fail)}
                    onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                  />
                )}
                {active && (
                  <Checkbox
                    id={`${uid}-tab-filter-bar`}
                    labelText="Show filter bar"
                    checked={!!active.filterBar}
                    onChange={(_, { checked }) => storeNow(checked ? { filterBar: true } : { filterBar: undefined }).catch(fail)}
                  />
                )}
                {active && (
                  <Checkbox id={`${uid}-tab-full-width`} labelText="Full width" checked={isFullWidth("dashboard", active.fullWidth)} onChange={(_, { checked }) => storeNow({ fullWidth: checked }).catch(fail)} />
                )}
                <Checkbox id={`${uid}-tab-editable`} labelText="Fields are editable" checked={view.editable} onChange={(_, { checked }) => setView((v) => ({ ...v, editable: checked }))} />
                <BlockListEditor
                  blocks={view.blocks}
                  keepOne={false}
                  addDisabled={!newBlockCollection}
                  onMove={moveBlocks}
                  onRemove={(ids, asked) => removeBlocks(ids, asked).catch(fail)}
                  onAdd={addBlock}
                  onHeader={(id, shownHeader) => setBlockNow(id, { hideHeader: shownHeader ? undefined : true })}
                />
              </div>
            </ToolbarPopover>
          </OverflowBar>
        </div>
      )}

      {savedViews !== null && (active?.filterBar || filterInBar) && (
        <FilterBar collection={scope} filters={view.filters} onChange={(filters) => setView((v) => ({ ...v, filters }))}>
          {filterInBar && filterButton}
        </FilterBar>
      )}

      {searchOpen && (
        <div className="items-search">
          <Search
            id={`${uid}-items-search`}
            size="sm"
            autoFocus
            labelText={`Search ${dashboard.name}`}
            placeholder={`Search ${dashboard.name}`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && !search && setSearchOpen(false)}
            onBlur={() => !search && setSearchOpen(false)}
          />
        </div>
      )}

      {/* A tab without blocks says what it is for, with Add block (none without a collection to list). */}
      {savedViews !== null && viewChosen && view.blocks.length === 0 && (
        <Tile className="empty-state">
          <p>{newBlockCollection ? "No blocks yet. A block shows the items of one collection, or of several read as one." : "No collections yet: a block shows a collection's items. Add a collection first."}</p>
          {addBlockButton}
        </Tile>
      )}

      {savedViews !== null &&
        viewChosen &&
        view.blocks.map((block) => (
          <DashboardBlock
            key={`${activeId ?? ""}-${block.id}`}
            block={block}
            filters={view.filters}
            search={searched}
            editable={view.editable}
            collapsed={active?.collapsed ?? NOTHING_COLLAPSED}
            onCollapse={(next) => storeNow({ collapsed: next }).catch(fail)}
            onChange={setBlock}
            onSet={(patch) => setBlockNow(block.id, patch)}
            onRemove={() => removeBlocks([block.id]).catch(fail)}
            onError={setError}
            onOpenChange={panels.onOpenChange}
          />
        ))}

      {dialog}
    </div>
  );
}

/** The dashboard's name, icon, description and spaces (Dashboard settings), each stored once it is set (a text when left). */
function DashboardSettings({
  dashboard,
  spaces,
  nameInput,
  onSave,
}: {
  dashboard: Dashboard;
  spaces: Space[];
  nameInput: React.RefObject<HTMLInputElement | null>;
  onSave(patch: Partial<Pick<Dashboard, "name" | "icon" | "description" | "spaceIds">>): void;
}) {
  const uid = useId();
  return (
    <div className="view-settings">
      {/* Its icon and name, side by side as in the collection editor's header. */}
      <div className="dashboard-settings__name">
        <IconPicker id={`${uid}-icon`} size={16} value={dashboard.icon ?? DASHBOARD_ICON} onChange={(icon) => onSave({ icon })} />
        <TextInput
          size="sm"
          key={dashboard.name}
          id={`${uid}-name`}
          ref={nameInput}
          labelText="Name"
          defaultValue={dashboard.name}
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (name && name !== dashboard.name) onSave({ name });
            else e.target.value = dashboard.name;
          }}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      </div>
      <TextArea
        key={dashboard.description}
        id={`${uid}-description`}
        labelText="Description (optional)"
        rows={2}
        defaultValue={dashboard.description}
        onBlur={(e) => e.target.value.trim() !== dashboard.description && onSave({ description: e.target.value.trim() })}
      />
      {/* Where it shows: every space unless some are chosen (its tabs are per space, the items each space's own). */}
      {spaces.length > 1 && (
        <MultiSelect<Space>
          autoAlign
          id={`${uid}-spaces`}
          size="sm"
          titleText="Spaces"
          label={dashboard.spaceIds === null ? "All spaces" : spaces.filter((s) => dashboard.spaceIds!.includes(s.id)).map((s) => s.name).join(", ")}
          helperText="Shown in every space while none is chosen."
          items={spaces}
          itemToString={(s) => s?.name ?? ""}
          itemToElement={(s) => <SpaceLabel space={s} />}
          selectedItems={spaces.filter((s) => dashboard.spaceIds?.includes(s.id))}
          onChange={({ selectedItems }) => onSave({ spaceIds: selectedItems && selectedItems.length > 0 ? selectedItems.map((s) => s.id) : null })}
        />
      )}
    </div>
  );
}

interface BlockProps {
  block: ViewBlock;
  /** The tab's filter, whole: BlockView gives the block the rules it can take (dashboardFiltersFor). */
  filters: ViewState["filters"];
  search: string;
  editable: boolean;
  collapsed: Collapsed;
  onCollapse(collapsed: Collapsed): void;
  onChange(block: ViewBlock): void;
  onSet(patch: Partial<ViewBlock>): void;
  onRemove(): void;
  onError(message: string): void;
  onOpenChange(open: boolean): void;
}

/** A block of a dashboard: its (first remaining) collection's, or a warning when the collections it listed are gone. */
function DashboardBlock(props: BlockProps) {
  const { collections } = useStore();
  const home = blockCollections(props.block, collections)[0];
  if (!home) {
    return (
      <section className="block" data-block-id={props.block.id}>
        <InlineNotification kind="warning" title="Block without collection" subtitle="The collection this block listed was deleted." onClose={props.onRemove} />
      </section>
    );
  }
  return <DashboardBlockContent key={home.id} home={home} {...props} />;
}

function DashboardBlockContent({ home, block, filters, search, editable, collapsed, onCollapse, onChange, onSet, onRemove, onError, onOpenChange }: BlockProps & { home: Collection }) {
  const { collections } = useStore();
  const data = useCollectionData(home);
  const normalized = useMemo(() => normalizeBlock(home, block, collections), [home, block, collections]);
  return (
    <BlockView
      collection={home}
      data={data}
      block={normalized}
      viewFilters={filters}
      search={search}
      place="dashboard"
      page={null}
      editable={editable}
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
