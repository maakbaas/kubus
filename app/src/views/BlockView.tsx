import { useId, useMemo } from "react";
import { Button, Checkbox, Dropdown, IconButton, InlineNotification, TextInput } from "@carbon/react";
import { ArrowsVertical, ChevronDown, ChevronRight, Filter, ListChecked, Settings, TrashCan } from "@carbon/icons-react";
import { useStore } from "../app/store";
import { orderFields } from "../domain/fieldLayout";
import { newId, pickableFields, type Collection } from "../domain/model";
import { fieldLookup, render } from "../domain/components";
import { applyQuery, defaultQuery, filterPreset, PAGE_ITEM, resolvePageValues, type FilterRule, type QueryResult } from "../domain/query";
import { blockQuery, collapsedGroups, newBlock, withBlockCollapsed, withGroupCollapsed, withQuery, type Collapsed, type ViewBlock } from "../domain/views";
import { CollectionIcon } from "../ui/collectionIcons";
import { FieldOrderEditor } from "../ui/FieldOrderEditor";
import { ToolbarPopover } from "../ui/ToolbarPopover";
import { useConfirm } from "../ui/useConfirm";
import type { RefOptions } from "../ui/useReferenceOptions";
import { BLOCK_TYPES, blockType, normalizeBlock, type BlockPlace, type BlockTypeDefinition, type PageItem } from ".";
import { QueryEditor } from "./QueryEditor";
import type { CollectionData } from "./useCollectionData";
import { useItemActions } from "./useItemActions";
import { useBlockName } from "./BlockListEditor";

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

/** Sorted by title (ascending), not grouped: what every block starts with. */
const isDefaultSort = (block: ViewBlock) =>
  block.groupBy === null && JSON.stringify(block.sort) === JSON.stringify(defaultQuery().sort);

interface MenusProps {
  collection: Collection;
  block: ViewBlock;
  refs: RefOptions;
  place: BlockPlace;
  /** The view's filter, which the block uses unless it has its own; null on item pages. */
  viewFilters: FilterRule[] | null;
  /** On an item page: its collection (filter values "this item"), and choosing the listed collection. */
  page?: Collection;
  /** What changes the shown items (filter, sort, grouping, fields): a change to save. */
  onChange(block: ViewBlock): void;
  /** What arranges the view (type, its options, name, the listed collection): stored right away. */
  onSet(patch: Partial<ViewBlock>): void;
  onRemove?(): void;
  onOpenChange?(open: boolean): void;
}

