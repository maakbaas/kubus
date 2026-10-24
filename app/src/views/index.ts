import { cardsView } from "./CardsView";
import { componentBlock } from "./ComponentBlock";
import type { BlockTypeDefinition } from "./registry";
import { tableView } from "./TableView";
import { pickableFields, type Collection } from "../domain/model";
import { newBlock, type ViewBlock, type ViewState } from "../domain/views";

/** All block types, in the order the "Show as" menu lists them. Add new block types here. */
export const BLOCK_TYPES: BlockTypeDefinition[] = [tableView, cardsView, componentBlock];

/** The block type for a kind; falls back to the table for unknown (e.g. removed) kinds. */
export const blockType = (kind: string): BlockTypeDefinition => BLOCK_TYPES.find((v) => v.kind === kind) ?? tableView;

/**
 * A block made valid for its collection: its type's options normalized, fields that no longer
 * exist dropped. Keys always in the same order, so a normalized stored block compares equal to
 * the same block shown (sameView).
 */
export function normalizeBlock(collection: Collection, block: ViewBlock): ViewBlock {
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
  return block.groupOrder ? { ...normalized, groupOrder: block.groupOrder } : normalized;
}

/** A view state made valid for its collection (stored ones may be outdated); always at least one block. */
export function normalizeView(collection: Collection, state: ViewState): ViewState {
  // A fixed id: normalizing the same state twice gives the same result.
  const blocks = state.blocks.length > 0 ? state.blocks : [newBlock("table", null, "main")];
  return { filters: state.filters, blocks: blocks.map((b) => normalizeBlock(collection, b)) };
}

export type { BlockOptionsProps, BlockPlace, BlockProps, BlockTypeDefinition, BlockUses, ItemActions, PageItem } from "./registry";
