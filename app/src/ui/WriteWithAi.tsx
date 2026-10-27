import { useState } from "react";
import { Button, InlineNotification, TextArea } from "@carbon/react";
import { MagicWand } from "@carbon/icons-react";
import { useStore } from "../app/store";
import { useAiSettings } from "../app/useAi";
import { componentMessages, parseComponentReply, type ComponentSuggestion } from "../domain/componentWriter";
import type { Collection } from "../domain/model";
import help from "../help/components.md?raw";
import { errorMessage } from "./useConfirm";

/**
 * "Write with AI" in the component editor: a few words on what the component should show, and the
 * language model writes its code and description (see domain/componentWriter.ts). It changes
 * the editor's fields only (nothing is saved: leaving without saving drops it), and the box empties,
 * as what is typed next asks for a change to what was just written.
 */
export function WriteWithAi({
  id,
  current,
  focus,
  ai: asksAi = false,
  onApply,
}: {
  id: string;
  /** The component as the editor has it now: given to the model to change. */
  current: ComponentSuggestion;
  /** The collection the component is for (the preview's), when chosen. */
  focus?: Collection;
  /** The component asks AI: the model writes a prompt. */
  ai?: boolean;
  /** The suggestion to put into the editor. */
  onApply(suggestion: ComponentSuggestion): void;
}) {
  const { ai, collections } = useStore();
  const { paused } = useAiSettings(); // re-renders when the settings change
  const configured = ai.isConfigured("code") && !paused;
  const model = ai.modelFor("code");
  const [request, setRequest] = useState("");
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string>();

  const write = async () => {
    setWriting(true);
    setError(undefined);
    try {
      const reply = await ai.client("code").complete(componentMessages({ help, request, current, collections, focus, ai: asksAi }));
      const suggestion = parseComponentReply(reply);
      if ("error" in suggestion) throw new Error(suggestion.error);
      onApply(suggestion);
      setRequest("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setWriting(false);
    }
  };

  return (
    <div className="write-with-ai">
      <TextArea
        id={id}
        labelText="Write with AI"
        placeholder="Describe what it should show, e.g. the reading time in hours, from the page count"
        helperText={
          paused ? (
            <>
              Requests are paused: <a href="#/settings?section=ai">Settings → AI</a>.
            </>
          ) : configured ? (
            `Asks ${model}, which sees the documentation (Help) and the fields${focus ? ` of ${focus.pluralName}` : " of your collections"}. It fills in the description and component below; with a component already there, it changes that.`
          ) : (
            <>
              No model is set up yet: <a href="#/settings?section=ai">Settings → AI</a>.
            </>
          )
        }
        rows={2}
        value={request}
        onChange={(e) => setRequest(e.target.value)}
      />
      {error && <InlineNotification kind="error" title="Could not write it" subtitle={error} lowContrast hideCloseButton />}
      <div className="form-actions">
        <Button size="sm" kind="tertiary" renderIcon={MagicWand} disabled={!configured || writing || !request.trim()} onClick={() => void write()}>
          {writing ? "Writing…" : "Write"}
        </Button>
      </div>
    </div>
  );
}
