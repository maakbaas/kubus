import { useEffect, useId, useMemo, useState, type DragEvent } from "react";
import { Button, Checkbox, Dropdown, InlineNotification, MultiSelect, NumberInput, Select, SelectItem, TextInput } from "@carbon/react";
import { ArrowsVertical, Filter, ListChecked, Save, Settings, TrashCan } from "@carbon/icons-react";
import { useStore } from "../app/store";
import { groupsInApp, isReadOnly } from "../domain/sources";
import { BACKLINKS_FIELDS, VIRTUAL_COLLECTIONS } from "../domain/backlinks";
import { orderFields } from "../domain/fieldLayout";
import { newId, pickableFields, titleFields, type Collection } from "../domain/model";
import { placeProblem } from "../domain/components";
import { PromoteComponentModal } from "../ui/PromoteComponentModal";
import type { MarkdownBlockOptions } from "./MarkdownBlock";
import type { ComponentBlockOptions } from "./ComponentBlock";
import { applyQuery, filterPreset, PAGE_ITEM, resolveFilterValues, type FilterRule, type ItemGroup, type QueryResult } from "../domain/query";
import { blockSort, isDefaultBlockSort } from "../domain/blockSort";
import { BLOCK_HEIGHT, blockLimit, blockQuery, DEFAULT_ASPECT, listedCollection, NO_FILTERS, collapsedGroups, newBlock, withBlockCollapsed, withGroupCollapsed, withQuery, type Collapsed, type ViewBlock } from "../domain/views";
import { CollectionIcon } from "../ui/collectionIcons";
import { FieldOrderEditor } from "../ui/FieldOrderEditor";
import { LoadingBar } from "../ui/LoadingBar";
import { ToolbarPopover } from "../ui/ToolbarPopover";
import { SectionHeader } from "../ui/SectionHeader";
import { useConfirm } from "../ui/useConfirm";
import type { RefOptions } from "../ui/useReferenceOptions";
import { BLOCK_TYPES, blockType, carryOptions, normalizeBlock, type BlockPlace, type BlockTypeDefinition, type PageItem } from ".";
import { QueryEditor } from "./QueryEditor";
import type { CollectionData } from "./useCollectionData";
import { useItemActions } from "./useItemActions";
import { useRemoteResult } from "./useRemoteResult";
import { useMergedResult } from "./useMergedResult";
import { useBlockName } from "./BlockListEditor";
import { useShownOnce } from "../ui/useShownOnce";
import { MergeFields } from "./MergeFields";
import { dashboardFiltersFor } from "../domain/dashboards";
import { ROW_HEIGHT } from "../domain/blockRows";
import type { RowControls } from "./BlockRows";

// One block: a collection's items shown one way (its block type), with its own sort, grouping,
// and fields, and the view's filter unless it has its own. Collection views, item pages and
// dashboards render their blocks with BlockView; BlockMenus in each block's header edits it (also when
// a view has a single block: the toolbar holds only the view's own controls).

const NO_RESULT: QueryResult = { groups: [], total: 0 };

/** A block type with its icon, as shown in the "Show as" menu. */
function BlockKindLabel({ kind }: { kind: BlockTypeDefinition }) {
  return (
    <span className="view-kind">
      <kind.icon />
      {kind.label}
    </span>
  );
}

/**
 * A new block for an item page listing `target`: when one of its reference fields points at the
 * page's collection, filtered to the items referring to the page's item ("Books by this
 * Author"); a new item added there refers to it too.
 */
export function newPageBlock(target: Collection, page: Collection, spec?: { kind: string; options?: unknown }): ViewBlock {
  const link = target.fields.find((f) => (f.kind === "item" || f.kind === "item_list") && f.targetCollectionId === page.id);
  const filters: FilterRule[] = link ? [{ id: newId(), fieldId: link.id, operator: "is", value: PAGE_ITEM }] : [];
  const kind = spec?.kind ?? "table";
  const block = { ...newBlock(kind, spec?.options ?? blockType(kind).defaultOptions(target)), collectionId: target.id, filters };
  // The Backlinks collection starts with the fields that tell something (the title already is the link).
  return normalizeBlock(target, target.virtual === "backlinks" ? { ...block, layout: { ...block.layout, fields: BACKLINKS_FIELDS } } : block);
}

