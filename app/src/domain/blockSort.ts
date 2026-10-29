// The sort a block runs with. Pure (no React), so the UI and the headless API's block queries agree.

import type { Collection } from "./model";
import { defaultQuery, timeSort, type SortRule } from "./query";
import type { ViewBlock } from "./views";

/**
 * The default sort of the block types that have one of their own, by kind; every other kind is by title. A chart (its Last
 * value, its X axis) and a map (its route) are in time order; without a date field a type's default stays the title.
 */
export const DEFAULT_SORTS: Record<string, (collection: Collection) => SortRule[] | null> = { chart: timeSort, map: timeSort };

const TITLE_SORT = defaultQuery().sort;
const sameSort = (a: SortRule[], b: SortRule[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The sort a block runs with: its own once it was chosen (`sortChosen`, set by whatever picks a sort, Title included),
 * else its type's default. A block without the marker is read as unset when its sort is empty or exactly the title sort:
 * blocks stored before the marker all carry the title sort, so there an explicit Title can't be told from "unset" (a one-time
 * ambiguity of old data; picking a sort again marks the block).
 */
export function blockSort(block: ViewBlock, collection: Collection): SortRule[] {
  const unset = !block.sortChosen && (block.sort.length === 0 || sameSort(block.sort, TITLE_SORT));
  return (unset && DEFAULT_SORTS[block.kind]?.(collection)) || block.sort;
}

/** Whether the block's sort is its type's default (what the Sort button leaves unmarked). */
export function isDefaultBlockSort(block: ViewBlock, collection: Collection): boolean {
  return sameSort(blockSort(block, collection), DEFAULT_SORTS[block.kind]?.(collection) ?? TITLE_SORT);
}
