import { useEffect, useId, useMemo, useState } from "react";
import { Button, Checkbox, Dropdown, InlineNotification, NumberInput, ProgressBar, TextInput } from "@carbon/react";
import { ArrowsVertical, Filter, ListChecked, Save, Settings, TrashCan } from "@carbon/icons-react";
import { useStore } from "../app/store";
import { orderFields } from "../domain/fieldLayout";
import { newId, pickableFields, titleFields, type Collection } from "../domain/model";
import { placeProblem } from "../domain/components";
import { PromoteComponentModal } from "../ui/PromoteComponentModal";
import type { MarkdownBlockOptions } from "./MarkdownBlock";
import type { ComponentBlockOptions } from "./ComponentBlock";
import { applyQuery, defaultQuery, filterPreset, PAGE_ITEM, resolveFilterValues, type FilterRule, type ItemGroup, type QueryResult } from "../domain/query";
import { blockLimit, blockQuery, NO_FILTERS, collapsedGroups, newBlock, withBlockCollapsed, withGroupCollapsed, withQuery, type Collapsed, type ViewBlock } from "../domain/views";
import { CollectionIcon } from "../ui/collectionIcons";
import { FieldOrderEditor } from "../ui/FieldOrderEditor";
import { ToolbarPopover } from "../ui/ToolbarPopover";
import { SectionHeader } from "../ui/SectionHeader";
import { useConfirm } from "../ui/useConfirm";
import type { RefOptions } from "../ui/useReferenceOptions";
import { BLOCK_TYPES, blockType, normalizeBlock, type BlockPlace, type BlockTypeDefinition, type PageItem } from ".";
import { QueryEditor } from "./QueryEditor";
import type { CollectionData } from "./useCollectionData";
import { useItemActions } from "./useItemActions";
import { useRemoteResult } from "./useRemoteResult";
import { useBlockName } from "./BlockListEditor";
import { useShownOnce } from "../ui/useShownOnce";
import { BLOCK_HEIGHT, DEFAULT_ASPECT } from "../domain/views";

// One block: a collection's items shown one way (its block type), with its own sort, grouping,
// and fields, and the view's filter unless it has its own. Collection views and item pages
// both render their blocks with BlockView; BlockMenus in each block's header edits it (also when
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
  return normalizeBlock(target, { ...newBlock(kind, spec?.options ?? blockType(kind).defaultOptions(target)), collectionId: target.id, filters });
}

/** Sorted by title (ascending), not grouped (where grouping applies): what every block starts with. */
const isDefaultSort = (block: ViewBlock, grouped: boolean) =>
  (!grouped || block.groupBy === null) && JSON.stringify(block.sort) === JSON.stringify(defaultQuery().sort);

interface MenusProps {
  collection: Collection;
  block: ViewBlock;
  refs: RefOptions;
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
}