/** A block's menus: Filter, Sort and group, Fields (each where its block type uses it), and its type's settings. */
export function BlockMenus({ collection, block, refs, place, viewFilters, page, onChange, onSet, onRemove, onOpenChange }: MenusProps) {
  const uid = useId();
  const { components, collections } = useStore();
  const blockName = useBlockName();
  const type = blockType(block.kind);
  const uses = type.uses(block.options, components);
  const query = blockQuery(viewFilters, block);
  const own = block.filters !== null && viewFilters !== null;
  const filterCount = (block.filters ?? []).length;
  return (
    <>
      {uses.query && (
        <ToolbarPopover
          label={own ? `Own filter (${filterCount})` : viewFilters === null && filterCount > 0 ? `Filter (${filterCount})` : "Filter"}
          icon={Filter}
          width="wide"
          active={own || (viewFilters === null && filterCount > 0)}
          onOpenChange={onOpenChange}
        >
          <div className="view-settings">
            {viewFilters !== null && (
              <Checkbox
                id={`${uid}-same-filter`}
                labelText="Same as the view's filter"
                helperText={own ? "Its own filter replaces the view's: changes to the view's filter don't apply here." : undefined}
                checked={!own}
                // Its own filter starts as a copy of the view's.
                onChange={(_, { checked }) => onChange({ ...block, filters: checked ? null : viewFilters.map((r) => ({ ...r, id: newId() })) })}
              />
            )}
            {(own || viewFilters === null) && (
              <QueryEditor
                collection={collection}
                query={query}
                refs={refs}
                part="filter"
                page={page}
                title={viewFilters === null ? "Filter" : "Own filter"}
                onChange={(q) => onChange({ ...block, filters: q.filters })}
              />
            )}
          </div>
        </ToolbarPopover>
      )}
      {uses.query && (
        <ToolbarPopover label="Sort and group" icon={ArrowsVertical} active={!isDefaultSort(block)} onOpenChange={onOpenChange}>
          <QueryEditor collection={collection} query={query} refs={refs} part="sortGroup" onChange={(q) => onChange(withQuery(block, q))} />
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
                onSet({ ...fresh, groupOrder: undefined });
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
            onChange={({ selectedItem: next }) => next && next.kind !== type.kind && onSet({ kind: next.kind, options: next.defaultOptions(collection) })}
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
          {type.OptionsEditor && <type.OptionsEditor collection={collection} options={block.options} place={place} onChange={(options) => onSet({ options })} />}
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

export function BlockView({ collection, data, block, viewFilters, search, place, page, collapsed: state, onCollapse, onChange, onSet, onRemove, onError, onOpenChange }: Props) {
  const { components } = useStore();
  const { confirm, dialog } = useConfirm();
  const type = blockType(block.kind);
  const uses = type.uses(block.options, components);
  // Page-item values ("this item") filled in from the page's item.
  const base = blockQuery(viewFilters, block);
  const filters = useMemo(() => {
    // {{ }} in a filter value reads the page's item as $item.
    const evalText = page
      ? (text: string) => String(render({ params: [], code: text }, [], page.item, fieldLookup(page.collection, page.item, page.refLabel)) ?? "")
      : undefined;
    return resolvePageValues(base.filters, page?.item ?? null, evalText);
  }, [base.filters, page]);
  const query = useMemo(() => ({ ...base, filters }), [filters, base.sort, base.groupBy, base.groupOrder]); // eslint-disable-line react-hooks/exhaustive-deps
  const result = useMemo(
    () => (data.items && uses.query ? applyQuery(collection, data.items, query, data.ctx, search) : NO_RESULT),
    [collection, data.items, data.ctx, uses.query, query, search],
  );
  const fields = useMemo(() => orderFields(pickableFields(collection), block.layout.fields), [collection, block.layout.fields]);
  const preset = useMemo(() => filterPreset(collection, filters), [collection, filters]);
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
  // On an item page a block is headed like a field (its name as a label) and never collapses.
  const collapsed = !page && state.blocks.includes(block.id);
  const toggleCollapsed = () => onCollapse(withBlockCollapsed(state, block.id, !collapsed));
  const groups = useMemo(() => collapsedGroups(state, block.id, block.groupBy), [state, block.id, block.groupBy]);
  return (
    <section className={page ? "block block--field" : "block"}>
      <div className="block__header">
        {page ? (
          // A Markdown block without a name is just its text, with no heading.
          (block.title || type.kind !== "markdown") && (
            <h2 className="block__title cds--label">
              {/* The block type's icon, like a field's kind icon in its label. */}
              <span className="icon-label">
                <type.icon size={16} aria-hidden="true" />
                {blockName(block)}
              </span>
            </h2>
          )
        ) : (
          <>
            <IconButton autoAlign kind="ghost" size="sm" align="top-start" label={collapsed ? "Expand" : "Collapse"} aria-expanded={!collapsed} onClick={toggleCollapsed}>
              {collapsed ? <ChevronRight /> : <ChevronDown />}
            </IconButton>
            {/* The name toggles too, like an accordion heading (the icon button is its keyboard control). */}
            <h2 className="block__title" onClick={toggleCollapsed}>
              {blockName(block)}
            </h2>
          </>
        )}
        <span className="views-bar__spacer" />
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
          onOpenChange={onOpenChange}
        />
      </div>
      {!collapsed && data.error && <InlineNotification kind="error" title="Error" subtitle={data.error} hideCloseButton />}
      {/* Nothing until everything is in (a fraction of a second): a placeholder table would only
          flash, shaped unlike the real one. */}
      {!collapsed && data.items && (
        <type.View
          collection={collection}
          result={result}
          fields={fields}
          layout={block.layout}
          options={block.options}
          onOptions={(options) => onSet({ options })}
          refs={data.refs}
          search={search}
          actions={actions}
          all={data.items}
          page={page}
          collapsedGroups={groups}
          onGroupCollapse={(key, on) => block.groupBy && onCollapse(withGroupCollapsed(state, block.id, block.groupBy, key, on))}
        />
      )}
      {dialog}
    </section>
  );
}
