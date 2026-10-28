import { useId, useMemo, useState } from "react";
import { Button, Dropdown, InlineNotification, Stack } from "@carbon/react";
import { Add, Code as ComponentIcon } from "@carbon/icons-react";
import { useStore } from "../app/store";
import {
  componentUses,
  ERROR_PREFIX,
  componentsFor,
  isComponentOutput,
  itemsInput,
  placeProblem,
  render,
  type BlockInputs,
  type Component,
  type ComponentCode,
} from "../domain/components";
import { ComponentValue } from "../ui/ComponentValue";
import { PromoteComponentModal } from "../ui/PromoteComponentModal";
import { refLabelOf } from "../ui/useReferenceOptions";
import { useOpenRelated } from "../workspace/Workspace";
import { defineBlockType, type BlockOptionsProps, type BlockProps } from "./registry";

// A block that shows a component: a block component, which lists the block's items ($items,
// $groups, $fields, $all), or a static one (neither). Never one that uses $item, also not on an
// item page: that is a field component (a block on an item page filters on the page's item instead).
// The component is a shared one, picked by id and written on its own page (Components), never in the
// block's settings. A block's own (local) component, from an earlier version, still shows; its
// settings offer only to save it as a shared one.

export interface ComponentBlockOptions {
  componentId: string | null;
  /** Its own (local) component, from an earlier version (none are made now); null = the shared `componentId`. */
  local: ComponentCode | null;
}

/** The component a block shows: its own, else the shared one it picks. */
export const blockComponent = (options: ComponentBlockOptions, components: Component[]): ComponentCode | undefined =>
  options.local ?? components.find((c) => c.id === options.componentId);

function ComponentBlockView({ collection, result, fields, options, refs, all }: BlockProps<ComponentBlockOptions>) {
  const { components } = useStore();
  const component = blockComponent(options, components);
  const value = useMemo(() => {
    if (!component) return `${ERROR_PREFIX}${options.componentId ? "Component not found" : "No component chosen"}`;
    if (!component.code.trim()) return null;
    const problem = placeProblem(component, "block");
    if (problem) return ERROR_PREFIX + problem;
    const uses = componentUses(component.code);
    const input = itemsInput(collection, refLabelOf(refs));
    // An item in several groups is in $items once.
    const items = uses.items ? [...new Set(result.groups.flatMap((g) => g.items))] : [];
    const block: BlockInputs = {
      items: items.map(input),
      groups: uses.items ? result.groups.map((g) => ({ key: g.key, label: g.label, items: g.items.map(input) })) : [],
      fields: fields.map((f) => ({ id: f.id, name: f.name, kind: f.kind })),
      all: /\$all\b/.test(component.code) ? all.map(input) : [],
    };
    return render(component, undefined, undefined, block);
  }, [component, options.componentId, collection, result, fields, refs, all]);
  return (
    <div className="component-block">
      <ComponentValue value={value} output={component?.output ?? "markdown"} frameRatio={component?.frameRatio} variant="page" />
    </div>
  );
}

/** Components a block can show: block and static ones. */
export const blockComponents = (components: Component[], chosen?: string | null) => componentsFor(components, "block", chosen);

/**
 * A new shared component for a block: named in a dialog, picked by the block (`onCreated`), then
 * opened beside the page to be written there, with the block in view.
 */
export function NewBlockComponentModal({
  suggestedName,
  onClose,
  onCreated,
}: {
  suggestedName?: string;
  onClose(): void;
  onCreated(component: Component): void | Promise<void>;
}) {
  const openRelated = useOpenRelated();
  return (
    <PromoteComponentModal
      fresh
      local={{ code: "", output: "markdown", frameRatio: null, ai: false }}
      suggestedName={suggestedName}
      onClose={onClose}
      onPromoted={async (c) => {
        await onCreated(c);
        openRelated(`/components/${c.id}`, "beside");
      }}
    />
  );
}

