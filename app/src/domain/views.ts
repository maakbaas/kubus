// Views of a collection's items. A view (a tab of the collection page) = a filter + a list of
// blocks. A block shows items one way (a block type: table, cards, a component, …) with its own
// sort, grouping, fields (a FieldLayout) and type-specific options; its filter builds on the
// view's (domain/filterTree.ts: its And rules narrow it, Or rules make exceptions). Item pages hold blocks too
// (fieldLayout.ts): there a block may list another collection, filtered by the page's item.
// The "current" view state is ephemeral; it becomes a CollectionView only when the user saves it.

import { normalizeRowMaxHeight } from "./blockRows";
import { mergeCollections, type MergeProblem, type ColumnMerge } from "./mergedCollection";
import { parseFieldLayout, type FieldLayout } from "./fieldLayout";
import { newId, pickableFields, type Collection } from "./model";
import { parseGroupDate, type GroupDate } from "./groupDate";
import { defaultQuery, type FilterRule, type GroupOrder, type SortRule, type ViewQuery } from "./query";

/** Name of a block type in the registry (src/views/index.ts). */
export type BlockKind = string;

export interface ViewBlock {
  id: string;
  /** Shown above the block; "" = none (then the type and collection name it, where named). */
  title: string;
  kind: BlockKind;
  /**
   * Its own filter, on top of the view's (or its item page's), which it always builds on: its And rules
   * narrow that, its Or rules make exceptions to it (domain/filterTree.ts). null = none of its own.
   */
  filters: FilterRule[] | null;
  sort: SortRule[];
  /** The sort was picked (Title too), so the block type's default sort (domain/blockSort.ts) no longer applies. Absent = not picked. */
  sortChosen?: true;
  /** Field to group by, or null. */
  groupBy: string | null;
  groupOrder?: GroupOrder;
  /** A date field's groups by year, month, week, day or hour (absent: day). */
  groupDate?: GroupDate;
  /** Which fields it shows, in which order, and how. */
  layout: FieldLayout;
  /** The collection it lists; null = the page's own (always so in a collection view). */
  collectionId: string | null;
  /**
   * On a dashboard only: every collection it lists when that is several (native and remote ones mixed; `collectionId` first):
   * read as one, their fields merged by name (domain/mergedCollection.ts). Absent = the one collection. Elsewhere a block
   * lists one collection (a collection view's block its view's; an item page's one, or Backlinks).
   */
  collectionIds?: string[];
  /** With several collections: columns merged by hand (Fields → Merge fields). */
  merges?: ColumnMerge[];
  /** Block-type specific options, validated by that block type. */
  options: unknown;
  /** Shown without its header (name, collapse, menus on hover); only in collection views. Absent = shown. */
  hideHeader?: true;
  /** Items shown at first and added by each "Show more" (Filter → Limit); 0 = all. Absent = its type's default (`blockLimit`). */
  limit?: number;
  /** Shown beside the block before it, in its row (domain/blockRows.ts), where the page is wide enough. Absent = a row of its own. */
  beside?: true;
  /** Its share of its row's width, in percent (set by dragging the divider). Absent = an equal share. */
  width?: number;
  /** The first block of a row: the row's max height in rem; its blocks scroll inside beyond it. Absent = none. */
  rowMaxHeight?: number;
}

/** Items a block shows at first and adds by each "Show more" unless its Limit says otherwise. */
export const DEFAULT_LIMIT = 100;

/** A block's Limit: its own, else all for a block that needs every item (a chart), else DEFAULT_LIMIT; 0 = all. */
export const blockLimit = (block: Pick<ViewBlock, "limit">, all: boolean): number => block.limit ?? (all ? 0 : DEFAULT_LIMIT);

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
  /**
   * "Show filter bar": the view's filter (its Filter button) and date period are on a bar below the tabs.
   * Stored with the view as soon as it is set, not a change to save (it shows no other items). Absent = off.
   */
  filterBar?: true;
  /**
   * "Full width": the view uses the pane's whole width (on) or the item page's narrow column (off). Stored with
   * the view as soon as it is set, like "Show filter bar"; absent = the place's default (`isFullWidth`).
   */
  fullWidth?: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * "Full width" when a view doesn't say (absent): collection views and dashboard tabs use the pane's width,
 * item views the narrow column (700px) of an item page, as they always did.
 */
export const FULL_WIDTH_DEFAULT = { collection: true, item: false, dashboard: true } as const;
export type WidthPlace = keyof typeof FULL_WIDTH_DEFAULT;
/** Whether a view of this place is shown at full width: its own setting, else the place's default. */
export const isFullWidth = (place: WidthPlace, stored?: boolean): boolean => stored ?? FULL_WIDTH_DEFAULT[place];

