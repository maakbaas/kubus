import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { Button, Checkbox, Form, FormGroup, InlineNotification, NumberInput, PasswordInput, Stack, TextInput } from "@carbon/react";
import { Add, TrashCan } from "@carbon/icons-react";
import type { ServerSettingsUpdate, ServerSettingsView } from "../../../shared/settings";
import { useStore } from "../app/store";
import { errorMessage } from "./useConfirm";

// Settings of the Kubus server this device syncs with, the same for every device: the language
// model it offers them and the databases it reads for them (remote collections). Stored on the
// server only (shared/settings.ts), changed with the sync token. A key or password is typed once:
// it is never shown again, and stays while left empty (until the address it goes to changes).

type SourceDraft = ServerSettingsUpdate["sources"][number] & { passwordSet: boolean; schemasText: string };
interface Draft {
  ai: ServerSettingsUpdate["ai"] & { keySet: boolean };
  sources: SourceDraft[];
}

const draftOf = (view: ServerSettingsView): Draft => ({
  ai: { url: view.ai.url, fieldModel: view.ai.fieldModel, codeModel: view.ai.codeModel, keySet: view.ai.keySet },
  sources: view.sources.map((s) => ({ ...s, schemasText: s.schemas.join(", ") })),
});

const updateOf = (draft: Draft): ServerSettingsUpdate => ({
  ai: { url: draft.ai.url, fieldModel: draft.ai.fieldModel, codeModel: draft.ai.codeModel, ...(draft.ai.key !== undefined && { key: draft.ai.key }) },
  sources: draft.sources.map(({ passwordSet: _p, schemasText, password, ...s }) => ({
    ...s,
    schemas: schemasText.split(",").map((x) => x.trim()).filter(Boolean),
    ...(password !== undefined && { password }),
  })),
});