function ComponentBlockOptionsEditor({ collection, options, onChange }: BlockOptionsProps<ComponentBlockOptions>) {
  const uid = useId();
  const { components } = useStore();
  const [dialog, setDialog] = useState<"new" | "promote" | null>(null);
  const { local } = options;
  const shared = local ? undefined : components.find((c) => c.id === options.componentId);
  const offered = blockComponents(components, options.componentId);
  const pick = (componentId: string) => onChange({ componentId, local: null });
  return (
    <div className="view-options view-options--stack">
      <Stack gap={5}>
        {local ? (
          <>
            {/* Written in its settings by an earlier version: shown as it is, edited once it is shared. */}
            <InlineNotification kind="info" lowContrast hideCloseButton title="Its own component" subtitle="Save it as a shared component to edit it on its page." />
            <div>
              <Button size="sm" kind="tertiary" disabled={!local.code.trim() || !!placeProblem(local, "block")} onClick={() => setDialog("promote")}>
                Save as shared component
              </Button>
            </div>
          </>
        ) : (
          <>
            <Dropdown<string>
              autoAlign
              size="sm"
              id={`${uid}-component`}
              titleText="Component"
              label="Choose…"
              helperText={shared ? "Shared: a change applies everywhere it is used." : undefined}
              items={offered.map((c) => c.id)}
              // Carbon accepts null (nothing chosen yet) at runtime; its types only say undefined.
              selectedItem={(shared?.id ?? null) as string}
              itemToString={(id) => components.find((c) => c.id === id)?.name ?? ""}
              onChange={({ selectedItem }) => selectedItem && pick(selectedItem)}
            />
            <div className="block-component__actions">
              {/* Its code is shared by every place showing it: written on its own page. */}
              {shared && (
                <Button size="sm" kind="tertiary" renderIcon={ComponentIcon} href={`#/components/${shared.id}`}>
                  Edit component
                </Button>
              )}
              <Button size="sm" kind="tertiary" renderIcon={Add} onClick={() => setDialog("new")}>
                New component
              </Button>
            </div>
          </>
        )}
      </Stack>
      {dialog === "new" && (
        <NewBlockComponentModal
          suggestedName={`${collection.name} block`}
          onClose={() => setDialog(null)}
          onCreated={(c) => {
            setDialog(null);
            pick(c.id);
          }}
        />
      )}
      {dialog === "promote" && local && (
        <PromoteComponentModal
          local={local}
          suggestedName={`${collection.name} block`}
          onClose={() => setDialog(null)}
          onPromoted={(c) => {
            setDialog(null);
            pick(c.id);
          }}
        />
      )}
    </div>
  );
}

/** A stored local component, or null when it isn't one. */
function normalizeLocal(raw: unknown): ComponentCode | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<ComponentCode>;
  if (typeof o.code !== "string") return null;
  return { code: o.code, output: isComponentOutput(o.output) ? o.output : "markdown", frameRatio: typeof o.frameRatio === "string" ? o.frameRatio : null, ai: false };
}

export const componentBlock = defineBlockType<ComponentBlockOptions>({
  kind: "component",
  label: "Component",
  icon: ComponentIcon,
  // A new one picks a shared component in its settings ("Add block" offers them, and a new one, directly).
  defaultOptions: () => ({ componentId: null, local: null }),
  normalizeOptions(raw) {
    const o = (raw ?? {}) as { componentId?: unknown; local?: unknown };
    const local = normalizeLocal(o.local);
    return { componentId: !local && typeof o.componentId === "string" ? o.componentId : null, local };
  },
  // By what its code uses: a static component has no filter, sort or fields.
  uses(options, components) {
    const component = blockComponent(options, components);
    const uses = component ? componentUses(component.code) : null;
    return { query: !!uses?.items, groups: !!uses?.groups, fields: uses?.fields ? { labels: false, hideEmpty: false } : null };
  },
  View: ComponentBlockView,
  OptionsEditor: ComponentBlockOptionsEditor,
});
