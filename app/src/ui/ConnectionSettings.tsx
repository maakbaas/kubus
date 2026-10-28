import { useId, useState } from "react";
import { useSearchParams } from "react-router";
import {
  Button,
  IconButton,
  InlineNotification,
  Link,
  Modal,
  NumberInput,
  PasswordInput,
  Select,
  SelectItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TextInput,
} from "@carbon/react";
import { Add, Edit, TrashCan } from "@carbon/icons-react";
import type { ConnectionKind, ServerSettingsUpdate, ServerSettingsView } from "../../../shared/settings";
import { FillTable } from "../views/TableView";
import { LIST_MAIN, LIST_TABLE } from "./listTable";
import { RowActions, ROW_BUTTON } from "./RowActions";
import { errorMessage, useConfirm } from "./useConfirm";
import { useMountedDialog } from "./useMountedDialog";
import { useServerSettings } from "./useServerSettings";
import { useTableSort } from "./useTableSort";

// The databases the connected server reads for remote collections (its sources), the same for every
// device: part of the server's settings (useServerSettings). Listed as a table, like the list pages: a
// connection's name (or its edit icon) opens its settings in a dialog (`?source=<id>`, `new` for one
// being added), whose Save stores them on the server at once; delete asks first, then saves. Each is
// set up with its kind's own fields, as the server describes them (shared/settings.ts ConnectionKind),
// so the app knows no database. A password is typed once: it is never shown again, and stays while left
// empty (until the address it goes to changes). A secret field (a calendar's address) is the same,
// shown only as set.

type SourceDraft = Omit<ServerSettingsUpdate["sources"][number], "schemas" | "secrets"> & {
  passwordSet: boolean;
  schemasText: string;
  /** The secret fields set on the server. */
  secretsSet: string[];
  /** The secret fields typed here (sent; the rest are kept). */
  secrets: Record<string, string>;
};

const draftOf = (view: ServerSettingsView): SourceDraft[] =>
  view.sources.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    fields: s.fields,
    passwordSet: s.passwordSet,
    secretsSet: s.secretsSet ?? [],
    secrets: {},
    schemasText: s.schemas.join(", "),
    timeoutSeconds: s.timeoutSeconds,
  }));

const updateOf = (draft: SourceDraft[]): ServerSettingsUpdate["sources"] =>
  draft.map(({ passwordSet: _p, secretsSet: _set, schemasText, password, secrets, ...s }) => ({
    ...s,
    schemas: schemasText.split(",").map((x) => x.trim()).filter(Boolean),
    ...(password !== undefined && { password }),
    ...(Object.keys(secrets).length > 0 && { secrets }),
  }));

/** A connection being added. */
const blankSource = (kinds: ConnectionKind[]): SourceDraft => ({
  id: crypto.randomUUID(),
  name: "",
  kind: kinds[0]?.id ?? "",
  fields: {},
  secrets: {},
  secretsSet: [],
  schemasText: "",
  timeoutSeconds: 30,
  passwordSet: false,
});

