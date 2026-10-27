import { MenuButton, MenuItem } from "@carbon/react";
import { useStore } from "../app/store";
import { BLOCK_TYPES, blockType } from ".";
import { blockComponents, type ComponentBlockOptions } from "./ComponentBlock";

/** What "Add block" adds: a new block of a type (a component block: with its component). */
export interface NewBlockSpec {
  kind: string;
  options?: unknown;
}

/**
 * The "Add block" button: a menu of what to add. A block of each type (a component block with
 * its own component), one per shared block or static component.
 */
export function AddBlockButton({
  className,
  onAdd,
}: {
  className?: string;
  onAdd(spec: NewBlockSpec): void;
}) {
  const { components } = useStore();
  const ComponentIcon = blockType("component").icon;
  return (
    <MenuButton label="Add block" kind="tertiary" size="sm" menuAlignment="bottom-start" className={className}>
      {/* A component block from here starts with its own component, written in its settings. */}
      {BLOCK_TYPES.map((t) => (
        <MenuItem key={t.kind} label={t.kind === "component" ? "Component (local)" : t.label} renderIcon={t.icon} onClick={() => onAdd({ kind: t.kind })} />
      ))}
      {blockComponents(components).map((c) => (
        <MenuItem
          key={c.id}
          label={c.name}
          renderIcon={ComponentIcon}
          onClick={() => onAdd({ kind: "component", options: { componentId: c.id, local: null } satisfies ComponentBlockOptions })}
        />
      ))}
    </MenuButton>
  );
}
