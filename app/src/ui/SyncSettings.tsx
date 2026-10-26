import { useId, useState, useSyncExternalStore } from "react";
import { Button, Form, InlineNotification, PasswordInput, Stack, TextInput, Toggle } from "@carbon/react";
import { useStore } from "../app/store";
import { useConfirm } from "./useConfirm";
import { ServerReplaced } from "./ServerReplaced";

const STATE_TEXT = { off: "Off", idle: "Up to date", syncing: "Syncing…", error: "Failed" } as const;

/** Where this device syncs to: the Kubus server's address and token, switched on and off (a section of the settings). */
export function SyncSettings() {
  const { repo } = useStore();
  const uid = useId();
  const { sync } = repo;
  const status = useSyncExternalStore(sync.subscribe.bind(sync), () => sync.status);
  const [draft, setDraft] = useState(sync.config);
  const [saving, setSaving] = useState(false);
  // Whether a server is saved (the Disconnect button), as opposed to what is typed.
  const [connected, setConnected] = useState(sync.config.token !== "");
  const { confirm, dialog } = useConfirm();
  const [wipeError, setWipeError] = useState<string>();

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

  const wipe = async () => {
    const ok = await confirm({
      title: "Wipe this device's data?",
      body: connected
        ? "Deletes all data on this device. Sync is paused first, so the server keeps its data; switching sync on again downloads it."
        : "Deletes all data on this device. It can't be undone.",
      confirmLabel: "Wipe",
    });
    if (!ok) return;
    await repo.wipeLocal();
    location.reload();
  };

  const wipeServer = async () => {
    const ok = await confirm({
      title: "Wipe the server's database?",
      body: `Deletes ALL data on ${sync.config.url}: every collection, item and file of every device that syncs with it. It can't be undone. Sync on this device is paused; switching it on again uploads this device's data. Other devices keep their data but stop matching the server: disconnect and connect them again, or wipe them.`,
      confirmLabel: "Wipe server database",
    });
    if (!ok) return;
    setWipeError(undefined);
    try {
      await sync.wipeServer();
      setDraft(sync.config);
    } catch (e) {
      setWipeError(e instanceof Error ? e.message : String(e));
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
      <p className="helper">Keeps this device's data in step with your Kubus server. The data stays on this device too, so Kubus works offline.</p>
      {status.error && <InlineNotification kind="error" title="Sync failed" subtitle={status.error} hideCloseButton />}
      {status.replaced && (
        <div className="sync-popover">
          <ServerReplaced replaced={status.replaced} onConnect={() => setDraft((d) => ({ ...d, enabled: true }))} />
        </div>
      )}
      {wipeError && <InlineNotification kind="error" title="Wiping the server failed" subtitle={wipeError} onClose={() => setWipeError(undefined)} />}
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
          <div>
            <Button size="sm" kind="danger--tertiary" onClick={() => void wipe()}>
              Wipe local database
            </Button>
            {connected && (
              <>
                {" "}
                <Button size="sm" kind="danger--tertiary" onClick={() => void wipeServer()}>
                  Wipe server database
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
