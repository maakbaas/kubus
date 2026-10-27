import { useState } from "react";
import { Button, Dropdown, Stack, Tag, Toggle } from "@carbon/react";
import { useStore } from "../app/store";
import { componentsFor, isAiOutput, placeProblem, type Component, type ComponentCode, type ComponentPlace } from "../domain/components";
import type { Collection } from "../domain/model";
import { ComponentForm } from "./ComponentForm";
import { PromoteComponentModal } from "./PromoteComponentModal";

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
  collection,
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
  /** The collection it is for (Write with AI reads its fields). */
  collection?: Collection;
}) {
  const { components } = useStore();
  const [promoting, setPromoting] = useState(false);
  const asksAi = ai?.value ?? false;
  const offered = componentsFor(components, place, value.componentId, asksAi);
  const shared = value.local ? undefined : components.find((c) => c.id === value.componentId);
  const choices = [LOCAL, ...offered.map((c) => c.id)];
  const nameOf = (choice: string) => (choice === LOCAL ? "Written here" : (components.find((c) => c.id === choice)?.name ?? ""));
  const local = value.local;
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
          {/* The same editor as on a shared component's page (ComponentForm); Ask AI stays above, with the choice. */}
          <ComponentForm
            id={id}
            value={{ ...local, ai: asksAi }}
            onChange={(next) => onChange({ componentId: null, local: next })}
            place={place}
            outputLocked={outputLocked}
            outputHelp={outputLocked ? "Fixed once saved: the values are stored in this form." : undefined}
            invalidText={invalidText}
            writer={{ focus: collection, name: suggestedName ?? "", description: "" }}
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
