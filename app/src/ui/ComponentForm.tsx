import { Select, SelectItem, Stack, Toggle } from "@carbon/react";
import {
  AI_COMPONENT_OUTPUTS,
  COMPONENT_OUTPUTS,
  FRAME_RATIOS,
  codeProblem,
  isAiOutput,
  kindText,
  placeProblem,
  type ComponentCode,
  type ComponentOutput,
  type ComponentPlace,
} from "../domain/components";
import type { Collection } from "../domain/model";
import { ComponentCodeEditor } from "./ComponentCodeEditor";
import { WriteWithAi } from "./WriteWithAi";

/** What the code editor says about the built-in $ names. */
export const CODE_HELP =
  "Markdown with {{ JavaScript }} sections. Built in: $now (the current date); $item, one item: its fields by name ($item.Pages, $item[\"Read at\"]); a block's $items, $groups, $fields and $all. Help has the rest.";
/** …and about a prompt, when the component asks AI. */
export const PROMPT_HELP =
  "Asked for each item. Put what it needs in with {{ $item.Name }}, e.g. {{ $item.Artist }}; the value is made again only when the prompt, as it reads for that item, changes. Only $item is here: no $now (the value would be stale every moment) and no other AI fields (two reading each other never settle). Keep it short: the model is told the collection, the field and the shape of the value.";

/**
 * The editor of a component's code, the same wherever a component is written: on its own page
 * (a shared one) and in place (a field's or block's own): Ask AI, Write with AI, Output, the code
 * with what kind it makes and what is wrong with it, and for HTML that fills its box its shape.
 * The page adds what belongs to a shared component around it (name, description, the preview).
 */
export function ComponentForm({
  id,
  value,
  onChange,
  place,
  askAi,
  outputLocked,
  outputHelp,
  invalidText,
  fills = true,
  writer,
}: {
  id: string;
  value: ComponentCode;
  onChange(value: ComponentCode): void;
  /** Where it is shown, when it is used in one place (its code is checked for it); none: anywhere (the page). */
  place?: ComponentPlace;
  /** The Ask AI switch, when it is shown here (fields keep theirs with the choice of component). */
  askAi?: { locked: boolean; help?: string };
  /** The output is fixed (an AI field's, once saved: its values are stored in that form). */
  outputLocked?: boolean;
  outputHelp?: string;
  /** What is wrong (overrides what the code itself shows). */
  invalidText?: string;
  /** HTML output fills its box (no height of its own): then its shape can be chosen. */
  fills?: boolean;
  /** Write with AI: the collection it is for, the name and description to give the model, and where its suggestion's name and description go. */
  writer?: { focus?: Collection; name: string; description: string; onNamed?(name: string, description: string): void };
}) {
  const ai = value.ai;
  const outputs = ai ? COMPONENT_OUTPUTS.filter((o) => AI_COMPONENT_OUTPUTS.includes(o.value)) : COMPONENT_OUTPUTS;
  const problem = invalidText ?? (value.code.trim() ? ((place ? placeProblem(value, place) : ai ? placeProblem(value, "field") : codeProblem(value.code)) ?? undefined) : undefined);
  const set = (patch: Partial<ComponentCode>) => onChange({ ...value, ...patch });
  return (
    <Stack gap={5}>
      {askAi && (
        <Toggle
          size="sm"
          id={`${id}-ai`}
          labelText="Ask AI"
          labelA="Off"
          labelB="On: the text is a prompt; the language model writes an AI field's value"
          toggled={ai}
          disabled={askAi.locked}
          onToggle={(on: boolean) => set({ ai: on, output: on && !isAiOutput(value.output) ? "string" : value.output })}
        />
      )}
      {askAi?.help && <p className="helper field-settings__note">{askAi.help}</p>}
      {/* A few words in, the model writes the code (it changes this editor only, nothing is saved). */}
      <WriteWithAi
        id={`${id}-write`}
        current={{ name: writer?.name ?? "", description: writer?.description ?? "", output: value.output, code: value.code }}
        focus={writer?.focus}
        ai={ai}
        onApply={(s) => {
          set({ code: s.code, ...(!outputLocked && { output: ai && !isAiOutput(s.output) ? "string" : s.output }) });
          writer?.onNamed?.(s.name, s.description);
        }}
      />
      {/* What the result is: how it shows on pages, in tables and cards (and how it sorts). */}
      <Select
        size="sm"
        id={`${id}-output`}
        labelText="Output"
        value={value.output}
        disabled={outputLocked}
        helperText={outputHelp}
        onChange={(e) => set({ output: e.target.value as ComponentOutput })}
      >
        {outputs.map((o) => (
          <SelectItem key={o.value} value={o.value} text={o.text} />
        ))}
      </Select>
      {/* Not the Markdown editor: it would escape characters like * and break the JavaScript in {{ }}. */}
      <ComponentCodeEditor
        id={`${id}-code`}
        labelText={ai ? "Prompt" : "Code"}
        html={value.output === "html"}
        placeholder={
          ai
            ? "Album by {{ $item.Artist }}. If these albums were sorted by artist last name in a record store, give that last name."
            : place === "block"
              ? "{{ $items.length }} items"
              : "**{{ $item.Title }}**: {{ Math.round($item.Pages / 40) }} h of reading"
        }
        // What the code makes it (a field, block or static component) as it is typed.
        helperText={
          ai
            ? `${kindText(value.code, true)} ${PROMPT_HELP}`
            : `${kindText(value.code)} ${CODE_HELP}${value.output === "image" ? " The result is the image's URL." : ""}${value.output === "html" ? " It runs in a sandboxed frame: scripts work (maps, charts), the app and its data are out of reach." : ""}`
        }
        invalidText={problem}
        value={value.code}
        onChange={(code) => set({ code })}
      />
      {/* Only for HTML that fills its box (a map, a chart): content with its own height is shown at that height. */}
      {value.output === "html" && fills && (
        <Select
          size="sm"
          id={`${id}-frame-ratio`}
          labelText="Aspect ratio on pages"
          helperText="For HTML that fills its box (like a map or a chart), so has no height of its own. On card covers it fills the cover."
          value={value.frameRatio ?? "16/9"}
          onChange={(e) => set({ frameRatio: e.target.value === "16/9" ? null : e.target.value })}
        >
          {FRAME_RATIOS.map((r) => (
            <SelectItem key={r} value={r} text={r.replace("/", ":")} />
          ))}
        </Select>
      )}
    </Stack>
  );
}