/** A block shows every field, editable, with its name. */
export const BLOCK_LAYOUT: FieldLayout = { fields: null, editable: true, hiddenLabels: [], hideEmpty: false };

/** A new block: all items sorted by title, all fields. */
export function newBlock(kind: BlockKind, options: unknown, id = newId()): ViewBlock {
  return { id, title: "", kind, filters: null, sort: defaultQuery().sort, groupBy: null, layout: BLOCK_LAYOUT, collectionId: null, options };
}

/**
 * The unsaved starting view of every collection: a table of all items, sorted by title (of these
 * fields; null = all), its fields editable unless the collection is read-only (a remote one), filtered
 * by `filters` (a time series' date period: sources.ts sourcePeriod).
 */
export function defaultViewState(defaultOptions: unknown, fields: string[] | null = null, editable = true, filters: FilterRule[] = []): ViewState {
  const block = newBlock("table", defaultOptions, MAIN_BLOCK);
  return { filters, blocks: [fields ? { ...block, layout: { ...block.layout, fields } } : block], editable };
}

/** Id of the default view's block. */
const MAIN_BLOCK = "main";

/**
 * What a page-wide filter (an item page's) does to one collection's block: its rules on fields
 * this collection has (and, for a native one, the pseudo fields), in addition to the block's own
 * filter. A rule on another collection's field leaves the block alone. A remote block asks its
 * source with them like with its own (`sourceQuery`), so they work for every connector.
 */
export function pageFiltersFor(collection: Collection, filters: FilterRule[]): FilterRule[] {
  const fields = new Set(pickableFields(collection).map((f) => f.id));
  return filters.filter((r) => fields.has(r.fieldId));
}

/**
 * The collection a page-wide filter is edited against: the fields of all the collections it applies
 * to, native and remote alike (a field name several have gets its collection's name behind it).
 * Created and Updated are offered while a native one is among them (remote rows have neither).
 */
export function pageFilterScope(collections: Collection[]): Collection {
  const names = new Map<string, number>();
  for (const c of collections) for (const f of c.fields) names.set(f.name, (names.get(f.name) ?? 0) + 1);
  const fields = collections.flatMap((c) => c.fields.map((f) => ((names.get(f.name) ?? 0) > 1 ? { ...f, name: `${f.name} (${c.name})` } : f)));
  return { ...collections[0], fields, source: collections.every((c) => c.source) ? collections[0].source : null, virtual: collections.every((c) => c.virtual) ? collections[0].virtual : null };
}

/** No filter rules: always this array (frozen), so what is memoized on a query's filters stays. */
export const NO_FILTERS = Object.freeze([]) as unknown as FilterRule[];

/** The query a block runs: its own filter on top of the one it inherits (its view's or item page's). */
export function blockQuery(inherited: FilterRule[] | null, block: ViewBlock, sort: SortRule[] = block.sort): ViewQuery {
  const query: ViewQuery = { filters: block.filters ?? NO_FILTERS, inherited: inherited ?? NO_FILTERS, sort, groupBy: block.groupBy };
  return { ...query, ...(block.groupOrder && { groupOrder: block.groupOrder }), ...(block.groupDate && { groupDate: block.groupDate }) };
}

/** A block with a changed sort / grouping (the query editor edits a whole query). */
export function withQuery(block: ViewBlock, query: ViewQuery, shownSort: SortRule[] = block.sort): ViewBlock {
  const { groupOrder: _old, groupDate: _oldDate, ...rest } = block;
  // A sort other than the one the editor showed was picked (a grouping change alone leaves it unmarked).
  const sortChosen = block.sortChosen || JSON.stringify(query.sort) !== JSON.stringify(shownSort);
  return { ...rest, ...(sortChosen && { sortChosen: true as const }), sort: query.sort, groupBy: query.groupBy, ...(query.groupDate && { groupDate: query.groupDate }), ...(query.groupOrder && { groupOrder: query.groupOrder }) };
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
  if (o.sortChosen === true) block.sortChosen = true;
  if (o.hideHeader === true) block.hideHeader = true;
  if (typeof o.limit === "number" && Number.isInteger(o.limit) && o.limit >= 0) block.limit = o.limit;
  if (o.beside === true) block.beside = true;
  if (typeof o.width === "number" && Number.isFinite(o.width) && o.width > 0 && o.width <= 100) block.width = Math.round(o.width);
  if (typeof o.rowMaxHeight === "number" && Number.isFinite(o.rowMaxHeight)) block.rowMaxHeight = normalizeRowMaxHeight(o.rowMaxHeight);
  if (Array.isArray(o.collectionIds) && o.collectionIds.length > 1 && o.collectionIds.every((id) => typeof id === "string")) block.collectionIds = o.collectionIds as string[];
  const merges = array<unknown>(o.merges).filter(
    (m): m is ColumnMerge => !!m && typeof m === "object" && typeof (m as ColumnMerge).id === "string" && typeof (m as ColumnMerge).name === "string" && Array.isArray((m as ColumnMerge).fields) && (m as ColumnMerge).fields.every((f) => typeof f === "string"),
  );
  if (block.collectionIds && merges.length > 0) block.merges = merges;
  const groupDate = parseGroupDate(o.groupDate);
  if (groupDate) block.groupDate = groupDate;
  return o.groupOrder === "desc" || o.groupOrder === "count" ? { ...block, groupOrder: o.groupOrder } : block;
}