export function ConnectionSettings() {
  const server = useServerSettings();
  const { view } = server;
  const [error, setError] = useState<string>();
  const { confirm, dialog } = useConfirm();
  const [params, setParams] = useSearchParams();
  // The connection whose settings are open (a dialog): its id, "new" for one being added.
  const editing = params.get("source");
  const openSource = (id: string) =>
    setParams((p) => {
      p.set("section", "connections");
      p.set("source", id);
      return p;
    });
  const closeSource = () =>
    setParams(
      (p) => {
        p.delete("source");
        return p;
      },
      { replace: true },
    );
  const { sort, header } = useTableSort<SourceDraft, "name" | "kind">({
    name: (s) => s.name,
    kind: (s) => view?.kinds.find((k) => k.id === s.kind)?.label ?? s.kind,
  });

  if (!server.connected) {
    return <InlineNotification kind="info" title="No server" subtitle="Connect this device to a Kubus server first (Settings → Server): these are that server's connections." lowContrast hideCloseButton />;
  }
  if (!view) return server.error ? <InlineNotification kind="error" title="Can't read the server's settings" subtitle={server.error} lowContrast hideCloseButton /> : null;

  const list = draftOf(view);
  const { kinds } = view;
  const kindLabel = (id: string) => kinds.find((k) => k.id === id)?.label ?? (id ? `${id} (unknown)` : "");
  const status = (id: string) => view.sources.find((s) => s.id === id);
  const label = (s: SourceDraft) => s.name || "Unnamed";

  /** Stores the connections as given (on top of the rest of the server's settings as they are now). */
  const saveSources = (next: SourceDraft[]) => server.save((current) => ({ ...current, sources: updateOf(next) }));

  async function remove(s: SourceDraft) {
    const ok = await confirm({
      title: `Delete “${label(s)}”?`,
      body: "Its remote collections can't read their rows until a connection of the same name is added again.",
    });
    if (!ok) return;
    setError(undefined);
    try {
      await saveSources(list.filter((x) => x.id !== s.id));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const edited = editing === "new" ? null : list.find((s) => s.id === editing);

  return (
    <Stack gap={6}>
      <p className="helper">
        Databases the server at {server.url} reads for remote collections (Remotes), read-only, the same for every device that syncs with it.
        Give it a user that can only read. Passwords stay on the server: once saved they are never shown again.
      </p>
      {error && <InlineNotification kind="error" title="Not saved" subtitle={error} lowContrast hideCloseButton />}
      {list.flatMap((s) => {
        const state = status(s.id);
        return [
          ...(state?.problem ? [<InlineNotification key={`${s.id}-problem`} kind="error" title={label(s)} subtitle={state.problem} lowContrast hideCloseButton />] : []),
          ...(state?.warnings ?? []).map((w) => <InlineNotification key={`${s.id}-${w}`} kind="warning" title={label(s)} subtitle={w} lowContrast hideCloseButton />),
        ];
      })}
      {list.length > 0 ? (
        <FillTable>
          <Table size="sm" className={LIST_TABLE}>
            <TableHead>
              <TableRow>
                <TableHeader className={LIST_MAIN} {...header("name")}>Name</TableHeader>
                <TableHeader {...header("kind")}>Kind</TableHeader>
                <TableHeader aria-label="Actions" />
              </TableRow>
            </TableHead>
            <TableBody>
              {sort(list).map((s) => (
                <TableRow key={s.id}>
                  <TableCell className={LIST_MAIN}>
                    <Link href={`#/settings?section=connections&source=${encodeURIComponent(s.id)}`}>{label(s)}</Link>
                  </TableCell>
                  <TableCell>{kindLabel(s.kind)}</TableCell>
                  <RowActions>
                    <IconButton {...ROW_BUTTON} label={`Edit ${label(s)}`} onClick={() => openSource(s.id)}>
                      <Edit />
                    </IconButton>
                    <IconButton {...ROW_BUTTON} label={`Delete ${label(s)}`} onClick={() => void remove(s)}>
                      <TrashCan />
                    </IconButton>
                  </RowActions>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </FillTable>
      ) : (
        <p className="helper">No remote connections yet.</p>
      )}
      <div className="button-row">
        <Button kind="tertiary" size="sm" renderIcon={Add} onClick={() => openSource("new")}>
          Add connection
        </Button>
      </div>
      {editing && (editing === "new" || edited) && (
        <ConnectionModal
          key={editing}
          source={edited ?? blankSource(kinds)}
          isNew={!edited}
          kinds={kinds}
          onClose={closeSource}
          onSave={async (s) => {
            await saveSources(edited ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s]);
            closeSource();
          }}
        />
      )}
      {dialog}
    </Stack>
  );
}

/** One remote connection's settings, in a dialog; Save stores them on the server. */
function ConnectionModal({
  source,
  isNew,
  kinds,
  onClose,
  onSave,
}: {
  source: SourceDraft;
  isNew: boolean;
  kinds: ConnectionKind[];
  onClose(): void;
  /** Throws when the server refuses the settings (the dialog then stays, showing why). */
  onSave(source: SourceDraft): Promise<void>;
}) {
  const uid = useId();
  const open = useMountedDialog();
  const [s, setS] = useState(source);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const set = (patch: Partial<SourceDraft>) => setS((x) => ({ ...x, ...patch }));
  const kind = kinds.find((k) => k.id === s.kind);
  const schemas = kind?.schemas;

  async function save() {
    setSaving(true);
    setError(undefined);
    try {
      await onSave(s);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      size="xs"
      modalHeading={isNew ? "Add connection" : `Edit ${source.name || "connection"}`}
      primaryButtonText={isNew ? "Add" : "Save"}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={saving}
      onRequestClose={onClose}
      onRequestSubmit={save}
    >
      <Stack gap={5}>
        {error && <InlineNotification kind="error" title="Not saved" subtitle={error} lowContrast hideCloseButton />}
        <TextInput
          size="sm"
          id={`${uid}-name`}
          data-modal-primary-focus
          labelText="Name"
          helperText="What devices see, e.g. CRM: letters, digits, spaces, - and _. Renaming it keeps its collections."
          value={s.name}
          onChange={(e) => set({ name: e.target.value })}
        />
        <Select
          size="sm"
          id={`${uid}-kind`}
          labelText="Kind"
          value={s.kind}
          // Another kind: none of the last one's fields (or schemas) applies.
          onChange={(e) => set({ kind: e.target.value, fields: {}, secrets: {}, schemasText: "" })}
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
              id={`${uid}-${f.key}`}
              labelText={f.label}
              helperText={f.helperText}
              value={s.fields[f.key] ?? ""}
              onChange={(e) => set({ fields: { ...s.fields, [f.key]: e.target.value } })}
            >
              {f.choices.map((c) => (
                <SelectItem key={c.value} value={c.value} text={c.text} />
              ))}
            </Select>
          ) : f.secret ? (
            <PasswordInput
              key={f.key}
              size="sm"
              id={`${uid}-${f.key}`}
              labelText={f.label}
              placeholder={s.secretsSet.includes(f.key) && s.secrets[f.key] === undefined ? "Set: type to replace it" : (f.placeholder ?? "None")}
              helperText={f.helperText}
              value={s.secrets[f.key] ?? ""}
              onChange={(e) => {
                const { [f.key]: _old, ...rest } = s.secrets;
                set({ secrets: e.target.value ? { ...rest, [f.key]: e.target.value } : rest });
              }}
            />
          ) : (
            <TextInput
              key={f.key}
              size="sm"
              id={`${uid}-${f.key}`}
              labelText={f.label}
              placeholder={f.placeholder}
              helperText={f.helperText}
              value={s.fields[f.key] ?? ""}
              onChange={(e) => set({ fields: { ...s.fields, [f.key]: e.target.value } })}
            />
          ),
        )}
        <PasswordInput
          size="sm"
          id={`${uid}-password`}
          labelText={kind?.password.label ?? "Password"}
          placeholder={s.passwordSet && s.password === undefined ? "Set: type to replace it" : "None"}
          helperText={kind?.password.helperText}
          value={s.password ?? ""}
          onChange={(e) => set({ password: e.target.value || undefined })}
        />
        {schemas && (
          <TextInput
            size="sm"
            id={`${uid}-schemas`}
            labelText={schemas.label}
            placeholder="All"
            helperText={schemas.helperText}
            value={s.schemasText}
            onChange={(e) => set({ schemasText: e.target.value })}
          />
        )}
        <NumberInput
          size="sm"
          id={`${uid}-timeout`}
          label="Time limit (seconds)"
          helperText="Longest one query may run."
          min={1}
          max={3600}
          value={s.timeoutSeconds}
          onChange={(_, { value }) => set({ timeoutSeconds: Number(value) || 30 })}
        />
      </Stack>
    </Modal>
  );
}
