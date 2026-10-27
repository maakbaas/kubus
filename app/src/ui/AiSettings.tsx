import { useEffect, useId, useState } from "react";
import { Button, ComboBox, Form, InlineNotification, PasswordInput, Select, SelectItem, Stack, TextInput, Toggle } from "@carbon/react";
import { useStore } from "../app/store";
import { useAiSettings, useServerAi } from "../app/useAi";
import { createLlmClient } from "../platform/llm";
import { errorMessage } from "./useConfirm";

/**
 * The language model behind AI fields and "Write with AI": the sync server's (set up in Settings →
 * Server and used through it, so every device has the same), or this
 * device's own: any OpenAI-style API, its key and a model, kept on this device only (the key is
 * never synced). A section of the settings.
 */
export function AiSettings() {
  const { ai } = useStore();
  const uid = useId();
  const saved = useAiSettings();
  const offer = useServerAi();
  const [draft, setDraft] = useState(saved);
  const [models, setModels] = useState<string[]>([]);
  const [results, setResults] = useState<{ ok: boolean; text: string }[]>([]);
  const [testing, setTesting] = useState(false);
  const own = draft.source === "own";

  // The provider's models, for the picker (a typed name works too). Without a list (no key yet, or
  // a provider that doesn't say) it is a plain text box.
  useEffect(() => {
    if (!own) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      createLlmClient({ baseUrl: draft.baseUrl, apiKey: draft.apiKey, model: "" })
        .models({ signal: controller.signal })
        .then(setModels, () => setModels([]));
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [own, draft.baseUrl, draft.apiKey]);

  const save = (e?: { preventDefault(): void }) => {
    e?.preventDefault();
    ai.setSettings({
      source: draft.source,
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey.trim(),
      fieldModel: draft.fieldModel.trim(),
      codeModel: draft.codeModel.trim(),
      paused: saved.paused,
    });
    setResults([]);
  };

  // Each model that is set (the code model may be the field model), as the draft would ask it.
  const provider = ai.providerOf(draft);
  const testModels = [...new Set([provider.fieldModel.trim(), provider.codeModel.trim()].filter(Boolean))];
  const test = async () => {
    setTesting(true);
    setResults([]);
    for (const model of testModels) {
      try {
        const reply = await createLlmClient({ baseUrl: provider.baseUrl, apiKey: provider.apiKey, model }).complete([{ role: "user", content: "Reply with the single word: ok" }]);
        setResults((r) => [...r, { ok: true, text: `${model} replied: ${reply.trim().slice(0, 80)}` }]);
      } catch (err) {
        setResults((r) => [...r, { ok: false, text: `${model}: ${errorMessage(err)}` }]);
      }
    }
    setTesting(false);
  };

  const dirty =
    draft.source !== saved.source ||
    draft.baseUrl !== saved.baseUrl ||
    draft.apiKey !== saved.apiKey ||
    draft.fieldModel !== saved.fieldModel ||
    draft.codeModel !== saved.codeModel;

  return (
    <>
      <p className="helper">The language models that write the values of AI fields and the code of components.</p>
      {/* Takes effect at once (not with Save): the way to stop requests, e.g. on a metered connection. */}
      <Toggle
        size="sm"
        id={`${uid}-paused`}
        labelText="Requests"
        labelA="Paused"
        labelB="Running"
        toggled={!saved.paused}
        onToggle={(running) => ai.setSettings({ ...saved, paused: !running })}
      />
      <p className="helper">While paused, no request is sent to the model (not for AI fields, not for writing components); what waits stays queued.</p>
      <Form onSubmit={save} noValidate>
        <Stack gap={6}>
          <Select
            size="sm"
            id={`${uid}-source`}
            labelText="Language model"
            helperText={
              own
                ? "Any OpenAI-style API, hosted or local. These settings, the key too, stay on this device and are never synced."
                : "Set up on the sync server, the same for every device; its key stays on the server."
            }
            value={draft.source}
            onChange={(e) => setDraft((d) => ({ ...d, source: e.target.value === "own" ? "own" : "server" }))}
          >
            <SelectItem value="server" text="The server's" />
            <SelectItem value="own" text="My own, on this device" />
          </Select>
          {own ? (
            <>
              <TextInput
                size="sm"
                id={`${uid}-url`}
                labelText="Address"
                placeholder="https://api.openai.com/v1"
                helperText="The API's root. Kubus adds /chat/completions."
                value={draft.baseUrl}
                onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
              />
              <PasswordInput
                size="sm"
                id={`${uid}-key`}
                labelText="API key"
                helperText="From your provider. A local server needs none."
                value={draft.apiKey}
                onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
              />
              <ComboBox
                autoAlign
                size="sm"
                id={`${uid}-fieldModel`}
                titleText="Model for AI fields"
                placeholder="e.g. deepseek/deepseek-chat"
                helperText={models.length ? `${models.length} models offered. Type to search, or enter any name. Runs for every value, so a fast, cheap one fits.` : "The provider's name for the model. Runs for every value, so a fast, cheap one fits."}
                items={models}
                allowCustomValue
                selectedItem={draft.fieldModel || null}
                onChange={({ selectedItem }) => selectedItem && setDraft((d) => ({ ...d, fieldModel: selectedItem }))}
                onInputChange={(fieldModel) => setDraft((d) => ({ ...d, fieldModel }))}
              />
              <ComboBox
                autoAlign
                size="sm"
                id={`${uid}-codeModel`}
                titleText="Model for writing components"
                placeholder="Same as for AI fields"
                helperText={"Writes the code of a component (Write with AI). Leave empty to use the model for AI fields; a stronger one fits here, as it runs once in a while."}
                items={models}
                allowCustomValue
                selectedItem={draft.codeModel || null}
                onChange={({ selectedItem }) => selectedItem && setDraft((d) => ({ ...d, codeModel: selectedItem }))}
                onInputChange={(codeModel) => setDraft((d) => ({ ...d, codeModel }))}
              />
            </>
          ) : offer.ai?.available ? (
            <p className="helper">
              AI fields: {offer.ai.fieldModel}. Writing components: {offer.ai.codeModel || offer.ai.fieldModel}.
            </p>
          ) : (
            offer.problem && <InlineNotification kind="warning" title="No model from the server" subtitle={offer.problem} lowContrast hideCloseButton />
          )}
          {results.map((r, i) => (
            <InlineNotification key={i} kind={r.ok ? "success" : "error"} title={r.ok ? "Works" : "Failed"} subtitle={r.text} lowContrast hideCloseButton />
          ))}
          <div>
            <Button size="sm" kind="primary" type="submit" disabled={!dirty}>
              Save
            </Button>{" "}
            <Button size="sm" kind="tertiary" disabled={testing || testModels.length === 0} onClick={() => void test()}>
              Test
            </Button>
          </div>
        </Stack>
      </Form>
    </>
  );
}
