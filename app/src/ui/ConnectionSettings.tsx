import { useEffect, useId, useState } from "react";
import { Button, Form, InlineNotification, NumberInput, PasswordInput, Select, SelectItem, Stack, TextInput } from "@carbon/react";
import { Add, TrashCan } from "@carbon/icons-react";
import type { ServerSettingsUpdate, ServerSettingsView } from "../../../shared/settings";
import { errorMessage } from "./useConfirm";
import { useServerSettings } from "./useServerSettings";

// The databases the connected server reads for remote collections (its sources), the same for every
// device: part of the server's settings (useServerSettings). Each is set up with its kind's own fields,
// as the server describes them (shared/settings.ts ConnectionKind), so the app knows no database. A password is typed once: it is never
// shown again, and stays while left empty (until the address it goes to changes).

type SourceDraft = Omit<ServerSettingsUpdate["sources"][number], "schemas"> & { passwordSet: boolean; schemasText: string };

const draftOf = (view: ServerSettingsView): SourceDraft[] =>
  view.sources.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    fields: s.fields,
    passwordSet: s.passwordSet,
    schemasText: s.schemas.join(", "),
    timeoutSeconds: s.timeoutSeconds,
  }));

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
  const { kinds } = view;

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
          user that can only read. Passwords stay on the server: once saved they are
          never shown again.
        </p>
        {draft.map((s, i) => {
          const state = status(s.id);
          const kind = kinds.find((k) => k.id === s.kind);
          const schemas = kind?.schemas;
          return (
            <Stack gap={5} key={s.id} className="server-source">
              {state?.problem && <InlineNotification kind="error" title={s.name} subtitle={state.problem} lowContrast hideCloseButton />}
              {state?.warnings?.map((w) => <InlineNotification key={w} kind="warning" title={s.name} subtitle={w} lowContrast hideCloseButton />)}
              <TextInput size="sm" id={`${uid}-src-name-${s.id}`} labelText="Name" helperText="What devices see, e.g. CRM: letters, digits, spaces, - and _. Renaming it keeps its collections." value={s.name} onChange={(e) => setSource(i, { name: e.target.value })} />
              <Select
                size="sm"
                id={`${uid}-src-kind-${s.id}`}
                labelText="Kind"
                value={s.kind}
                // Another kind: none of the last one's fields (or schemas) applies.
                onChange={(e) => setSource(i, { kind: e.target.value, fields: {}, schemasText: "" })}
              >
                {!kind && <SelectItem value={s.kind} text={s.kind ? `${s.kind} (unknown)` : "Choose a kind"} />}
                {kinds.map((k) => (
                  <SelectItem key={k.id} value={k.id} text={k.label} />
                ))}
              </Select>
              {kind?.fields.map((f) =>
                f.choices ? (
                  <Select
                    key={f.key}
                    size="sm"
                    id={`${uid}-src-${f.key}-${s.id}`}
                    labelText={f.label}
                    helperText={f.helperText}
                    value={s.fields[f.key] ?? ""}
                    onChange={(e) => setSource(i, { fields: { ...s.fields, [f.key]: e.target.value } })}
                  >
                    {f.choices.map((c) => (
                      <SelectItem key={c.value} value={c.value} text={c.text} />
                    ))}
                  </Select>
                ) : (
                  <TextInput
                    key={f.key}
                    size="sm"
                    id={`${uid}-src-${f.key}-${s.id}`}
                    labelText={f.label}
                    placeholder={f.placeholder}
                    helperText={f.helperText}
                    value={s.fields[f.key] ?? ""}
                    onChange={(e) => setSource(i, { fields: { ...s.fields, [f.key]: e.target.value } })}
                  />
                ),
              )}
              <PasswordInput
                size="sm"
                id={`${uid}-src-password-${s.id}`}
                labelText={kind?.password.label ?? "Password"}
                placeholder={s.passwordSet && s.password === undefined ? "Set: type to replace it" : "None"}
                helperText={kind?.password.helperText}
                value={s.password ?? ""}
                onChange={(e) => setSource(i, { password: e.target.value || undefined })}
              />
              {schemas && (
                <TextInput
                  size="sm"
                  id={`${uid}-src-schemas-${s.id}`}
                  labelText={schemas.label}
                  placeholder="All"
                  helperText={schemas.helperText}
                  value={s.schemasText}
                  onChange={(e) => setSource(i, { schemasText: e.target.value })}
                />
              )}
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
              setDraft((d) => d && [...d, { id: crypto.randomUUID(), name: "", kind: kinds[0]?.id ?? "", fields: {}, schemasText: "", timeoutSeconds: 30, passwordSet: false }])
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
