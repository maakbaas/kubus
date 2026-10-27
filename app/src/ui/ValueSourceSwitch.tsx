import { ContentSwitcher, Switch } from "@carbon/react";

/**
 * Where a component's value comes from: its code ({{ }} worked out here) or an AI prompt (the
 * language model writes it). Both are shown, so the editor changing below is plainly the
 * consequence. Locked (both switches disabled) once an AI field is saved.
 */
export function ValueSourceSwitch({ id, ai, locked, onChange }: { id: string; ai: boolean; locked: boolean; onChange(ai: boolean): void }) {
  return (
    <div>
      <span className="cds--label" id={`${id}-source-label`}>
        Value
      </span>
      <ContentSwitcher size="sm" aria-labelledby={`${id}-source-label`} selectedIndex={ai ? 1 : 0} onChange={({ index }) => index !== undefined && onChange(index === 1)}>
        <Switch name="code" text="Code" disabled={locked} />
        <Switch name="ai" text="AI prompt" disabled={locked} />
      </ContentSwitcher>
      <p className="helper field-settings__note">{ai ? "The language model writes the value from a prompt." : "{{ }} code works out the value."}</p>
    </div>
  );
}
