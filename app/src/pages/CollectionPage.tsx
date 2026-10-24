import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { Dropdown, Heading, IconButton, InlineNotification, Search, Tab, TabList, Tabs, TextInput } from "@carbon/react";
import { Add, ArrowsVertical, Filter, Save, SettingsAdjust, Star, StarFilled, TrashCan, Undo } from "@carbon/icons-react";
import { useStore, useCollection } from "../app/store";
import { useDataChanges } from "../app/useDataChanges";
import { useItems } from "../app/useItems";
import { nextName, newName, now, labelField, itemLabel, newId, isReferenceKind, type FieldValue, type Item, type Collection } from "../domain/model";
import { withComputed } from "../domain/components";
import { applyQuery, groupPreset, type QueryContext, type ViewQuery } from "../domain/query";
import { defaultViewState, sameView, type CollectionView, type ViewState } from "../domain/views";
import { NotFound } from "../ui/NotFound";
import { CollectionIcon } from "../ui/collectionIcons";
import { BookmarkButton } from "../ui/BookmarkButton";
import { NewButton } from "../ui/NewButton";
import { PageHeader } from "../ui/PageHeader";
import { errorMessage, useConfirm } from "../ui/useConfirm";
import { refLabelOf, useReferenceOptions } from "../ui/useReferenceOptions";
import { VIEW_TYPES, viewType, type ItemActions, type ViewTypeDefinition } from "../views";
import { QueryEditor } from "../views/QueryEditor";
import { ToolbarPopover, usePanelsOpen } from "../ui/ToolbarPopover";
import { useOpenRelated } from "../workspace/Workspace";

export function CollectionPage() {
  const { collectionId } = useParams();
  const collection = useCollection(collectionId);
  if (!collection) return <NotFound />;
  return <CollectionContent key={collection.id} collection={collection} />;
}

/** A view type with its icon, as shown in the view dropdown. */
function ViewKindLabel({ kind }: { kind: ViewTypeDefinition }) {
  return (
    <span className="view-kind">
      <kind.icon />
      {kind.label}
    </span>
  );
}

/** A view state with options validated for this collection (stored options may be outdated). */
function normalized(collection: Collection, state: ViewState): ViewState {
  return { ...state, options: viewType(state.kind).normalizeOptions(state.options, collection) };
}

