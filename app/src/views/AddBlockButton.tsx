import { MenuButton, MenuItem } from "@carbon/react";
import { useStore } from "../app/store";
import { BLOCK_TYPES, blockType } from ".";
import type { BlockPlace } from "./registry";
import { blockComponents, type ComponentBlockOptions } from "./ComponentBlock";

/** What "Add block" adds: a new block of a type (a component block: with its component). */
export interface NewBlockSpec {
  kind: string;
  options?: unknown;
}

/**
 * The "Add block" button: a menu of what to add. A block of each type, one per component that
 * fits the place (a collection view has no item for those that use $item).
 */
export function AddBlockButton({
  place,
  className,
  onAdd,
}: {
  place: BlockPlace;
  className?: string;
  onAdd(spec: NewBlockSpec): void;
}) {
  const { components } = useStore();
  const ComponentIcon = blockType("component").icon;
  return (
    <MenuButton label="Add block" kind="tertiary" size="sm" menuAlignment="bottom-start" className={className}>
      {BLOCK_TYPES.filter((t) => t.kind !== "component").map((t) => (
        <MenuItem key={t.kind} label={t.label} renderIcon={t.icon} onClick={() => onAdd({ kind: t.kind })} />
      ))}
      {blockComponents(components, place).map((c) => (
        <MenuItem
          key={c.id}
          label={c.name}
          renderIcon={ComponentIcon}
          onClick={() => onAdd({ kind: "component", options: { componentId: c.id, args: {} } satisfies ComponentBlockOptions })}
        />
      ))}
    </MenuButton>
  );
}