/** A collection in the Collection(s) picker, with its icon. */
function CollectionChoiceLabel({ collection }: { collection: Collection }) {
  return (
    <span className="view-kind">
      <CollectionIcon name={collection.icon} />
      {collection.pluralName}
    </span>
  );
}

/** In its type's default order (by title; a chart or map: by time), not grouped (where grouping applies): what every block starts with. */
const isDefaultSort = (block: ViewBlock, collection: Collection, grouped: boolean) =>
  (!grouped || block.groupBy === null) && isDefaultBlockSort(block, collection);

interface MenusProps {
  /** The collection the block reads: its own, or on a dashboard the one several chosen are read as (domain/mergedCollection.ts). */
  collection: Collection;
  /** The collection the block starts from: the view's, an item page block's own, or a dashboard block's (first). */
  home: Collection;
  block: ViewBlock;
  refs: RefOptions;
  /** The block's items as it shows them, for its type's settings. */
  result?: QueryResult;
  place: BlockPlace;
  /** The filter the block builds on: its view's, or its item page's (that page's rules for its collection). */
  viewFilters: FilterRule[] | null;
  /** On an item page: its collection (filter values "this item"), and choosing the listed collection. */
  page?: Collection;
  /** What changes the shown items (filter, sort, grouping, fields): a change to save. */
  onChange(block: ViewBlock): void;
  /** What arranges the view (type, its options, name, the listed collection): stored right away. */
  onSet(patch: Partial<ViewBlock>): void;
  onRemove?(): void;
  onError?(message: string): void;
  onOpenChange?(open: boolean): void;
  /** Its place in a row (Block settings: beside the block above, the row's max height); absent where blocks have no rows. */
  row?: RowControls;
}

