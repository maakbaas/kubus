import { useEffect, useId, useState } from "react";
import { Button, ComboBox, Form, InlineNotification, PasswordInput, Select, SelectItem, Stack, TextInput, Toggle } from "@carbon/react";
import type { ServerSettingsUpdate, ServerSettingsView } from "../../../shared/settings";
import { useStore } from "../app/store";
import { useAiSettings, useServerAi } from "../app/useAi";
import { createLlmClient } from "../platform/llm";
import { errorMessage } from "./useConfirm";
import { useServerSettings } from "./useServerSettings";

type ServerAiDraft = ServerSettingsUpdate["ai"] & { keySet: boolean };
const serverDraftOf = (view: ServerSettingsView): ServerAiDraft => ({ url: view.ai.url, fieldModel: view.ai.fieldModel, codeModel: view.ai.codeModel, keySet: view.ai.keySet });

/**
 * The language model behind AI fields and "Write with AI": the server's (set up here too, part of the
 * server's settings, and used through it, so every device has the same; its key stays on the server),
 * or this device's own: any OpenAI-style API, its key and a model, kept on this device only (the key is
 * never synced). The "Language model" dropdown picks which one is used and which one the boxes below it
 * set up. A section of the settings.
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
  const server = useServerSettings();
  const [serverDraft, setServerDraft] = useState<ServerAiDraft | null>(null);
  const [serverError, setServerError] = useState<string>();
  const [serverSaved, setServerSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => setServerDraft(server.view && serverDraftOf(server.view)), [server.view]);
  const setServerAi = (patch: Partial<ServerAiDraft>) => setServerDraft((d) => d && { ...d, ...patch });
  const serverDirty =
    !!serverDraft &&
    !!server.view &&
    (serverDraft.url !== server.view.ai.url ||
      serverDraft.fieldModel !== server.view.ai.fieldModel ||
      serverDraft.codeModel !== server.view.ai.codeModel ||
      serverDraft.key !== undefined ||
      serverDraft.keySet !== server.view.ai.keySet);

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

  const save = async (e?: { preventDefault(): void }) => {
    e?.preventDefault();
    setServerError(undefined);
    setServerSaved(false);
    if (!own && serverDirty && serverDraft) {
      setSaving(true);
      try {
        const { keySet: _k, key, ...rest } = serverDraft;
        const serverAi = { url: rest.url.trim(), fieldModel: rest.fieldModel.trim(), codeModel: rest.codeModel.trim(), ...(key !== undefined && { key }) };
        await server.save((current) => ({ ...current, ai: serverAi }));
        setServerSaved(true);
      } catch (err) {
        setServerError(errorMessage(err));
        return;
      } finally {
        setSaving(false);
      }
    }
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

  const ownDirty =
    draft.source !== saved.source ||
    draft.baseUrl !== saved.baseUrl ||
    draft.apiKey !== saved.apiKey ||
    draft.fieldModel !== saved.fieldModel ||
    draft.codeModel !== saved.codeModel;
  const dirty = ownDirty || (!own && serverDirty);

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
      <Form onSubmit={(e) => void save(e)} noValidate>
        <Stack gap={6}>
          <Select
            size="sm"
            id={`${uid}-source`}
            labelText="Language model"
            helperText={
              own
                ? "Any OpenAI-style API, hosted or local. These settings, the key too, stay on this device and are never synced."
                : `Set up on the server${server.connected ? ` at ${server.url}` : ""}, the same for every device that syncs with it; its key stays on the server.`
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
          ) : !server.connected ? (
            <InlineNotification kind="info" title="No server" subtitle="Connect this device to a Kubus server first (Settings → Server), or use your own model." lowContrast hideCloseButton />
          ) : !serverDraft ? (
            server.error && <InlineNotification kind="error" title="Can't read the server's settings" subtitle={server.error} lowContrast hideCloseButton />
          ) : (
            <>
              <TextInput
                size="sm"
                id={`${uid}-server-url`}
                labelText="Address"
                placeholder="https://api.openai.com/v1"
                helperText="Any OpenAI-style API, offered to every device. Empty: none."
                value={serverDraft.url}
                onChange={(e) => setServerAi({ url: e.target.value })}
              />
              <PasswordInput
                size="sm"
                id={`${uid}-server-key`}
                labelText="API key"
                placeholder={serverDraft.keySet && serverDraft.key === undefined ? "Set: type to replace it" : "None"}
                helperText="Stays on the server: once saved it is never shown again. Kept while left empty (unless the address changes). A local server needs none."
                value={serverDraft.key ?? ""}
                onChange={(e) => setServerAi({ key: e.target.value || undefined })}
              />
              {serverDraft.keySet && serverDraft.key === undefined && (
                <div>
                  <Button kind="tertiary" size="sm" onClick={() => setServerAi({ key: "", keySet: false })}>
                    Remove key
                  </Button>
                </div>
              )}
              <TextInput
                size="sm"
                id={`${uid}-server-field`}
                labelText="Model for AI fields"
                placeholder="e.g. gpt-4.1-mini"
                helperText="The provider's name for the model. Runs for every value, so a fast, cheap one fits."
                value={serverDraft.fieldModel}
                onChange={(e) => setServerAi({ fieldModel: e.target.value })}
              />
              <TextInput
                size="sm"
                id={`${uid}-server-code`}
                labelText="Model for writing components"
                placeholder="Same as for AI fields"
                helperText="Writes the code of a component (Write with AI). Leave empty to use the model for AI fields."
                value={serverDraft.codeModel}
                onChange={(e) => setServerAi({ codeModel: e.target.value })}
              />
              {!serverDirty && offer.problem && <InlineNotification kind="warning" title="No model from the server" subtitle={offer.problem} lowContrast hideCloseButton />}
            </>
          )}
          {serverError && <InlineNotification kind="error" title="Not saved" subtitle={serverError} lowContrast hideCloseButton />}
          {serverSaved && !own && <InlineNotification kind="success" title="Saved" subtitle="The server offers this model to every device now." lowContrast hideCloseButton />}
          {results.map((r, i) => (
            <InlineNotification key={i} kind={r.ok ? "success" : "error"} title={r.ok ? "Works" : "Failed"} subtitle={r.text} lowContrast hideCloseButton />
          ))}
          <div>
            <Button size="sm" kind="primary" type="submit" disabled={!dirty || saving}>
              Save
            </Button>{" "}
            <Button size="sm" kind="tertiary" disabled={testing || testModels.length === 0 || (!own && serverDirty)} onClick={() => void test()}>
              Test
            </Button>
          </div>
        </Stack>
      </Form>
    </>
  );
}