/** A block's menus: Filter, Sort and group, Fields (each where its block type uses it), and its type's settings. */
export function BlockMenus({ collection, block, refs, place, viewFilters, page, onChange, onSet, onRemove, onOpenChange }: MenusProps) {
  const uid = useId();
  const { components, collections } = useStore();
  // A Markdown block's text is its own static component: promoted, it becomes a shared one (named
  // like the block), which the block then shows as a component block: the same text, now reusable
  // elsewhere and edited in the component editor.
  const [promoting, setPromoting] = useState(false);
  const markdown = block.kind === "markdown" ? (block.options as MarkdownBlockOptions).text : null;
  const markdownLocal = markdown === null ? null : { code: markdown, output: "markdown" as const, frameRatio: null, ai: false };
  const blockName = useBlockName();
  const type = blockType(block.kind);
  const uses = type.uses(block.options, components);
  const query = blockQuery(viewFilters, block);
  // A block always builds on its view's (or item page's) filter; its own rules are marked blue.
  const filterCount = query.filters.length;
  const inherits = place === "item" ? "the page's" : "the view's";
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
        <ToolbarPopover label={uses.groups ? "Sort and group" : "Sort"} icon={ArrowsVertical} active={!isDefaultSort(block, uses.groups)} onOpenChange={onOpenChange}>
          <QueryEditor collection={collection} query={query} refs={refs} part="sortGroup" noGroup={!uses.groups} onChange={(q) => onChange(withQuery(block, q))} />
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
          {page && (
            <Dropdown<Collection>
              autoAlign
              size="sm"
              id={`${uid}-collection`}
              titleText="Collection"
              label="Collection"
              items={collections}
              selectedItem={collection}
              itemToString={(c) => c?.pluralName ?? ""}
              itemToElement={(c) => (
                <span className="view-kind">
                  <CollectionIcon name={c.icon} />
                  {c.pluralName}
                </span>
              )}
              // Another collection's fields and filter don't apply: it starts afresh, linked to the page's item where it can be.
              onChange={({ selectedItem }) => {
                if (!selectedItem || selectedItem.id === collection.id) return;
                const { id: _id, title: _title, ...fresh } = newPageBlock(selectedItem, page);
                onSet({ ...fresh, groupOrder: undefined, groupDate: undefined });
              }}
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
          {type.OptionsEditor && <type.OptionsEditor collection={collection} options={block.options} place={place} pageCollectionId={page?.id} onChange={(options) => onSet({ options })} />}
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
            <Button kind="danger--tertiary" size="sm" renderIcon={TrashCan} className="block-settings__remove" onClick={onRemove}>
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
  /** The view's filter; null on item pages. */
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
}

export function BlockView({ collection, data, block, viewFilters, search, place, page, editable, headerHidden, collapsed: state, onCollapse, onChange, onSet, onRemove, onError, onOpenChange }: Props) {
  const { components } = useStore();
  const { confirm, dialog } = useConfirm();
  const type = blockType(block.kind);
  const uses = type.uses(block.options, components);
  // Page-item values ("this item") filled in from the page's item; {{ }} code worked out.
  const base = blockQuery(viewFilters, block);
  const filters = useMemo(() => resolveFilterValues(base.filters, page ?? null), [base.filters, page]);
  const inherited = useMemo(() => resolveFilterValues(viewFilters ?? NO_FILTERS, page ?? null), [viewFilters, page]);
  const query = useMemo(() => ({ ...base, filters, inherited }), [filters, inherited, base.sort, base.groupBy, base.groupOrder, base.groupDate]); // eslint-disable-line react-hooks/exhaustive-deps
  // A remote collection's rows come from its source a page at a time, filtered and sorted there.
  // Its Limit: items shown at first and added by each "Show more" (0: all, a remote collection's loaded page by page).
  const limit = blockLimit(block, !!uses.all);
  const remote = useRemoteResult(collection, query, search, uses.query, limit === 0, limit || undefined);
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
    onSort: (sort) => onChange({ ...block, sort }),
    confirm,
    onError,
  });
  const blockName = useBlockName();
  // Headed like a field (its name as a label, with its type's icon), collapsible. A hidden header
  // (View settings; Page layout on item pages) goes with its menus; such a block
  // can't collapse.
  const headless = page ? !!headerHidden : !!block.hideHeader;
  const collapsed = !headless && state.blocks.includes(block.id);
  const toggleCollapsed = () => onCollapse(withBlockCollapsed(state, block.id, !collapsed));
  const groups = useMemo(() => collapsedGroups(state, block.id, block.groupBy), [state, block.id, block.groupBy]);
  // Searching the view: a block listing items that has none matching is left out altogether.
  if (search.trim() && uses.query && items && result.total === 0) return null;
  return (
    <section className="block" data-block-id={block.id}>
      <SectionHeader
        heading
        hidden={headless}
        collapsed={collapsed}
        onToggle={toggleCollapsed}
        label={
          <span className="icon-label">
            <type.icon size={16} aria-hidden="true" />
            <span className="icon-label__text">{blockName(block)}</span>
          </span>
        }
      >
        <BlockMenus
          collection={collection}
          block={block}
          refs={data.refs}
          place={place}
          viewFilters={viewFilters}
          page={page?.collection}
          onChange={onChange}
          onSet={onSet}
          onRemove={onRemove}
          onError={onError}
          onOpenChange={onOpenChange}
        />
      </SectionHeader>
      {!collapsed && showError && <InlineNotification kind="error" title="Error" subtitle={error} hideCloseButton />}
      {/* Nothing until everything is in (a fraction of a second): a placeholder table would only
          flash, shaped unlike the real one. */}
      {!collapsed && items && (
        <type.View
          collection={collection}
          result={result}
          fields={fields}
          layout={block.layout}
          options={block.options}
          editable={editable}
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
      {!collapsed && remote && (remote.waiting || remote.progress) && (
        <div className="block-more">
          <ProgressBar
            className="block-more__bar"
            size="small"
            label={remote.progress ? `Loading rows: ${remote.progress.loaded} of ${remote.progress.total}` : "Loading rows"}
            value={remote.progress?.loaded ?? 0}
            max={Math.max(remote.progress?.total ?? 1, 1)}
          />
          {limit === 0 && (
            <Button kind="tertiary" size="sm" onClick={remote.progress?.cancel ?? remote.stop}>
              Cancel
            </Button>
          )}
        </div>
      )}
      {!collapsed && items && stepped && (
        <div className="block-more">
          <Button kind="tertiary" size="sm" onClick={() => setShown((n) => n + limit)}>
            Show more
          </Button>
          <span className="helper">
            {cut.groups.reduce((n, g) => n + g.items.length, 0)} of {local.groups.reduce((n, g) => n + g.items.length, 0)}
          </span>
        </div>
      )}
      {!collapsed && items && remote?.more && (
        <div className="block-more">
          <Button kind="tertiary" size="sm" disabled={remote.loadingMore} onClick={remote.more}>
            {limit === 0 ? "Load all rows" : "Show more"}
          </Button>
          <span className="helper">
            {items.length} of {result.total}
          </span>
        </div>
      )}
      {dialog}
    </section>
  );
}