function CollectionContent({ collection }: { collection: Collection }) {
  // Element ids unique per instance: the same page can be open in several tabs.
  const uid = useId();
  const { repo, components, cache, space } = useStore();
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();
  const refs = useReferenceOptions(collection);
  const openRelated = useOpenRelated();
  // The collection's items, shared with every other pane showing them and current from the change feed.
  const { items: items, error: loadError } = useItems(collection);
  const [savedViews, setSavedViews] = useState<CollectionView[] | null>(null); // null = loading
  const [error, setError] = useState<string>();

  // The view currently shown. Changes are ephemeral until saved as / into a saved view. Every
  // collection starts with an ordinary saved "All" view; `base` is only shown once all are deleted.
  const base = useMemo(() => normalized(collection, defaultViewState(viewType("table").defaultOptions(collection))), [collection]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<ViewState>(base);
  const [search, setSearch] = useState("");
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
      repo.listViews(collection.id).then((list) => {
        setSavedViews(list);
        // A shown view without unsaved changes follows its stored settings when they change
        // elsewhere, instead of turning into "changed".
        const cur = shown.current;
        const next = cur?.activeId ? list.find((v) => v.id === cur.activeId) : undefined;
        if (cur && next && sameView(cur.view, cur.reference)) setView(normalized(collection, next));
      }, (e) => setError(errorMessage(e))),
    [repo, collection],
  );
  useEffect(() => {
    loadViews();
  }, [loadViews]);
  // Opening the page shows the starred view, else the first — once, when the views have loaded.
  const openedDefault = useRef(false);
  // Views changed elsewhere (another pane) show up here too; items arrive through useItems.
  useDataChanges((change) => {
    if (change.scope === "views" && change.collectionId === collection.id) loadViews();
  });

  const views = savedViews ?? [];
  const active = views.find((v) => v.id === activeId) ?? null;
  const reference = active ? normalized(collection, active) : base;
  const changed = !sameView(view, reference);
  shown.current = { activeId, view, reference };

  // Until the referenced items' labels are in, a reference would read as "(deleted)" (in
  // groups, sorting, filters): the list waits for them.
  const refsLoading = collection.fields.some((f) => isReferenceKind(f.kind) && f.targetCollectionId && !refs[f.targetCollectionId]);
  const ctx: QueryContext = useMemo(
    () => ({ refLabel: refLabelOf(refs, "(deleted)") }),
    [refs],
  );
  // Component fields are computed here, so views, filters, sorting and grouping see their results.
  // Each item is computed once: only items that changed are computed again.
  const computedMemo = useMemo(() => new WeakMap<Item, Item>(), [collection, components, ctx]);
  const computed = useMemo(
    () => withComputed(collection, items ?? [], components, ctx.refLabel, computedMemo),
    [collection, items, components, ctx, computedMemo],
  );
  const result = useMemo(() => applyQuery(collection, computed, view.query, ctx, search), [collection, computed, view.query, ctx, search]);

  const setQuery = (query: ViewQuery) => setView((v) => ({ ...v, query }));
  const selectView = useCallback(
    (id: string | null, list: CollectionView[] = savedViews ?? []) => {
      const next = list.find((v) => v.id === id);
      setActiveId(next ? next.id : null);
      setView(next ? normalized(collection, next) : base);
    },
    [savedViews, collection, base],
  );
  /** The view a collection opens with: the starred one, else the first, else none (unsaved). */
  const defaultViewOf = (list: CollectionView[]) => (list.find((v) => v.isDefault) ?? list[0])?.id ?? null;
  // Before paint, so the first view never flashes ahead of the starred one.
  // A bookmark opens a particular view (?view=…), also when this page is already showing.
  const [params] = useSearchParams();
  const wanted = params.get("view");
  useLayoutEffect(() => {
    if (openedDefault.current || savedViews === null) return;
    openedDefault.current = true;
    selectView(wanted && savedViews.some((v) => v.id === wanted) ? wanted : defaultViewOf(savedViews), savedViews);
  }, [savedViews, selectView, wanted]);
  useEffect(() => {
    if (openedDefault.current && wanted && savedViews?.some((v) => v.id === wanted)) selectView(wanted);
    // Only when the requested view changes, not on every edit of the views.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);

  async function saveAsNew(name: string, state: ViewState = view) {
    const id = newId();
    const ts = now();
    await repo.saveView({ ...state, id, collectionId: collection.id, name, position: views.length, isDefault: false, createdAt: ts, updatedAt: ts });
    const list = await repo.listViews(collection.id);
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
  /** With one view and nothing unsaved there is nothing to choose or save: no tab bar ("+" then sits in the toolbar). */
  // Held while a toolbar panel is open: the bar appearing would move the panel's button.
  const panels = usePanelsOpen();
  const showBar = panels.hold("bar", savedViews !== null && (views.length > 1 || changed));

  async function updateActive() {
    if (!active) return;
    await repo.saveView({ ...active, kind: view.kind, query: view.query, options: view.options });
    await loadViews();
  }

  /** Star the active view as the default, or unstar it (then the first view opens by default). */
  async function toggleDefault() {
    if (!active) return;
    await repo.setDefaultView(collection.id, active.isDefault ? null : active.id);
    await loadViews();
  }

  async function renameActive(name: string) {
    if (!active || !name || name === active.name) return;
    await repo.saveView({ ...active, name });
    await loadViews();
  }

  async function deleteActive() {
    if (!active || !(await confirm({ title: `Delete view “${active.name}”?`, body: "Items are not affected." }))) return;
    await repo.deleteView(active.id);
    const rest = await repo.listViews(collection.id);
    setSavedViews(rest);
    selectView(defaultViewOf(rest), rest);
  }

  const current: ItemActions = {
    open: (item, mode, o) => openRelated(`/collections/${collection.id}/items/${item.id}${o?.edit ? "?edit=1" : ""}`, mode),
    async remove(item) {
      if (!(await confirm({ title: `Delete ${collection.name}?`, body: `This ${collection.name} will be removed.` }))) return;
      try {
        await repo.deleteItem(item.id); // the list hears the change and drops it
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    /**
     * A copy with the item's stored values (not computed ones: component fields, rendered {{ }}
     * sections keep their source); its title numbered. Images are shared (files are immutable).
     */
    async duplicate(item) {
      const stored = items?.find((e) => e.id === item.id) ?? item;
      const values: Record<string, FieldValue> = {};
      for (const f of collection.fields) {
        const v = stored.values[f.id];
        if (f.kind !== "component" && v != null) values[f.id] = v;
      }
      const title = labelField(collection, stored);
      if (title) values[title.id] = nextName(String(stored.values[title.id]), (items ?? []).map((e) => itemLabel(collection, e)));
      try {
        await repo.createItem(collection, values, space.id); // the list hears the change and adds it
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    /** Optimistic update, then save (reload on failure). */
    async setValue(item, field, value: FieldValue) {
      cache.items.patch(collection.id, item.id, (o) => ({ ...o, values: { ...o.values, [field.id]: value } }));
      try {
        await repo.updateItem(collection, item.id, { [field.id]: value });
      } catch (e) {
        setError(errorMessage(e));
        cache.items.reload(collection.id);
      }
    },
    async create(values) {
      // Shown before the add row closes (waits for the reload the change event started, else reloads).
      const id = await repo.createItem(collection, values, space.id);
      await cache.items.settled(collection.id, id);
    },
    groupPreset: (key) => groupPreset(collection, view.query, key),
    groupBy: view.query.groupBy,
    sort: view.query.sort[0],
    sortBy(fieldId) {
      const current = view.query.sort[0];
      const direction = current?.fieldId === fieldId && current.direction === "asc" ? "desc" : "asc";
      setQuery({ ...view.query, sort: [{ fieldId, direction }] });
    },
  };
  // What the views get keeps its identity (each call goes to the latest `current`), so rows that
  // didn't change aren't rendered again; it changes only with the sort, which reorders them anyway,
  // and the grouping, which regroups them.
  const latest = useRef(current);
  latest.current = current;
  const sort = view.query.sort[0];
  const groupBy = view.query.groupBy;
  const actions = useMemo<ItemActions>(
    () => ({
      open: (item, mode, options) => latest.current.open(item, mode, options),
      remove: (item) => latest.current.remove(item),
      duplicate: (item) => latest.current.duplicate?.(item),
      setValue: (item, field, value) => latest.current.setValue(item, field, value),
      create: (values) => latest.current.create!(values),
      groupPreset: (key) => latest.current.groupPreset!(key),
      groupBy,
      sort,
      sortBy: (fieldId) => latest.current.sortBy!(fieldId),
    }),
    [sort, groupBy],
  );

  const vt = viewType(view.kind);

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
        subtitle={collection.description || undefined}
        breadcrumbs={[{ label: "Collections", href: "#/collections" }]}
        actions={
          // Like "New collection" and "New component": the page's main action, in its header.
          <NewButton label={`New ${collection.name}`} onClick={() => navigate(`/collections/${collection.id}/items/new`)} />
        }
      />
      {(error ?? loadError) && <InlineNotification kind="error" title="Error" subtitle={error ?? loadError} onClose={() => setError(undefined)} />}

      {/* Saved views (a new collection gets "All"); the starred one, else the first, opens by default.
          Unsaved changes to the shown view surface as icon buttons beside its star. */}
      {/* With one view and nothing unsaved there is nothing to choose or save: no tab bar. */}
      {showBar && (
        <div className="views-bar">
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
          {addButton}
          <span className="views-bar__spacer" />
          {changed && active && (
            <>
              <IconButton autoAlign kind="ghost" size="sm" align="bottom" label="Discard changes" onClick={() => selectView(active.id)}>
                <Undo />
              </IconButton>
              <IconButton autoAlign kind="ghost" size="sm" align="bottom" label="Save changes to view" onClick={() => updateActive().catch((e) => setError(errorMessage(e)))}>
                <Save />
              </IconButton>
            </>
          )}
          {/* The last view can't be deleted: a collection always keeps one. */}
          {active && views.length > 1 && (
            <IconButton autoAlign kind="ghost" size="sm" align="bottom" label="Delete view" onClick={() => deleteActive().catch((e) => setError(errorMessage(e)))}>
              <TrashCan />
            </IconButton>
          )}
          {active && (
            <BookmarkButton
              kind="view"
              collectionId={collection.id}
              targetId={active.id}
              label={`${collection.pluralName} / ${active.name}`}
              onError={(e) => setError(errorMessage(e))}
            />
          )}
          {/* With one view there's nothing to choose: it opens anyway. */}
          {active && views.length > 1 && (
            <IconButton autoAlign
              kind="ghost"
              size="sm"
              align="bottom-end"
              label={active.isDefault ? "Revert default view" : "Star as default view"}
              aria-pressed={active.isDefault}
              onClick={() => toggleDefault().catch((e) => setError(errorMessage(e)))}
            >
              {active.isDefault ? <StarFilled /> : <Star />}
            </IconButton>
          )}
        </div>
      )}

      <div className="items-toolbar">
        <Search
          id={`${uid}-items-search`}
          size="sm"
          labelText={`Search ${collection.pluralName}`}
          placeholder="Search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {/* Each opens its settings in a popover; selected = in use. */}
        <ToolbarPopover
          label={view.query.filters.length > 0 ? `Filter (${view.query.filters.length})` : "Filter"}
          icon={Filter}
          active={view.query.filters.length > 0}
          onOpenChange={panels.onOpenChange}
        >
          <QueryEditor collection={collection} query={view.query} refs={refs} part="filter" onChange={setQuery} />
        </ToolbarPopover>
        <ToolbarPopover label="Sort and group" icon={ArrowsVertical} active={view.query.groupBy !== null} onOpenChange={panels.onOpenChange}>
          <QueryEditor collection={collection} query={view.query} refs={refs} part="sortGroup" onChange={setQuery} />
        </ToolbarPopover>
        <ToolbarPopover label="View settings" icon={SettingsAdjust} openRequest={renameRequest} onOpenChange={panels.onOpenChange}>
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
            {/* A dropdown, not a switch: it lists every registered view type, however many there are. */}
            <Dropdown<ViewTypeDefinition> autoAlign
              size="sm"
              id={`${uid}-view-kind`}
              titleText="View type"
              label="View"
              items={VIEW_TYPES}
              selectedItem={vt}
              itemToString={(t) => t?.label ?? ""}
              itemToElement={(t) => <ViewKindLabel kind={t} />}
              renderSelectedItem={(t) => <ViewKindLabel kind={t} />}
              onChange={({ selectedItem: next }) => {
                if (next) setView((v) => {
                  // The field selection and order carry over to the other view type.
                  const fields = viewType(v.kind).fieldsOf(v.options);
                  return { ...v, kind: next.kind, options: next.withFields(next.defaultOptions(collection), fields) };
                });
              }}
            />
            {vt.OptionsEditor && <vt.OptionsEditor collection={collection} options={view.options} onChange={(options) => setView((v) => ({ ...v, options }))} />}
          </div>
        </ToolbarPopover>
        {!showBar && savedViews !== null && addButton}
      </div>


      {/* Nothing until everything is in (a fraction of a second): a placeholder table would only
          flash, shaped unlike the real one. */}
      {items !== null && savedViews !== null && !refsLoading && (
        // Keyed by the shown view so group collapse state isn't carried over to another view.
        <vt.View key={activeId ?? ""} collection={collection} result={result} options={view.options} refs={refs} search={search} actions={actions} />
      )}

      {dialog}
    </>
  );
}
