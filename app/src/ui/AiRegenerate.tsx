import { useId, useState } from "react";
import { Button, TextArea } from "@carbon/react";
import { formatDateTime } from "../domain/fieldKinds";

/**
 * The panel of an AI value's "Generate again" button: when the value was generated or edited (if
 * known), and an optional nudge for this one value, sent to
 * the model along with the prompt (once, not kept), to say which item is meant when its data alone
 * doesn't, e.g. which of several authors of the same name.
 */
export function AiRegenerate({ generatedAt, edited, onGenerate }: { generatedAt?: string; /** The value was typed by the user (generating replaces it). */ edited?: boolean; onGenerate(hint: string): void }) {
  const id = useId();
  const [hint, setHint] = useState("");
  return (
    <div className="ai-regenerate">
      {generatedAt && <p className="helper ai-regenerate__when">{edited ? "Edited by you" : "Last generated"} {formatDateTime(generatedAt)}</p>}
      <TextArea
        id={`${id}-hint`}
        labelText="Nudge (optional)"
        placeholder="e.g. the Dutch poet born in 1950, not the novelist"
        helperText="Sent to the model for this value only."
        rows={3}
        value={hint}
        onChange={(e) => setHint(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) onGenerate(hint.trim());
        }}
      />
      <Button className="ai-regenerate__go" size="sm" kind="primary" onClick={() => onGenerate(hint.trim())}>
        Generate
      </Button>
    </div>
  );
}