export function ServerSettings() {
  const uid = useId();
  const { sources, ai, repo } = useStore();
  // Follows the sync settings (another server, another token).
  useSyncExternalStore(repo.sync.subscribe.bind(repo.sync), () => repo.sync.status);
  const config = repo.sync.config;
  const connected = !!config.url && !!config.token;
  const [view, setView] = useState<ServerSettingsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!connected) return;
    sources.serverSettings().then(
      (v) => {
        setView(v);
        setDraft(draftOf(v));
      },
      (e) => setError(errorMessage(e)),
    );
  }, [sources, connected, config.url, config.token]);

  if (!connected) {
    return <InlineNotification kind="info" title="No server" subtitle="Connect this device to a Kubus server first (Sync): these are that server's settings." lowContrast hideCloseButton />;
  }
  if (!draft || !view) return error ? <InlineNotification kind="error" title="Can't read the server's settings" subtitle={error} lowContrast hideCloseButton /> : null;

  const setAi = (patch: Partial<Draft["ai"]>) => setDraft((d) => d && { ...d, ai: { ...d.ai, ...patch } });
  const setSource = (i: number, patch: Partial<SourceDraft>) => setDraft((d) => d && { ...d, sources: d.sources.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const status = (id: string) => view.sources.find((s) => s.id === id);

  async function save(e: { preventDefault(): void }) {
    e.preventDefault();
    if (!draft) return;
    setSaving(true);
    setError(undefined);
    setSaved(false);
    try {
      const next = await sources.saveServerSettings(updateOf(draft));
      setView(next);
      setDraft(draftOf(next));
      setSaved(true);
      // What the server offers changed: the model, and the sources remote collections read.
      ai.serverChanged();
      sources.refresh(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Form onSubmit={save}>
      <Stack gap={7}>
        <p className="helper">
          Settings of the server at {config.url}, the same for every device that syncs with it. Keys and passwords stay on the server: once
          saved they are never shown again.
        </p>
        <FormGroup legendText="Language model">
          <Stack gap={5}>
            <TextInput
              size="sm"
              id={`${uid}-ai-url`}
              labelText="Address"
              placeholder="https://api.openai.com/v1"
              helperText="Any OpenAI-style API, offered to every device (Settings → AI → The server's). Empty: none."
              value={draft.ai.url}
              onChange={(e) => setAi({ url: e.target.value })}
            />
            <PasswordInput
              size="sm"
              id={`${uid}-ai-key`}
              labelText="API key"
              placeholder={draft.ai.keySet && draft.ai.key === undefined ? "Set: type to replace it" : "None"}
              helperText="Kept while left empty (unless the address changes). A local server needs none."
              value={draft.ai.key ?? ""}
              onChange={(e) => setAi({ key: e.target.value || undefined })}
            />
            {draft.ai.keySet && draft.ai.key === undefined && (
              <div>
                <Button kind="tertiary" size="sm" onClick={() => setAi({ key: "", keySet: false })}>
                  Remove key
                </Button>
              </div>
            )}
            <TextInput size="sm" id={`${uid}-ai-field`} labelText="Model for AI fields" placeholder="e.g. gpt-4.1-mini" value={draft.ai.fieldModel} onChange={(e) => setAi({ fieldModel: e.target.value })} />
            <TextInput
              size="sm"
              id={`${uid}-ai-code`}
              labelText="Model for writing components"
              placeholder="Same as for AI fields"
              value={draft.ai.codeModel}
              onChange={(e) => setAi({ codeModel: e.target.value })}
            />
          </Stack>
        </FormGroup>

        <FormGroup legendText="Sources">
          <Stack gap={7}>
            <p className="helper">
              Databases the server reads for remote collections, read-only. Give it a user that can only read: queries written in the app can read
              whatever that user can.
            </p>
            {draft.sources.map((s, i) => {
              const state = status(s.id);
              return (
                <Stack gap={5} key={s.id} className="server-source">
                  {state?.problem && <InlineNotification kind="error" title={s.name} subtitle={state.problem} lowContrast hideCloseButton />}
                  {state?.warnings?.map((w) => <InlineNotification key={w} kind="warning" title={s.name} subtitle={w} lowContrast hideCloseButton />)}
                  <TextInput size="sm" id={`${uid}-src-name-${s.id}`} labelText="Name" helperText="What devices see, e.g. CRM: letters, digits, - and _." value={s.name} onChange={(e) => setSource(i, { name: e.target.value })} />
                  <TextInput
                    size="sm"
                    id={`${uid}-src-url-${s.id}`}
                    labelText="Connection string"
                    placeholder="postgres://reader@db-host:5432/crm"
                    helperText={state?.connector ? `Read by its ${state.connector} connector.` : "postgres://user@host:port/database, n8n://host for n8n's data tables (its API key as the password), or influxdb://host:8086/org (influxdbs:// for HTTPS; the token as password)."}
                    value={s.url}
                    onChange={(e) => setSource(i, { url: e.target.value })}
                  />
                  <PasswordInput
                    size="sm"
                    id={`${uid}-src-password-${s.id}`}
                    labelText="Password"
                    placeholder={s.passwordSet && s.password === undefined ? "Set: type to replace it" : "None"}
                    helperText="InfluxDB: a token that can only read. Kept while left empty (unless the host, port or user changes)."
                    value={s.password ?? ""}
                    onChange={(e) => setSource(i, { password: e.target.value || undefined })}
                  />
                  <TextInput
                    size="sm"
                    id={`${uid}-src-schemas-${s.id}`}
                    labelText="Schemas"
                    placeholder="All"
                    helperText="Only these schemas' tables are offered (n8n: these projects' ids; InfluxDB: buckets' measurements), comma-separated."
                    value={s.schemasText}
                    onChange={(e) => setSource(i, { schemasText: e.target.value })}
                  />
                  <NumberInput
                    size="sm"
                    id={`${uid}-src-timeout-${s.id}`}
                    label="Time limit (seconds)"
                    helperText="Longest one query may run."
                    min={1}
                    max={3600}
                    value={s.timeoutSeconds}
                    onChange={(_, { value }) => setSource(i, { timeoutSeconds: Number(value) || 30 })}
                  />
                  <Checkbox id={`${uid}-src-queries-${s.id}`} labelText="Queries written in the app (else only its tables)" checked={s.queries} onChange={(_, { checked }) => setSource(i, { queries: checked })} />
                  <div>
                    <Button kind="danger--tertiary" size="sm" renderIcon={TrashCan} onClick={() => setDraft((d) => d && { ...d, sources: d.sources.filter((_, j) => j !== i) })}>
                      Remove source
                    </Button>
                  </div>
                </Stack>
              );
            })}
            <div>
              <Button
                kind="tertiary"
                size="sm"
                renderIcon={Add}
                onClick={() =>
                  setDraft((d) => d && { ...d, sources: [...d.sources, { id: crypto.randomUUID(), name: "", url: "", schemas: [], schemasText: "", queries: true, timeoutSeconds: 30, passwordSet: false }] })
                }
              >
                Add source
              </Button>
            </div>
          </Stack>
        </FormGroup>

        {error && <InlineNotification kind="error" title="Not saved" subtitle={error} lowContrast hideCloseButton />}
        {saved && <InlineNotification kind="success" title="Saved" subtitle="The server uses these settings now." lowContrast hideCloseButton />}
        <div>
          <Button size="sm" kind="primary" type="submit" disabled={saving}>
            Save
          </Button>
        </div>
      </Stack>
    </Form>
  );
}
