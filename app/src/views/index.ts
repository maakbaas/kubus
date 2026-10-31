import { cardsView } from "./CardsView";
import { chartBlock } from "./ChartBlock";
import { componentBlock } from "./ComponentBlock";
import { mapView } from "./MapView";
import { linkedBlock } from "./LinkedBlock";
import { markdownBlock } from "./MarkdownBlock";
import type { BlockTypeDefinition } from "./registry";
import { tableView } from "./TableView";
import { pickableFields, type Collection } from "../domain/model";
import { listedCollection, newBlock, type ViewBlock, type ViewState } from "../domain/views";
import { findListCollection, isListCollectionId } from "../domain/listEntries";

/** All block types, in the order the "Show as" menu lists them. Add new block types here. */
export const BLOCK_TYPES: BlockTypeDefinition[] = [tableView, cardsView, chartBlock, mapView, markdownBlock, componentBlock, linkedBlock];

/** The block type for a kind; falls back to the table for unknown (e.g. removed) kinds. */
export const blockType = (kind: string): BlockTypeDefinition => BLOCK_TYPES.find((v) => v.kind === kind) ?? tableView;

/**
 * A block made valid for its collection: its type's options normalized, fields that no longer
 * exist dropped. Keys always in the same order, so a normalized stored block compares equal to
 * the same block shown (sameView). `all` (every collection) only for a dashboard's block: only there may it list several
 * collections, normalized against the collection they are read as (its columns); elsewhere a block lists one.
 */
export function normalizeBlock(base: Collection, block: ViewBlock, all?: Collection[]): ViewBlock {
  const collection = all ? listedCollection(base, block, all).collection : base;
  const type = blockType(block.kind);
  const ids = new Set(pickableFields(collection).map((f) => f.id));
  const normalized: ViewBlock = {
    id: block.id,
    title: block.title,
    kind: type.kind,
    filters: block.filters,
    sort: block.sort,
    groupBy: block.groupBy,
    layout: {
      fields: block.layout.fields && block.layout.fields.filter((id) => ids.has(id)),
      editable: block.layout.editable,
      hiddenLabels: block.layout.hiddenLabels.filter((id) => ids.has(id)),
      hideEmpty: block.layout.hideEmpty,
    },
    collectionId: block.collectionId,
    options: type.normalizeOptions(block.options, collection),
  };
  if (block.sortChosen) normalized.sortChosen = true;
  if (block.hideHeader) normalized.hideHeader = true;
  if (block.limit !== undefined) normalized.limit = block.limit;
  if (block.beside) normalized.beside = true;
  if (block.width !== undefined) normalized.width = block.width;
  if (block.rowFit) normalized.rowFit = block.rowFit;
  if (block.rowHeight !== undefined) normalized.rowHeight = block.rowHeight;
  if (all && block.collectionIds) normalized.collectionIds = block.collectionIds;
  if (all && block.merges) normalized.merges = block.merges;
  if (block.groupDate) normalized.groupDate = block.groupDate;
  return block.groupOrder ? { ...normalized, groupOrder: block.groupOrder } : normalized;
}

/**
 * A block's options carried to another collection (the block's collection changed, or several were chosen): every field id in
 * them (any string equal to a field's id, however deep) becomes the field of the same name (case aside) in `to`; ids with no
 * such field stay and fall back when the type normalizes them. Merged columns are named like the fields they merge.
 */
export function carryOptions(options: unknown, from: Collection, to: Collection): unknown {
  const key = (name: string) => name.trim().toLowerCase();
  const target = new Map(to.fields.map((f) => [key(f.name), f.id]));
  const ids = new Map(from.fields.flatMap((f) => (target.has(key(f.name)) ? [[f.id, target.get(key(f.name))!] as const] : [])));
  const walk = (v: unknown): unknown =>
    typeof v === "string" ? (ids.get(v) ?? v) : Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  return walk(options);
}

/**
 * A view state made valid for its collection (stored ones may be outdated); always at least one block. A block of one of its
 * list fields' entries is made valid for those (found among `collections`; gone: for the collection, which drops its fields).
 */
export function normalizeView(collection: Collection, state: ViewState, collections: Collection[] = []): ViewState {
  // A fixed id: normalizing the same state twice gives the same result.
  const blocks = state.blocks.length > 0 ? state.blocks : [newBlock("table", null, "main")];
  const own = (b: ViewBlock) => (isListCollectionId(b.collectionId) ? (findListCollection(collections, b.collectionId) ?? collection) : collection);
  return { filters: state.filters, blocks: blocks.map((b) => normalizeBlock(own(b), b)), editable: state.editable };
}

export type { BlockPlace, BlockTypeDefinition, PageItem } from "./registry";
