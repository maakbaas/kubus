import { useState } from "react";
import { MenuButton, MenuItem } from "@carbon/react";
import { useStore } from "../app/store";
import { BLOCK_TYPES, blockType } from ".";
import { blockComponents, NewBlockComponentModal, type ComponentBlockOptions } from "./ComponentBlock";

/** What "Add block" adds: a new block of a type (a component block: with its component). */
export interface NewBlockSpec {
  kind: string;
  options?: unknown;
}

/**
 * The "Add block" button: a menu of what to add. A block of each type, one per shared block or
 * static component, and "New component…": a new shared component (named here, written on its page,
 * opened beside) shown by a new block.
 */
export function AddBlockButton({
  className,
  onAdd,
}: {
  className?: string;
  onAdd(spec: NewBlockSpec): void;
}) {
  const { components } = useStore();
  const [creating, setCreating] = useState(false);
  const ComponentIcon = blockType("component").icon;
  const showing = (componentId: string): NewBlockSpec => ({ kind: "component", options: { componentId, local: null } satisfies ComponentBlockOptions });
  return (
    <>
      <MenuButton label="Add block" kind="tertiary" size="sm" menuAlignment="bottom-start" className={className}>
        {BLOCK_TYPES.map((t) =>
          t.kind === "component" ? (
            <MenuItem key={t.kind} label="New component…" renderIcon={t.icon} onClick={() => setCreating(true)} />
          ) : (
            <MenuItem key={t.kind} label={t.label} renderIcon={t.icon} onClick={() => onAdd({ kind: t.kind })} />
          ),
        )}
        {blockComponents(components).map((c) => (
          <MenuItem key={c.id} label={c.name} renderIcon={ComponentIcon} onClick={() => onAdd(showing(c.id))} />
        ))}
      </MenuButton>
      {creating && (
        <NewBlockComponentModal
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            onAdd(showing(c.id));
          }}
        />
      )}
    </>
  );
}
