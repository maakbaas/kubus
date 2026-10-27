// Views of a collection's items. A view (a tab of the collection page) = a filter + a list of
// blocks. A block shows items one way (a block type: table, cards, a component, …) with its own
// sort, grouping, fields (a FieldLayout) and type-specific options; its filter is the
// view's unless it has its own, which replaces it (not added to it). Item pages hold blocks too
// (fieldLayout.ts): there a block may list another collection, filtered by the page's item.
// The "current" view state is ephemeral; it becomes a CollectionView only when the user saves it.

import { parseFieldLayout, type FieldLayout } from "./fieldLayout";
import { newId } from "./model";
import { defaultQuery, type FilterRule, type GroupOrder, type SortRule, type ViewQuery } from "./query";

/** Name of a block type in the registry (src/views/index.ts). */
export type BlockKind = string;

export interface ViewBlock {
  id: string;
  /** Shown above the block; "" = none (then the type and collection name it, where named). */
  title: string;
  kind: BlockKind;
  /** Its own filter, replacing the view's; null = the view's. Blocks on item pages always have their own. */
  filters: FilterRule[] | null;
  sort: SortRule[];
  /** Field to group by, or null. */
  groupBy: string | null;
  groupOrder?: GroupOrder;
  /** Which fields it shows, in which order, and how. */
  layout: FieldLayout;
  /** The collection it lists; null = the page's own (always so in a collection view). */
  collectionId: string | null;
  /** Block-type specific options, validated by that block type. */
  options: unknown;
  /** Shown without its header (name, collapse, menus on hover); only in collection views. Absent = shown. */
  hideHeader?: true;
}

/** What is shown right now; may or may not match a saved view. */
export interface ViewState {
  filters: FilterRule[];
  /** At least one. */
  blocks: ViewBlock[];
  /** Field values are edited in place in its blocks ("Fields are editable", like an item view's). */
  editable: boolean;
}

/**
 * Which blocks and groups of a view are collapsed. Stored with the view (collection views and
 * item views alike) as soon as it is toggled, without "Save changes": it is how the view was
 * last left, not part of what it shows (sameView ignores it).
 */
export interface Collapsed {
  /** Collapsed blocks (and, in item views, fields), by id. */
  blocks: string[];
  /** Collapsed groups per block id, as "<grouped-by field id>/<group key>". */
  groups: Record<string, string[]>;
}

export const NOTHING_COLLAPSED: Collapsed = { blocks: [], groups: {} };

/** A stored collapse state, validated; nothing collapsed when absent. */
export function parseCollapsed(raw: unknown): Collapsed {
  if (!raw || typeof raw !== "object") return NOTHING_COLLAPSED;
  const o = raw as Partial<Collapsed>;
  const groups: Record<string, string[]> = {};
  for (const [id, keys] of Object.entries(o.groups ?? {})) {
    const list = array<unknown>(keys).filter((k): k is string => typeof k === "string");
    if (list.length > 0) groups[id] = list;
  }
  return { blocks: array<unknown>(o.blocks).filter((id): id is string => typeof id === "string"), groups };
}

/** The groups of a block collapsed while it is grouped by `groupBy` (their keys). */
export function collapsedGroups(collapsed: Collapsed, blockId: string, groupBy: string | null): string[] {
  if (!groupBy) return [];
  const prefix = `${groupBy}/`;
  return (collapsed.groups[blockId] ?? []).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}

/** A block (or an item view's field) collapsed or expanded. */
export function withBlockCollapsed(collapsed: Collapsed, blockId: string, on: boolean): Collapsed {
  const blocks = collapsed.blocks.filter((id) => id !== blockId);
  return { ...collapsed, blocks: on ? [...blocks, blockId] : blocks };
}

/** A group of a block (grouped by `groupBy`) collapsed or expanded. */
export function withGroupCollapsed(collapsed: Collapsed, blockId: string, groupBy: string, key: string, on: boolean): Collapsed {
  const entry = `${groupBy}/${key}`;
  const rest = (collapsed.groups[blockId] ?? []).filter((k) => k !== entry);
  const list = on ? [...rest, entry] : rest;
  const { [blockId]: _old, ...others } = collapsed.groups;
  return { ...collapsed, groups: list.length > 0 ? { ...others, [blockId]: list } : others };
}

export interface CollectionView extends ViewState {
  id: string;
  collectionId: string;
  /** Views belong to a space, like items (a view for work topics doesn't clutter another space). */
  spaceId: string;
  name: string;
  position: number;
  /** Starred: the collection's default view in its space, shown when its items are opened. */
  isDefault: boolean;
  /** Its collapsed blocks and groups (saved as toggled, see Collapsed). */
  collapsed: Collapsed;
  createdAt: string;
  updatedAt: string;
}

