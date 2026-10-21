import { useId, useState, useSyncExternalStore } from "react";
import { Button, Form, InlineNotification, PasswordInput, Stack, TextInput, Toggle } from "@carbon/react";
import { useStore } from "../app/store";
import { PageHeader } from "../ui/PageHeader";
import { useConfirm } from "../ui/useConfirm";

const STATE_TEXT = { off: "Off", idle: "Up to date", syncing: "Syncing…", error: "Failed" } as const;

/** Where this device syncs to: the Kubus server's address and token, switched on and off. */
export function SyncPage() {
  const { repo } = useStore();
  const uid = useId();
  const { sync } = repo;
  const status = useSyncExternalStore(sync.subscribe.bind(sync), () => sync.status);
  const [draft, setDraft] = useState(sync.config);
  const [saving, setSaving] = useState(false);
  // Whether a server is saved (the Disconnect button), as opposed to what is typed.
  const [connected, setConnected] = useState(sync.config.token !== "");
  const { confirm, dialog } = useConfirm();

  const save = async (e?: { preventDefault(): void }) => {
    e?.preventDefault();
    if (
      draft.enabled &&
      sync.isNewServer(draft.url) &&
      !(await confirm({
        title: "Connect to this server?",
        body: "The server is the source of truth. If it already holds data, that replaces all data on this device. If it is empty, this device's data is uploaded to it.",
        confirmLabel: "Connect",
      }))
    ) {
      return;
    }
    setSaving(true);
    try {
      await sync.configure(draft);
      setConnected(draft.token !== "");
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    const ok = await confirm({
      title: "Disconnect from the server?",
      body: "This device keeps its data but stops syncing. Connecting again later replaces this device's data with the server's.",
      confirmLabel: "Disconnect",
    });
    if (!ok) return;
    await sync.disconnect();
    setDraft(sync.config);
    setConnected(false);
  };

  return (
    <>
      <PageHeader
        title="Sync"
        subtitle="Keeps this device's data in step with your Kubus server. The data stays on this device too, so Kubus works offline."
      />
      {status.error && <InlineNotification kind="error" title="Sync failed" subtitle={status.error} hideCloseButton />}
      <Form onSubmit={save} noValidate>
        <Stack gap={6}>
          <TextInput
            size="sm"
            id={`${uid}-url`}
            labelText="Server"
            placeholder="https://notes.example.com"
            value={draft.url}
            onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
          />
          <PasswordInput
            size="sm"
            id={`${uid}-token`}
            labelText="Token"
            helperText="The KUBUS_TOKEN of the server."
            value={draft.token}
            onChange={(e) => setDraft((d) => ({ ...d, token: e.target.value }))}
          />
          <Toggle
            size="sm"
            id={`${uid}-enabled`}
            labelText="Sync this device"
            labelA="Off"
            labelB="On"
            toggled={draft.enabled}
            onToggle={(enabled) => setDraft((d) => ({ ...d, enabled }))}
          />
          <p className="helper">
            {STATE_TEXT[status.state]}
            {status.lastSync && `, last synced ${new Date(status.lastSync).toLocaleString()}`}
          </p>
          <div>
            <Button size="sm" kind="primary" type="submit" disabled={saving}>
              Save
            </Button>
            {connected && (
              <>
                {" "}
                <Button size="sm" kind="danger--tertiary" onClick={() => void disconnect()}>
                  Disconnect
                </Button>
              </>
            )}
          </div>
        </Stack>
      </Form>
      {dialog}
    </>
  );
}
