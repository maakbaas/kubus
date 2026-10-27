import { useId, useMemo } from "react";
import { Code as ComponentIcon } from "@carbon/icons-react";
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
import { ComponentChoice } from "../ui/ComponentChoice";
import { ComponentValue } from "../ui/ComponentValue";
import { useBuffered } from "../ui/useBuffered";
import { refLabelOf } from "../ui/useReferenceOptions";
import { defineBlockType, type BlockOptionsProps, type BlockProps } from "./registry";

// A block that shows a component: a block component, which lists the block's items ($items,
// $groups, $fields, $all), or a static one (neither). Never one that uses $item, also not on an
// item page: that is a field component (a block on an item page filters on the page's item instead).
// The component is shared (picked by id) or the block's own (local), written in its settings.

export interface ComponentBlockOptions {
  componentId: string | null;
  /** Its own component, written here; null = the shared `componentId`. */
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

function ComponentBlockOptionsEditor({ options, onChange }: BlockOptionsProps<ComponentBlockOptions>) {
  const uid = useId();
  // Its code is typed here and stored after a pause (each change of a block's options is stored).
  const [draft, update] = useBuffered(options, onChange);
  return (
    <div className="view-options view-options--stack">
      <ComponentChoice id={`${uid}-block`} place="block" value={draft} onChange={(ref) => update({ componentId: ref.local ? null : ref.componentId, local: ref.local })} />
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
  // A new one starts with its own (empty) component, written in its settings.
  defaultOptions: () => ({ componentId: null, local: { code: "", output: "markdown", frameRatio: null, ai: false } }),
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
