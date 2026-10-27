import { useId, useMemo } from "react";
import { Button, Dropdown } from "@carbon/react";
import { Code as ComponentIcon } from "@carbon/icons-react";
import { useStore } from "../app/store";
import {
  blockArgValue,
  componentUses,
  ERROR_PREFIX,
  componentsFor,
  itemsInput,
  placeProblem,
  render,
  type BlockInputs,
  type Component,
} from "../domain/components";
import type { ComponentArg } from "../domain/model";
import { ComponentArgInput } from "../ui/ComponentArgInput";
import { ComponentValue } from "../ui/ComponentValue";
import { refLabelOf } from "../ui/useReferenceOptions";
import { defineBlockType, type BlockOptionsProps, type BlockProps } from "./registry";

// A block that shows a component: a block component, which lists the block's items ($items,
// $groups, $fields, $all), or a static one (neither). Never one that uses $item, also not on an
// item page: that is a field component (a block on an item page filters on the page's item instead).
// Its variables take a fixed value or a field of the block's collection, given as the field's
// name (which field to use, e.g. a chart's values), not a value.

export interface ComponentBlockOptions {
  componentId: string | null;
  args: Record<string, ComponentArg>;
}

function ComponentBlockView({ collection, result, fields, options, refs, all }: BlockProps<ComponentBlockOptions>) {
  const { components } = useStore();
  const component = components.find((c) => c.id === options.componentId);
  const value = useMemo(() => {
    if (!component) return `${ERROR_PREFIX}${options.componentId ? "Component not found" : "No component chosen"}`;
    const problem = placeProblem(component.code, "block");
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
    const byId = new Map(collection.fields.map((f) => [f.id, f]));
    const args = component.params.map((p) => blockArgValue(options.args[p], byId));
    return render(component, args, undefined, undefined, block);
  }, [component, options, collection, result, fields, refs, all]);
  return (
    <div className="component-block">
      <ComponentValue value={value} output={component?.output ?? "markdown"} frameRatio={component?.frameRatio} variant="page" />
    </div>
  );
}

/** Components a block can show: block and static ones. */
export const blockComponents = (components: Component[], chosen?: string | null) => componentsFor(components, "block", chosen);

function ComponentBlockOptionsEditor({ collection, options, onChange }: BlockOptionsProps<ComponentBlockOptions>) {
  const uid = useId();
  const { components } = useStore();
  const offered = blockComponents(components, options.componentId);
  const component = components.find((c) => c.id === options.componentId);
  return (
    <div className="view-options">
      <Dropdown<Component>
        autoAlign
        size="sm"
        id={`${uid}-component`}
        titleText="Component"
        label="Choose a component"
        items={offered}
        // Carbon takes null (nothing chosen) at runtime; its types only say undefined.
        selectedItem={component ?? (null as unknown as Component)}
        itemToString={(c) => c?.name ?? ""}
        onChange={({ selectedItem }) => selectedItem && onChange({ componentId: selectedItem.id, args: {} })}
      />
      {/* Its code is shared by every place showing it: edited on its own page, never from the block. */}
      {component && (
        <Button kind="tertiary" size="sm" href={`#/components/${component.id}`}>
          Edit component
        </Button>
      )}
      {component?.params.map((p) => (
        <ComponentArgInput
          // A new component starts its variables afresh.
          key={`${component.id}-${p}`}
          id={`${uid}-arg-${p}`}
          param={p}
          fields={collection.fields}
          value={options.args[p]}
          onChange={(arg) => {
            const { [p]: _old, ...rest } = options.args;
            onChange({ ...options, args: arg ? { ...rest, [p]: arg } : rest });
          }}
        />
      ))}
    </div>
  );
}

export const componentBlock = defineBlockType<ComponentBlockOptions>({
  kind: "component",
  label: "Component",
  icon: ComponentIcon,
  defaultOptions: () => ({ componentId: null, args: {} }),
  normalizeOptions(raw) {
    const o = (raw ?? {}) as Partial<ComponentBlockOptions>;
    const args: Record<string, ComponentArg> = {};
    for (const [k, v] of Object.entries(o.args ?? {})) {
      if (v && typeof v === "object" && (("field" in v && typeof v.field === "string") || ("value" in v && typeof v.value === "string"))) args[k] = v;
    }
    return { componentId: typeof o.componentId === "string" ? o.componentId : null, args };
  },
  // By what its code uses: a static component has no filter, sort or fields.
  uses(options, components) {
    const component = components.find((c) => c.id === options.componentId);
    const uses = component ? componentUses(component.code) : null;
    return { query: !!uses?.items, groups: !!uses?.groups, fields: uses?.fields ? { labels: false, hideEmpty: false } : null };
  },
  View: ComponentBlockView,
  OptionsEditor: ComponentBlockOptionsEditor,
});
