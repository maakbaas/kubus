import { useEffect, useId, useState } from "react";
import { Button, Checkbox, Form, InlineNotification, NumberInput, PasswordInput, Stack, TextInput } from "@carbon/react";
import { Add, TrashCan } from "@carbon/icons-react";
import type { ServerSettingsUpdate, ServerSettingsView } from "../../../shared/settings";
import { errorMessage } from "./useConfirm";
import { useServerSettings } from "./useServerSettings";

// The databases the connected server reads for remote collections (its sources), the same for every
// device: part of the server's settings (useServerSettings). A password is typed once: it is never
// shown again, and stays while left empty (until the address it goes to changes).

type SourceDraft = ServerSettingsUpdate["sources"][number] & { passwordSet: boolean; schemasText: string };

const draftOf = (view: ServerSettingsView): SourceDraft[] => view.sources.map((s) => ({ ...s, schemasText: s.schemas.join(", ") }));

const updateOf = (draft: SourceDraft[]): ServerSettingsUpdate["sources"] =>
  draft.map(({ passwordSet: _p, schemasText, password, ...s }) => ({
    ...s,
    schemas: schemasText.split(",").map((x) => x.trim()).filter(Boolean),
    ...(password !== undefined && { password }),
  }));

export function ConnectionSettings() {
  const uid = useId();
  const server = useServerSettings();
  const { view } = server;
  const [draft, setDraft] = useState<SourceDraft[] | null>(null);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => setDraft(view && draftOf(view)), [view]);

  if (!server.connected) {
    return <InlineNotification kind="info" title="No server" subtitle="Connect this device to a Kubus server first (Settings → Server): these are that server's connections." lowContrast hideCloseButton />;
  }
  if (!draft || !view) return server.error ? <InlineNotification kind="error" title="Can't read the server's settings" subtitle={server.error} lowContrast hideCloseButton /> : null;

  const setSource = (i: number, patch: Partial<SourceDraft>) => setDraft((d) => d && d.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const status = (id: string) => view.sources.find((s) => s.id === id);

  async function save(e: { preventDefault(): void }) {
    e.preventDefault();
    if (!draft) return;
    setSaving(true);
    setError(undefined);
    setSaved(false);
    try {
      await server.save((current) => ({ ...current, sources: updateOf(draft) }));
      setSaved(true);
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
          Databases the server at {server.url} reads for remote collections, read-only, the same for every device that syncs with it. Give it a
          user that can only read: queries written in the app can read whatever that user can. Passwords stay on the server: once saved they are
          never shown again.
        </p>
        {draft.map((s, i) => {
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
                helperText={state?.connector ? `Read by its ${state.connector} connector.` : "postgres://user@host:port/database, n8n://host for n8n's data tables (its API key as the password), influxdb://host:8086/org (influxdbs:// for HTTPS; the token as password), or d1://account-id/database-id for Cloudflare D1 (an API token with D1 Read as the password)."}
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
                <Button kind="danger--tertiary" size="sm" renderIcon={TrashCan} onClick={() => setDraft((d) => d && d.filter((_, j) => j !== i))}>
                  Remove connection
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
              setDraft((d) => d && [...d, { id: crypto.randomUUID(), name: "", url: "", schemas: [], schemasText: "", queries: true, timeoutSeconds: 30, passwordSet: false }])
            }
          >
            Add connection
          </Button>
        </div>
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
