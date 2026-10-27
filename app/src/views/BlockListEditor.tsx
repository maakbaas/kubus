import { FormGroup, IconButton } from "@carbon/react";
import { Tag, TagNone, TrashCan } from "@carbon/icons-react";
import { useStore } from "../app/store";
import type { ViewBlock } from "../domain/views";
import { moveBlock, useReorder } from "../ui/useReorder";
import { blockType } from ".";
import { AddBlockButton, type NewBlockSpec } from "./AddBlockButton";
import type { ComponentBlockOptions } from "./ComponentBlock";

/** A block's name (its heading, its row in lists): its title, else its component's name or its type ("Table", "Cards"). */
export function useBlockName() {
  const { components } = useStore();
  return (block: ViewBlock) => {
    if (block.title) return block.title;
    const type = blockType(block.kind);
    const options = block.options as ComponentBlockOptions;
    const component = type.kind === "component" && !options.local ? components.find((c) => c.id === options.componentId) : undefined;
    return component?.name ?? type.label;
  };
}

/**
 * A view's blocks: reorder (drag, or arrows on a handle), show or hide their header, remove (a view keeps one), add.
 * `onRemove` asks first unless `asked` (the list's own Delete key confirmation asked already).
 */
export function BlockListEditor({
  blocks,
  onMove,
  onRemove,
  onAdd,
  onHeader,
}: {
  blocks: ViewBlock[];
  onMove(blocks: ViewBlock[]): void;
  /** Shows or hides a block's header (a block without one can't be collapsed). */
  onHeader(id: string, shown: boolean): void;
  onRemove(ids: string[], asked: boolean): void;
  onAdd(spec: NewBlockSpec): void;
}) {
  const name = useBlockName();
  const reorder = useReorder({
    count: blocks.length,
    onMove: (start, end, to) => onMove(moveBlock(blocks, start, end, to)),
    onDelete: (indices) => onRemove(blocks.filter((_, i) => indices.includes(i)).map((b) => b.id), true),
    canDelete: (indices) => indices.length < blocks.length,
    noun: ["block", "blocks"],
  });
  return (
    <FormGroup legendText="Blocks" className="field-order">
      {blocks.map((b, i) => {
        const Icon = blockType(b.kind).icon;
        return (
          <div key={b.id} className="field-order__row" {...reorder.row(i)}>
            <span className="view-kind block-list__name">
              <Icon />
              {name(b)}
            </span>
            <span className="field-order__moves">
              <IconButton
                autoAlign
                kind="ghost"
                size="sm"
                label={b.hideHeader ? "Show block header" : "Hide block header"}
                isSelected={!!b.hideHeader}
                onClick={() => onHeader(b.id, !!b.hideHeader)}
              >
                {b.hideHeader ? <TagNone /> : <Tag />}
              </IconButton>
              {blocks.length > 1 && (
                <IconButton autoAlign kind="ghost" size="sm" label="Remove block" onClick={() => onRemove([b.id], false)}>
                  <TrashCan />
                </IconButton>
              )}
              {reorder.handle(i)}
            </span>
          </div>
        );
      })}
      <AddBlockButton className="field-order__add" onAdd={onAdd} />
      {reorder.dialog}
    </FormGroup>
  );
}
