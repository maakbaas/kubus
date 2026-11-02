import { reordered, withoutBlock } from "../domain/blockRows";
import type { ViewBlock } from "../domain/views";
import type { ConfirmOptions } from "../ui/useConfirm";
import { useBlockName } from "./BlockListEditor";
import { listRowActions } from "./BlockRows";

/** A change to a list of blocks. */
type BlocksChange = (blocks: ViewBlock[]) => ViewBlock[];

/**
 * Arranging a view's blocks (adding, removing, reordering, side by side; a block's type, options and name), the same on a
 * collection view and a dashboard tab: applied to the shown blocks and to the stored view's alike and stored right away,
 * so it is no change to save (what changes the shown items waits for Save changes).
 */
export function useBlockArrangement({
  blocks,
  storedBlocks,
  setBlocks,
  store,
  keepOne,
  confirm,
  onError,
}: {
  /** The shown blocks. */
  blocks: ViewBlock[];
  /** The stored view's blocks (null: no view yet, only the shown ones change). */
  storedBlocks: ViewBlock[] | null;
  setBlocks(change: BlocksChange): void;
  /** Stores the view with these blocks. */
  store(blocks: ViewBlock[]): Promise<void>;
  /** The last block can't be removed (a collection view keeps one; a dashboard tab may be left empty). */
  keepOne: boolean;
  confirm(options: ConfirmOptions): Promise<boolean>;
  onError(e: unknown): void;
}) {
  const blockName = useBlockName();
  /** `change` on the shown blocks; `stored` (by default the same) on the stored view's, stored when that changes them. */
  async function arrange(change: BlocksChange, stored: BlocksChange = change) {
    setBlocks(change);
    if (!storedBlocks) return;
    const next = stored(storedBlocks);
    if (JSON.stringify(next) === JSON.stringify(storedBlocks)) return;
    await store(next);
  }
  const arrangeNow = (change: BlocksChange, stored?: BlocksChange) => arrange(change, stored).catch(onError);
  return {
    arrange,
    arrangeNow,
    /** A block's type, options or name (where the block is: shown, stored or both). */
    setBlockNow: (id: string, patch: Partial<ViewBlock>) => arrangeNow((list) => list.map((b) => (b.id === id ? { ...b, ...patch } : b))),
    /** Reordered blocks; the stored view's follow the same order (a block no longer under the one it was beside leaves its row). */
    moveBlocks(order: ViewBlock[]) {
      const at = (b: ViewBlock) => order.findIndex((o) => o.id === b.id) >>> 0; // not shown: last
      const ids = (list: ViewBlock[]) => list.map((b) => b.id);
      const sorted = (list: ViewBlock[]) => [...list].sort((a, b) => at(a) - at(b));
      arrangeNow(
        (list) => reordered(ids(list), ids(order), order),
        (list) => reordered(ids(list), ids(sorted(list)), sorted(list)),
      );
    },
    /** Blocks side by side (rows: views/BlockRows.tsx), arranged like the rest. */
    rowActions: listRowActions(blocks, (change) => arrangeNow(change)),
    /** Removing blocks: asked first, unless asked already. */
    async removeBlocks(ids: string[], asked = false) {
      const gone = blocks.filter((b) => ids.includes(b.id));
      if (gone.length === 0 || (keepOne && gone.length >= blocks.length)) return;
      const title = gone.length === 1 ? `Remove block “${blockName(gone[0])}”?` : `Remove ${gone.length} blocks?`;
      if (!asked && !(await confirm({ title, body: "Items are not affected." }))) return;
      await arrange((list) => ids.reduce((rest, id) => withoutBlock(rest.map((b) => b.id), rest, id), list));
    },
  };
}
