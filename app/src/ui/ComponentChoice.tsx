import { useState } from "react";
import { Button, Dropdown, Stack, Tag } from "@carbon/react";
import { useStore } from "../app/store";
import { componentsFor, isAiOutput, placeProblem, type Component, type ComponentCode } from "../domain/components";
import type { Collection } from "../domain/model";
import { ComponentForm } from "./ComponentForm";
import { PromoteComponentModal } from "./PromoteComponentModal";
import { ValueSourceSwitch } from "./ValueSourceSwitch";

/** A field's component: a shared one it picks, or its own (local, written in place). */
export interface ComponentRef {
  componentId: string | null;
  local: ComponentCode | null;
}

/** The dropdown's entry for writing the component here (not "": Carbon takes that for nothing chosen). */
const LOCAL = "local";

/**
 * Chooses a component or AI field's component: local (a component owned by the field: output, code
 * and "Save as shared component") or a shared one, picked by name (only those that fit a field).
 * The Value switch (code or AI prompt) first: the component's text is then a prompt, and the field
 * stores the model's replies; fixed once the field is saved. (Blocks only pick shared components:
 * views/ComponentBlock.tsx.)
 */
export function ComponentChoice({
  id,
  value,
  onChange,
  ai,
  outputLocked = false,
  invalidText,
  suggestedName,
  collection,
}: {
  id: string;
  value: ComponentRef;
  onChange(value: ComponentRef): void;
  /** Whether the component asks AI, and whether that can still change. */
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
  const offered = componentsFor(components, "field", value.componentId, asksAi);
  const shared = value.local ? undefined : components.find((c) => c.id === value.componentId);
  const choices = [LOCAL, ...offered.map((c) => c.id)];
  const nameOf = (choice: string) => (choice === LOCAL ? "Local" : (components.find((c) => c.id === choice)?.name ?? ""));
  const local = value.local;
  const blank = (aiNow: boolean): ComponentCode => ({ code: "", output: aiNow ? "string" : "markdown", frameRatio: null, ai: aiNow });

  return (
    <Stack gap={5}>
      {ai && (
        <ValueSourceSwitch
          id={id}
          ai={ai.value}
          locked={ai.locked}
          onChange={(on) => {
            ai.onChange(on);
            // A shared component that doesn't ask the same goes; a local one keeps its code, the output follows.
            if (local) onChange({ componentId: null, local: { ...local, ai: on, output: on && !isAiOutput(local.output) ? "string" : local.output } });
            else if (shared && shared.ai !== on) onChange({ componentId: null, local: blank(on) });
          }}
        />
      )}
      <Dropdown<string>
        autoAlign
        size="sm"
        id={`${id}-component`}
        titleText={asksAi ? "Prompt" : "Component"}
        label="Choose…"
        helperText={local ? "Local: only this field uses it." : shared ? "Shared: a change applies everywhere it is used." : undefined}
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
          {/* The same editor as on a shared component's page (ComponentForm); the Value switch stays above, with the choice. */}
          <ComponentForm
            id={id}
            value={{ ...local, ai: asksAi }}
            onChange={(next) => onChange({ componentId: null, local: next })}
            place="field"
            outputLocked={outputLocked}
            outputHelp={outputLocked ? "Fixed once saved: the values are stored in this form." : undefined}
            invalidText={invalidText}
            writer={{ focus: collection, name: suggestedName ?? "", description: "" }}
          />
          {/* Always there (in a panel above its button, appearing would move the editor): enabled once there is code that fits. */}
          <div>
            <Button size="sm" kind="tertiary" disabled={!local.code.trim() || !!placeProblem(local, "field")} onClick={() => setPromoting(true)}>
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