/** A block's menus: Filter, Sort and group, Fields (each where its block type uses it), and its type's settings. */
export function BlockMenus({ collection, home, block, refs, result, place, viewFilters, page, onChange, onSet, onRemove, onOpenChange, row }: MenusProps) {
  const uid = useId();
  const { components, collections } = useStore();
  // The virtual collections (Backlinks) are listed only here, among the page's block collections.
  // The Backlinks collection can't be read together with others (its rows depend on the page's item).
  const pageCollections = useMemo(() => (page ? [...collections, ...VIRTUAL_COLLECTIONS] : collections), [collections, page]);
  const dashboard = place === "dashboard";
  // Several collections in one block are a dashboard's: elsewhere a block lists one.
  const chosen = useMemo(
    () => ((dashboard && block.collectionIds) || [block.collectionId ?? home.id]).flatMap((id) => pageCollections.filter((c) => c.id === id)),
    [dashboard, block.collectionIds, block.collectionId, home.id, pageCollections],
  );
  const merged = dashboard && chosen.length > 1;
  // A Markdown block's text is its own static component: promoted, it becomes a shared one (named
  // like the block), which the block then shows as a component block: the same text, now reusable
  // elsewhere and edited in the component editor.
  const [promoting, setPromoting] = useState(false);
  const markdown = block.kind === "markdown" ? (block.options as MarkdownBlockOptions).text : null;
  const markdownLocal = markdown === null ? null : { code: markdown, output: "markdown" as const, frameRatio: null, ai: false };
  const blockName = useBlockName();
  const type = blockType(block.kind);
  const uses = type.uses(block.options, components);
  const query = blockQuery(viewFilters, block, blockSort(block, collection));
  // A block always builds on its view's (or item page's) filter; its own rules are marked blue.
  const filterCount = query.filters.length;
  const inherits = place === "item" ? "the page's" : place === "dashboard" ? "the dashboard's" : "the view's";
  /**
   * The collections the block lists now (an item page's block: one, Backlinks too; a dashboard's: one or several): other
   * collections' fields and filter don't apply, so it starts afresh (linked to the page's item where it can be).
   */
  const pick = (list: Collection[]) => {
    // Escape clears a Carbon multi-select: a block always lists at least one collection.
    if (list.length === 0 || (list.length === chosen.length && list.every((c) => chosen.some((x) => x.id === c.id)))) return;
    const ids = list.map((c) => c.id);
    // The block keeps its type and the options that still apply (fields found again by name).
    const keep = (to: Collection) => ({ kind: type.kind, options: carryOptions(block.options, collection, to) });
    // On a dashboard there is no page's item to link to: a plain block of the collection (down to one: a plain block of it).
    const start = (to: Collection) => (page ? newPageBlock(to, page, keep(to)) : normalizeBlock(to, newBlock(type.kind, keep(to).options)));
    if (list.length === 1) {
      const { id: _id, title: _title, ...fresh } = start(list[0]);
      onSet({ ...fresh, collectionId: list[0].id, collectionIds: undefined, merges: undefined, groupOrder: undefined, groupDate: undefined });
      return;
    }
    const { collection: read } = listedCollection(home, { collectionIds: ids }, collections);
    const { id: _id, title: _title, ...fresh } = start(read);
    onSet({ ...fresh, collectionId: ids[0], collectionIds: ids, merges: undefined, groupOrder: undefined, groupDate: undefined });
  };
  const limit = blockLimit(block, !!uses.all);
  // Its type's own Limit is kept as none (it follows the type), any other as itself.
  const setLimit = (n: number) => {
    const { limit: _old, ...rest } = block;
    onChange(n === blockLimit({}, !!uses.all) ? rest : { ...rest, limit: n });
  };
  return (
    <>
      {uses.query && (
        <ToolbarPopover
          label={filterCount > 0 ? `Filter (${filterCount})` : "Filter"}
          icon={Filter}
          width="wide"
          active={filterCount > 0 || block.limit !== undefined}
          onOpenChange={onOpenChange}
        >
          <QueryEditor
            collection={collection}
            query={query}
            refs={refs}
            part="filter"
            page={page}
            emptyText={query.inherited?.length ? `Only ${inherits} filter. A rule joined with And narrows it, with Or lets more items in.` : undefined}
            onChange={(q) => onChange({ ...block, filters: q.filters.length > 0 ? q.filters : null })}
            footer={
              // How many items it shows at first and each Show more adds (empty: all).
              <div className="block-limit">
                <span>Show</span>
                <NumberInput
                  size="sm"
                  id={`${uid}-limit`}
                  label="Items shown at a time"
                  hideLabel
                  placeholder="all"
                  allowEmpty
                  hideSteppers
                  min={0}
                  value={limit === 0 ? "" : limit}
                  onChange={(_, { value }) => {
                    const n = String(value ?? "").trim() === "" ? 0 : Number(value);
                    if (Number.isInteger(n) && n >= 0) setLimit(n);
                  }}
                />
                <span>items at a time</span>
              </div>
            }
          />
        </ToolbarPopover>
      )}
      {uses.query && (
        <ToolbarPopover label={uses.groups ? "Sort and group" : "Sort"} icon={ArrowsVertical} active={!isDefaultSort(block, collection, uses.groups)} onOpenChange={onOpenChange}>
          <QueryEditor collection={collection} query={query} refs={refs} part="sortGroup" noGroup={!uses.groups} onChange={(q) => onChange(withQuery(block, q, query.sort))} />
        </ToolbarPopover>
      )}
      {uses.fields && (
        <ToolbarPopover label="Fields" icon={ListChecked} width="narrow" onOpenChange={onOpenChange}>
          <div className="view-settings">
            {uses.fields.hideEmpty && (
              <div className="view-options__checks">
                <Checkbox
                  id={`${uid}-hide-empty`}
                  labelText="Hide empty fields"
                  checked={block.layout.hideEmpty}
                  onChange={(_, { checked }) => onChange({ ...block, layout: { ...block.layout, hideEmpty: checked } })}
                />
              </div>
            )}
            {merged && <MergeFields block={block} parts={chosen} onSet={onSet} />}
            <FieldOrderEditor
              id={`${uid}-fields`}
              label="Fields"
              fields={pickableFields(collection)}
              collection={collection}
              value={block.layout.fields}
              onChange={(fields) => onChange({ ...block, layout: { ...block.layout, fields } })}
              {...(uses.fields.labels && {
                hiddenLabels: block.layout.hiddenLabels,
                onHiddenLabelsChange: (hiddenLabels: string[]) => onChange({ ...block, layout: { ...block.layout, hiddenLabels } }),
              })}
            />
          </div>
        </ToolbarPopover>
      )}
      {/* A gear, not the type's icon: this is also where the type is switched. */}
      <ToolbarPopover label="Block settings" icon={Settings} width="narrow" onOpenChange={onOpenChange}>
        <div className="view-settings">
          {/* On a dashboard: one collection, or several read as one (native and remote ones mixed; their fields of one name
              are one column). An item page's block picks one (Backlinks too); a collection view's lists the view's own. */}
          {dashboard && (
            <MultiSelect<Collection>
              autoAlign
              size="sm"
              id={`${uid}-collection`}
              className="multi-select--keep-one"
              clearSelectionText="A block always lists at least one collection"
              titleText="Collections"
              label={chosen.map((c) => c.pluralName).join(", ") || "Collections"}
              items={pageCollections}
              selectedItems={chosen}
              itemToString={(c) => c?.pluralName ?? ""}
              itemToElement={(c) => <CollectionChoiceLabel collection={c} />}
              onChange={({ selectedItems }) => pick(selectedItems ?? [])}
            />
          )}
          {page && (
            <Dropdown<Collection>
              autoAlign
              size="sm"
              id={`${uid}-collection`}
              titleText="Collection"
              label="Collection"
              items={pageCollections}
              selectedItem={chosen[0] ?? null}
              itemToString={(c) => c?.pluralName ?? ""}
              itemToElement={(c) => <CollectionChoiceLabel collection={c} />}
              renderSelectedItem={(c) => <CollectionChoiceLabel collection={c} />}
              onChange={({ selectedItem }) => selectedItem && pick([selectedItem])}
            />
          )}
          {/* A dropdown, not a switch: it lists every registered block type, however many there are. */}
          <Dropdown<BlockTypeDefinition>
            autoAlign
            size="sm"
            id={`${uid}-kind`}
            titleText="Show as"
            label="Show as"
            items={BLOCK_TYPES}
            selectedItem={type}
            itemToString={(t) => t?.label ?? ""}
            itemToElement={(t) => <BlockKindLabel kind={t} />}
            renderSelectedItem={(t) => <BlockKindLabel kind={t} />}
            // Filter, sort and fields are the block's: they carry over to the other type.
            // A type that shows the item's title by default (cards) takes the title field out of the
            // fields, so it isn't shown twice; leaving one that showed it (for a table) puts the
            // title field back, first, so the title doesn't vanish.
            onChange={({ selectedItem: next }) => {
              if (!next || next.kind === type.kind) return;
              const options = next.defaultOptions(collection);
              const showsTitle = (o: unknown) => !!(o as { showTitle?: boolean } | null)?.showTitle;
              const title = titleFields(collection)[0];
              const shown = block.layout.fields ?? orderFields(pickableFields(collection), null).map((f) => f.id);
              const fields =
                title && showsTitle(options) && shown.includes(title.id)
                  ? shown.filter((id) => id !== title.id)
                  : title && showsTitle(block.options) && !showsTitle(options) && !shown.includes(title.id)
                    ? [title.id, ...shown]
                    : null;
              onSet({ kind: next.kind, options, ...(fields && { layout: { ...block.layout, fields } }) });
            }}
          />
          {/* Empty: named after its component, or its type ("Table", "Cards"). Stored when left
              (Enter), like a view's name. */}
          <TextInput
            size="sm"
            key={block.title}
            id={`${uid}-title`}
            labelText="Name"
            placeholder={blockName({ ...block, title: "" })}
            defaultValue={block.title}
            onBlur={(e) => e.target.value.trim() !== block.title && onSet({ title: e.target.value.trim() })}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
          {row && <RowSettings id={`${uid}-row`} row={row} />}
          {type.OptionsEditor && <type.OptionsEditor collection={collection} options={block.options} place={place} pageCollectionId={page?.id} result={result} refs={refs} inRow={row?.inRow} onChange={(options) => onSet({ options })} />}
          {/* Offered while the text can be one (not empty, nothing a static component can't read). */}
          {markdownLocal && markdownLocal.code.trim() && !placeProblem(markdownLocal, "static") && (
            <Button kind="tertiary" size="sm" renderIcon={Save} onClick={() => setPromoting(true)}>
              Save as shared component
            </Button>
          )}
          {promoting && markdownLocal && (
            <PromoteComponentModal
              local={markdownLocal}
              suggestedName={block.title || `${collection.name} text`}
              onClose={() => setPromoting(false)}
              onPromoted={(c) => {
                setPromoting(false);
                onSet({ kind: "component", options: { componentId: c.id, height: BLOCK_HEIGHT.initial, aspect: DEFAULT_ASPECT, local: null } satisfies ComponentBlockOptions });
              }}
            />
          )}
          {onRemove && (
            <Button kind="danger--tertiary" size="sm" renderIcon={TrashCan} onClick={onRemove}>
              Remove block
            </Button>
          )}
        </div>
      </ToolbarPopover>
    </>
  );
}

