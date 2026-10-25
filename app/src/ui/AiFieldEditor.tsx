import { Select, SelectItem } from "@carbon/react";
import { AI_OUTPUTS } from "../domain/ai";
import type { AiOutput } from "../domain/model";
import { ComponentCodeEditor } from "./ComponentCodeEditor";

/** What an AI field's value is (text, a number, Markdown); fixed once the field is saved, as its stored form depends on it. */
export function AiOutputSelect({ id, value, locked, onChange }: { id: string; value: AiOutput | null; locked?: boolean; onChange(value: AiOutput): void }) {
  return (
    <Select size="sm" id={id} labelText="Value" value={value ?? "string"} disabled={locked} onChange={(e) => onChange(e.target.value as AiOutput)}>
      {AI_OUTPUTS.map((o) => (
        <SelectItem key={o.value} value={o.value} text={o.text} />
      ))}
    </Select>
  );
}

/**
 * An AI field's prompt: Markdown with {{ }} sections over $item, like a component. `problem` is
 * what is wrong with it (shown once the user tried to save).
 */
export function AiPromptEditor({ id, value, problem, onChange }: { id: string; value: string; problem?: string; onChange(value: string): void }) {
  return (
    <>
      <ComponentCodeEditor
        id={id}
        labelText="Prompt"
        placeholder={"Album by {{ $item.Artist }}. If these albums were sorted by artist last name in a record store, give that last name."}
        helperText="Asked for each item. Put what it needs in with {{ $item.Name }}, e.g. {{ $item.Artist }}; the value is made again only when the prompt, as it reads for that item, changes. Keep it short: the model is told the collection, the field and the shape of the value."
        value={value}
        onChange={onChange}
      />
      {problem && <p className="ai-status ai-status--error">{problem}</p>}
    </>
  );
}
