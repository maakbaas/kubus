import { useState } from "react";
import { Button, Dropdown, Select, SelectItem, Stack, Tag, Toggle } from "@carbon/react";
import { useStore } from "../app/store";
import {
  AI_COMPONENT_OUTPUTS,
  COMPONENT_OUTPUTS,
  componentsFor,
  isAiOutput,
  kindText,
  placeProblem,
  type Component,
  type ComponentCode,
  type ComponentPlace,
} from "../domain/components";
import { ComponentCodeEditor } from "./ComponentCodeEditor";
import { PromoteComponentModal } from "./PromoteComponentModal";

/** What the code editor says about the built-in $ names (also on the component page). */
export const CODE_HELP =
  "Markdown with {{ JavaScript }} sections. Built in: $now (the current date); $item, one item: its fields by name ($item.Pages, $item[\"Read at\"]); a block's $items, $groups, $fields and $all. Help has the rest.";
/** …and about a prompt, when the component asks AI. */
export const PROMPT_HELP =
  "Asked for each item. Put what it needs in with {{ $item.Name }}, e.g. {{ $item.Artist }}; the value is made again only when the prompt, as it reads for that item, changes. Only $item is here: no $now (the value would be stale every moment) and no other AI fields (two reading each other never settle). Keep it short: the model is told the collection, the field and the shape of the value.";

/** A place's component: a shared one it picks, or its own (local), written here. */
export interface ComponentRef {
  componentId: string | null;
  local: ComponentCode | null;
}

/** The dropdown's entry for writing the component here (not "": Carbon takes that for nothing chosen). */
const LOCAL = "local";

/**
 * Chooses a place's component (a component field, a component block): written here (a local
 * component, owned by the place: output, code and "Save as shared component") or a shared one,
 * picked by name (only those that fit the place). For fields, "Ask AI" first: the component's text
 * is then a prompt, and the field stores the model's replies; fixed once the field is saved.
 */
export function ComponentChoice({
  id,
  place,
  value,
  onChange,
  ai,
  outputLocked = false,
  invalidText,
  suggestedName,
}: {
  id: string;
  place: ComponentPlace;
  value: ComponentRef;
  onChange(value: ComponentRef): void;
  /** Fields only: whether the component asks AI, and whether that can still change. */
  ai?: { value: boolean; locked: boolean; onChange(ai: boolean): void };
  /** The output is fixed (an AI field's, once saved: its values are stored in that form). */
  outputLocked?: boolean;
  invalidText?: string;
  /** The name "Save as shared component" suggests. */
  suggestedName?: string;
}) {
  const { components } = useStore();
  const [promoting, setPromoting] = useState(false);
  const asksAi = ai?.value ?? false;
  const offered = componentsFor(components, place, value.componentId, asksAi);
  const shared = value.local ? undefined : components.find((c) => c.id === value.componentId);
  const choices = [LOCAL, ...offered.map((c) => c.id)];
  const nameOf = (choice: string) => (choice === LOCAL ? "Written here" : (components.find((c) => c.id === choice)?.name ?? ""));
  const local = value.local;
  const outputs = asksAi ? COMPONENT_OUTPUTS.filter((o) => AI_COMPONENT_OUTPUTS.includes(o.value)) : COMPONENT_OUTPUTS;
  const blank = (aiNow: boolean): ComponentCode => ({ code: "", output: aiNow ? "string" : "markdown", frameRatio: null, ai: aiNow });

  return (
    <Stack gap={5}>
      {ai && (
        <Toggle
          size="sm"
          id={`${id}-ai`}
          labelText="Ask AI"
          labelA="Off"
          labelB="On: the language model writes the value"
          toggled={ai.value}
          disabled={ai.locked}
          onToggle={(on: boolean) => {
            ai.onChange(on);
            // A shared component that doesn't ask the same goes; written here, the output follows.
            if (local) onChange({ componentId: null, local: { ...local, ai: on, output: on && !isAiOutput(local.output) ? "string" : local.output } });
            else if (shared && shared.ai !== on) onChange({ componentId: null, local: blank(on) });
          }}
        />
      )}
      <Dropdown<string>
        autoAlign
        size="sm"
        id={`${id}-component`}
        titleText="Component"
        label="Choose…"
        helperText={local ? `Written here: only this ${place === "field" ? "field" : "block"} uses it.` : shared ? "Shared: a change applies everywhere it is used." : undefined}
        items={choices}
        // Carbon accepts null (nothing chosen yet) at runtime; its types only say undefined.
        selectedItem={(local ? LOCAL : shared ? shared.id : null) as string}
        itemToString={(c) => (c == null ? "" : nameOf(c))}
        itemToElement={(c) => <ChoiceLabel name={nameOf(c)} component={components.find((x) => x.id === c)} />}
        onChange={({ selectedItem: c }) => {
          if (c == null) return;
          onChange(c === LOCAL ? { componentId: null, local: local ?? blank(asksAi) } : { componentId: c, local: null });
        }}
        invalid={!local && !!invalidText}
        invalidText={invalidText}
      />
      {local && (
        <>
          <Select
            size="sm"
            id={`${id}-output`}
            labelText="Output"
            value={local.output}
            disabled={outputLocked}
            helperText={outputLocked ? "Fixed once saved: the values are stored in this form." : undefined}
            onChange={(e) => onChange({ componentId: null, local: { ...local, output: e.target.value as ComponentCode["output"] } })}
          >
            {outputs.map((o) => (
              <SelectItem key={o.value} value={o.value} text={o.text} />
            ))}
          </Select>
          <ComponentCodeEditor
            id={`${id}-code`}
            labelText={asksAi ? "Prompt" : "Code"}
            html={local.output === "html"}
            placeholder={
              asksAi
                ? "Album by {{ $item.Artist }}. If these albums were sorted by artist last name in a record store, give that last name."
                : place === "field"
                  ? "{{ Math.round($item.Pages / 40) }} h of reading"
                  : "{{ $items.length }} items"
            }
            helperText={asksAi ? PROMPT_HELP : `${kindText(local.code)} ${CODE_HELP}`}
            invalidText={invalidText ?? (local.code.trim() ? (placeProblem(local, place) ?? undefined) : undefined)}
            value={local.code}
            onChange={(code) => onChange({ componentId: null, local: { ...local, code } })}
          />
          {/* Always there (in a panel above its button, appearing would move the editor): enabled once there is code that fits. */}
          <div>
            <Button size="sm" kind="tertiary" disabled={!local.code.trim() || !!placeProblem(local, place)} onClick={() => setPromoting(true)}>
              Save as shared component
            </Button>
          </div>
        </>
      )}
      {shared && (
        <div>
          {/* Its code is shared by every place showing it: edited on its own page. */}
          <Button size="sm" kind="tertiary" href={`#/components/${shared.id}`}>
            Edit component
          </Button>
        </div>
      )}
      {promoting && local && (
        <PromoteComponentModal
          local={local}
          suggestedName={suggestedName}
          onClose={() => setPromoting(false)}
          onPromoted={(c) => {
            setPromoting(false);
            onChange({ componentId: c.id, local: null });
          }}
        />
      )}
    </Stack>
  );
}

/** A choice in the list: its name, and "AI" for a component that asks AI. */
function ChoiceLabel({ name, component }: { name: string; component?: Component }) {
  return (
    <span className="component-choice">
      <span className="component-choice__name">{name}</span>
      {component?.ai && (
        <Tag size="sm" type="purple">
          AI
        </Tag>
      )}
    </span>
  );
}