interface Props {
  collection: Collection;
  data: CollectionData;
  block: ViewBlock;
  /** The view's filter, an item page's for this block's collection, or a dashboard's (whole: made the block's here); null for none. */
  viewFilters: FilterRule[] | null;
  search: string;
  place: BlockPlace;
  /** On an item page: its item. */
  page: PageItem | null;
  /** Field values are edited in place (the view's or item view's "Fields are editable"). */
  editable: boolean;
  /** On an item page: its header hidden (the layout's hidden labels; collection views use `hideHeader`). */
  headerHidden?: boolean;
  /** The view's collapsed blocks and groups, and storing a change (right away, not a view change). */
  collapsed: Collapsed;
  onCollapse(collapsed: Collapsed): void;
  /** A change to what the block shows (filter, sort, grouping, fields): saved with the view. */
  onChange(block: ViewBlock): void;
  /** A change to how it is arranged (type, options, name, collection): stored right away. */
  onSet(patch: Partial<ViewBlock>): void;
  onRemove?(): void;
  onError(message: string): void;
  onOpenChange?(open: boolean): void;
  /** Collapsed with its row instead of on its own (a dashboard's blocks: a row collapses as one). */
  collapse?: { collapsed: boolean; onToggle(): void };
  /** Its header's name drags it to another place on the page (views/BlockRows.tsx). */
  onDragStart?(e: DragEvent): void;
  /** Its place in a row, set in Block settings. */
  row?: RowControls;
}