/** A block shows every field, editable, with its name. */
export const BLOCK_LAYOUT: FieldLayout = { fields: null, editable: true, hiddenLabels: [], hideEmpty: false };

/** A new block: all items sorted by title, all fields. */
export function newBlock(kind: BlockKind, options: unknown, id = newId()): ViewBlock {
  return { id, title: "", kind, filters: null, sort: defaultQuery().sort, groupBy: null, layout: BLOCK_LAYOUT, collectionId: null, options };
}

/** The unsaved starting view of every collection: a table of all items, sorted by title. */
export function defaultViewState(defaultOptions: unknown): ViewState {
  return { filters: [], blocks: [newBlock("table", defaultOptions, MAIN_BLOCK)], editable: true };
}

/** Id of the first block of a view stored before blocks (and of the default view's block). */
const MAIN_BLOCK = "main";

/** The query a block runs: its own filter, else the view's (none on item pages). */
export function blockQuery(viewFilters: FilterRule[] | null, block: ViewBlock): ViewQuery {
  const query: ViewQuery = { filters: block.filters ?? viewFilters ?? [], sort: block.sort, groupBy: block.groupBy };
  return block.groupOrder ? { ...query, groupOrder: block.groupOrder } : query;
}

/** A block with a changed sort / grouping (the query editor edits a whole query). */
export function withQuery(block: ViewBlock, query: ViewQuery): ViewBlock {
  const { groupOrder: _old, ...rest } = block;
  const next = { ...rest, sort: query.sort, groupBy: query.groupBy };
  return query.groupOrder ? { ...next, groupOrder: query.groupOrder } : next;
}

/** Whether two view states show the same thing (used to tell if a saved view was changed). */
export function sameView(a: ViewState, b: ViewState): boolean {
  return JSON.stringify(a.filters) === JSON.stringify(b.filters) && JSON.stringify(a.blocks) === JSON.stringify(b.blocks) && a.editable === b.editable;
}

const array = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** A stored block, its structure checked (its options are validated by its block type later); null when unreadable. */
export function parseBlock(raw: unknown): ViewBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<ViewBlock>;
  if (typeof o.id !== "string" || typeof o.kind !== "string") return null;
  const block: ViewBlock = {
    id: o.id,
    title: typeof o.title === "string" ? o.title : "",
    kind: o.kind,
    filters: Array.isArray(o.filters) ? o.filters : null,
    sort: array<SortRule>(o.sort),
    groupBy: typeof o.groupBy === "string" ? o.groupBy : null,
    layout: parseFieldLayout(o.layout) ?? BLOCK_LAYOUT,
    collectionId: typeof o.collectionId === "string" ? o.collectionId : null,
    options: o.options ?? null,
  };
  if (o.hideHeader === true) block.hideHeader = true;
  return o.groupOrder === "desc" || o.groupOrder === "count" ? { ...block, groupOrder: o.groupOrder } : block;
}

/**
 * A view's stored config (JSON `{ filters, blocks, editable, collapsed }`). Views stored before blocks hold
 * `{ query, options }` plus their kind (the row's): read as one block, whose fields come out of
 * the old options (a table's columns, the cards' fields, labels and empty-field choice).
 */
export function parseViewConfig(json: string, kind: string): ViewState & { collapsed: Collapsed } {
  let o: Record<string, unknown> = {};
  try {
    o = (JSON.parse(json) ?? {}) as Record<string, unknown>;
  } catch {
    // unreadable: the default below
  }
  if (Array.isArray(o.blocks)) {
    return {
      filters: array<FilterRule>(o.filters),
      blocks: o.blocks.map(parseBlock).filter((b): b is ViewBlock => b !== null),
      editable: o.editable !== false,
      collapsed: parseCollapsed(o.collapsed),
    };
  }
  const query = { ...defaultQuery(), ...((o.query ?? {}) as Partial<ViewQuery>) };
  const options = (o.options ?? {}) as Record<string, unknown>;
  const layout = parseFieldLayout(
    kind === "cards" ? { fields: options.fields, hiddenLabels: options.hiddenLabels, hideEmpty: options.hideEmpty } : { fields: options.columns },
  ) ?? BLOCK_LAYOUT;
  const block = withQuery({ ...newBlock(kind, options, MAIN_BLOCK), layout }, query);
  return { filters: array<FilterRule>(query.filters), blocks: [block], editable: true, collapsed: NOTHING_COLLAPSED };
}