/** A view's stored config (JSON `{ filters, blocks, editable, collapsed, filterBar?, fullWidth? }`); unreadable: no filter, no blocks. */
export function parseViewConfig(json: string): ViewState & { collapsed: Collapsed; filterBar?: true; fullWidth?: boolean } {
  let o: Record<string, unknown> = {};
  try {
    o = (JSON.parse(json) ?? {}) as Record<string, unknown>;
  } catch {
    // unreadable: the empty view below
  }
  return {
    filters: array<FilterRule>(o.filters),
    blocks: array<unknown>(o.blocks).map(parseBlock).filter((b): b is ViewBlock => b !== null),
    editable: o.editable !== false,
    collapsed: parseCollapsed(o.collapsed),
    ...(o.filterBar === true && { filterBar: true as const }),
    ...(typeof o.fullWidth === "boolean" && { fullWidth: o.fullWidth }),
  };
}

/**
 * The height of a block that draws in a box of its own (a chart, a map, a component), in rem. It is
 * the most it takes: content that is less tall (a pie in a narrow block, a component's text) is
 * shown at its own height; content that fills its box (a map, a chart or HTML at 100%) gets it all.
 */
export const BLOCK_HEIGHT = { min: 8, max: 48, step: 1, initial: 24 };
/** Heights saved as a size before the slider (charts): their rem. */
const LEGACY_HEIGHTS: Record<string, number> = { s: 16, m: 24, l: 32 };

/**
 * A block's aspect ratio (width:height) beside its Height: it is as tall as the less of the two, so a block
 * as wide as a desktop pane takes its Height and a narrow one (a phone) keeps its shape instead of becoming
 * a tall box. "none": its Height whatever its width.
 */
export const ASPECT_RATIOS = ["none", "2:1", "16:9", "3:2", "4:3", "1:1", "3:4"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];
export const DEFAULT_ASPECT: AspectRatio = "4:3";

/** A stored aspect ratio made valid (none stored: the default). */
export const normalizeAspect = (raw: unknown): AspectRatio => (ASPECT_RATIOS.includes(raw as AspectRatio) ? (raw as AspectRatio) : DEFAULT_ASPECT);

/**
 * A block's height as CSS: its Height, or less where its width at its aspect ratio is less. The width is its
 * container's (`cqi`): the box it is drawn in has `container-type: inline-size` (styles.css).
 */
export function blockHeightCss(height: number, aspect: AspectRatio): string {
  if (aspect === "none") return `${height}rem`;
  const [w, h] = aspect.split(":").map(Number);
  return `min(${height}rem, calc(100cqi * ${h} / ${w}))`;
}

/** A stored block height made valid: rem within BLOCK_HEIGHT (an old size name as its rem). */
export function normalizeBlockHeight(raw: unknown): number {
  if (typeof raw === "string" && raw in LEGACY_HEIGHTS) return LEGACY_HEIGHTS[raw];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return BLOCK_HEIGHT.initial;
  return Math.min(BLOCK_HEIGHT.max, Math.max(BLOCK_HEIGHT.min, Math.round(raw)));
}

/**
 * The collection a block lists: its own, or (several chosen: `collectionIds`) the one they are read as, with what is wrong with
 * the choice (a collection that is gone, a merged column that lost a field).
 */
export function listedCollection(base: Collection, block: Pick<ViewBlock, "collectionIds" | "merges">, collections: Collection[]): { collection: Collection; problems: MergeProblem[] } {
  if (!block.collectionIds || block.collectionIds.length < 2) return { collection: base, problems: [] };
  return mergeCollections(block.collectionIds, collections, block.merges);
}