export function BlockView({ collection: home, data: given, block, viewFilters: givenFilters, search, place, page, editable, headerHidden, collapsed: state, onCollapse, onChange, onSet, onRemove, onError, onOpenChange, collapse, onDragStart, row }: Props) {
  const { components, collections } = useStore();
  const { confirm, dialog } = useConfirm();
  // Several collections chosen (only on a dashboard): the block reads them as one (its columns merged by name), from the
  // parts, not the item cache. Elsewhere a block lists one collection.
  const dashboard = place === "dashboard";
  const listed = useMemo(
    () => (dashboard ? listedCollection(home, block, collections) : { collection: home }),
    [dashboard, home, block.collectionIds, block.merges, collections], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const collection = listed.collection;
  const data = useMemo(() => (collection === home ? given : { items: [], stored: [], refs: {}, ctx: given.ctx, error: given.error }), [collection, home, given]);
  // The view's (or page's) filter is written over the block's collection. A dashboard's is over all its blocks' collections:
  // each block takes its rules ("Date" on its own first date field; several collections: on their columns).
  const viewFilters = useMemo(() => (givenFilters && dashboard ? dashboardFiltersFor(collection, givenFilters) : givenFilters), [givenFilters, collection, dashboard]);

  const type = blockType(block.kind);
  const uses = type.uses(block.options, components);
  // Page-item values ("this item") filled in from the page's item; {{ }} code worked out.
  const base = blockQuery(viewFilters, block, blockSort(block, collection));
  const filters = useMemo(() => resolveFilterValues(base.filters, page ?? null), [base.filters, page]);
  const inherited = useMemo(() => resolveFilterValues(viewFilters ?? NO_FILTERS, page ?? null), [viewFilters, page]);
  const query = useMemo(() => ({ ...base, filters, inherited }), [filters, inherited, base.sort, base.groupBy, base.groupOrder, base.groupDate]); // eslint-disable-line react-hooks/exhaustive-deps
  // A remote collection's rows come from its source a page at a time, filtered and sorted there; several collections' from their parts, merged.
  // Its Limit: items shown at first and added by each "Show more" (0: all, a remote collection's loaded page by page).
  const limit = blockLimit(block, !!uses.all);
  // A block that doesn't show groups (a chart: its X axis is its own) doesn't make a remote collection load every row to group by a date part.
  const remoteQuery = useMemo(() => (uses.groups || !query.groupDate ? query : { ...query, groupDate: undefined }), [uses.groups, query]);
  const remoteRows = useRemoteResult(collection, remoteQuery, search, uses.query, limit === 0, limit || undefined);
  const mergedRows = useMergedResult(collection, query, search, uses.query, limit === 0, limit || undefined);
  const remote = remoteRows ?? mergedRows;
  const local = useMemo(
    () => (!remote && data.items && uses.query ? applyQuery(collection, data.items, query, data.ctx, search) : NO_RESULT),
    [remote, collection, data.items, data.ctx, uses.query, query, search],
  );
  // A native collection's items are shown a Limit at a time too (a table of thousands rows is slow), in the order of the groups.
  const [shown, setShown] = useState(limit);
  const stepKey = `${collection.id}|${search}|${limit}|${JSON.stringify(query)}`;
  useEffect(() => setShown(limit), [stepKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const stepped = !remote && limit > 0 && local.groups.reduce((n, g) => n + g.items.length, 0) > shown;
  const cut = useMemo(() => {
    if (!stepped) return local;
    let left = shown;
    const groups: ItemGroup[] = [];
    for (const g of local.groups) {
      if (left <= 0) break;
      groups.push(g.items.length <= left ? g : { ...g, items: g.items.slice(0, left) });
      left -= g.items.length;
    }
    return { ...local, groups };
  }, [stepped, local, shown]);
  const result = remote ? remote.result : cut;
  // A date part (month, …) of a remote collection is grouped here, of the rows loaded: stopped early, the groups are marked as partial.
  const groupedHere = !!remote && groupsInApp(collection, remoteQuery);
  const items = remote ? remote.items : data.items;
  const error = remote?.error ?? data.error;
  // Every block of a page asking the same server: its error (it can't be reached) shows once.
  const showError = useShownOnce(error);
  const fields = useMemo(() => orderFields(pickableFields(collection), block.layout.fields), [collection, block.layout.fields]);
  const preset = useMemo(() => filterPreset(collection, filters, inherited), [collection, filters, inherited]);
  const actions = useItemActions({
    collection,
    stored: data.stored,
    query,
    preset,
    onSort: (sort) => onChange({ ...block, sort, sortChosen: true }),
    confirm,
    onError,
  });
  const blockName = useBlockName();
  // Headed like a field (its name as a label, with its type's icon), collapsible. A hidden header
  // (View settings; Page layout on item pages) goes with its menus; such a block
  // can't collapse.
  const headless = page ? !!headerHidden : !!block.hideHeader;
  const collapsed = !headless && (collapse ? collapse.collapsed : state.blocks.includes(block.id));
  const toggleCollapsed = collapse ? collapse.onToggle : () => onCollapse(withBlockCollapsed(state, block.id, !collapsed));
  const groups = useMemo(() => collapsedGroups(state, block.id, block.groupBy), [state, block.id, block.groupBy]);
  // Searching the view: a block listing items that has none matching is left out altogether.
  if (search.trim() && uses.query && items && result.total === 0) return null;
  // Not even its header until its items are in: a header alone would sit where the blocks above are about to push it away.
  if (!items && !error && !remote?.waiting && !remote?.stopped) return null;
  return (
    <section className={uses.fillsRow ? "block block--fills" : "block"} data-block-id={block.id}>
      <SectionHeader
        heading
        hidden={headless}
        collapsed={collapsed}
        onToggle={toggleCollapsed}
        onDragStart={onDragStart}
        label={
          <span className="icon-label">
            <type.icon size={16} aria-hidden="true" />
            <span className="icon-label__text">{blockName(block)}</span>
          </span>
        }
      >
        <BlockMenus
          collection={collection}
          home={home}
          block={block}
          refs={data.refs}
          result={result}
          place={place}
          viewFilters={viewFilters}
          page={page?.collection}
          onChange={onChange}
          onSet={onSet}
          onRemove={onRemove}
          onError={onError}
          onOpenChange={onOpenChange}
          row={row}
        />
      </SectionHeader>
      {/* Below its header (none while collapsed): in a row side by side as tall as the row, scrolling inside past it; its
          content is measured there (views/BlockRows.tsx). */}
      {!collapsed && (
        <div className="block__body">
          <div className="block__content">
            {showError && <InlineNotification kind="error" title="Error" subtitle={error} hideCloseButton />}
            {/* A block whose collection is gone (or a merged column that lost a field) says so (the rest of it is shown). */}
            {mergedRows && mergedRows.problems.length > 0 && (
              <InlineNotification kind="warning" title="Collections problem" subtitle={mergedRows.problems.map((p) => p.message).join(" ")} hideCloseButton />
            )}
            {/* Nothing until everything is in (a fraction of a second): a placeholder table would only
                flash, shaped unlike the real one. */}
            {items && (
              <type.View
                collection={collection}
                result={result}
                fields={fields}
                layout={block.layout}
                options={block.options}
                editable={editable && !isReadOnly(collection)}
                onOptions={(options) => onSet({ options })}
                refs={data.refs}
                search={search}
                actions={actions}
                all={items}
                page={page}
                collapsedGroups={groups}
                onGroupCollapse={(key, on) => block.groupBy && onCollapse(withGroupCollapsed(state, block.id, block.groupBy, key, on))}
              />
            )}
            {/* A remote collection's rows come a page at a time, or (a chart, no Limit) all of them, which can be
                stopped. One bar from the request on: empty until the first page brings the total (rows yet to come, not
                none), then filling as the rows come in; it doesn't change shape when the total arrives. */}
            {remote && (remote.waiting || remote.progress) && (
              <div className="block-more">
                <LoadingBar
                  label={remote.progress ? `Loading rows: ${remote.progress.loaded} of ${remote.progress.total}` : "Loading rows"}
                  value={remote.progress?.loaded}
                  max={remote.progress?.total}
                  onStop={remote.progress?.cancel ?? remote.stop}
                />
              </div>
            )}
            {remote?.stopped && (
              <div className="block-more">
                <Button kind="tertiary" size="sm" onClick={remote.resume}>
                  Load rows
                </Button>
              </div>
            )}
            {items && stepped && (
              <div className="block-more">
                <Button kind="tertiary" size="sm" onClick={() => setShown((n) => n + limit)}>
                  Show more
                </Button>
                <span className="helper">
                  {cut.groups.reduce((n, g) => n + g.items.length, 0)} of {local.groups.reduce((n, g) => n + g.items.length, 0)}
                </span>
              </div>
            )}
            {items && remote?.more && (
              <div className="block-more">
                <Button kind="tertiary" size="sm" disabled={remote.loadingMore} onClick={remote.more}>
                  {remote.everything ? "Load all rows" : "Show more"}
                </Button>
                <span className="helper">
                  {groupedHere ? `Groups of the rows loaded so far: ${items.length} of ${result.total}` : `${items.length} of ${result.total}`}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
      {dialog}
    </section>
  );
}

/**
 * A block's place in its row (Block settings): beside the block above (in that block's row), and the row's height: as its
 * tallest block, at most a max height, or as its shortest, at least a min height; what is taller scrolls inside (where the
 * row's blocks stand side by side; stacked on a phone, never). Stored on the row's first block.
 */
function RowSettings({ id, row }: { id: string; row: RowControls }) {
  return (
    <>
      {/* Only where it can be: a block right above it, with room in its row. */}
      {(row.beside || row.canBeside) && (
        <div className="view-options__checks">
          <Checkbox id={`${id}-beside`} labelText="Beside the block above" checked={row.beside} onChange={(_, { checked }) => row.onBeside(checked)} />
        </div>
      )}
      <Select
        size="sm"
        id={`${id}-fit`}
        labelText="Row height"
        helperText={row.fit === "shortest" ? "Taller blocks scroll inside." : "The others are as tall."}
        value={row.fit}
        onChange={(e) => row.onRowSettings({ fit: e.target.value as RowControls["fit"], height: row.height })}
      >
        <SelectItem value="tallest" text="As its tallest block" />
        <SelectItem value="shortest" text="As its shortest block" />
      </Select>
      <NumberInput
        size="sm"
        key={`${row.fit}-${row.height ?? "none"}`}
        id={`${id}-height`}
        label={row.fit === "shortest" ? "Min height (rem)" : "Max height (rem)"}
        helperText={`${row.fit === "shortest" ? "At least this tall" : "At most this tall: taller blocks scroll inside"}. Empty: none. Not where the blocks stack (a phone).`}
        placeholder="none"
        allowEmpty
        hideSteppers
        min={ROW_HEIGHT.min}
        max={ROW_HEIGHT.max}
        defaultValue={row.height ?? ""}
        onBlur={(e) => {
          const raw = e.target.value.trim();
          const n = raw === "" ? undefined : Number(raw);
          if ((n === undefined || Number.isFinite(n)) && n !== row.height) row.onRowSettings({ fit: row.fit, height: n });
        }}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
    </>
  );
}
