import { useId, useState, useSyncExternalStore } from "react";
import { Button, Form, InlineNotification, PasswordInput, Stack, TextInput } from "@carbon/react";
import { useStore } from "../app/store";
import { ApiTokens } from "./ApiTokens";
import { errorMessage, useConfirm } from "./useConfirm";

/**
 * The Kubus server this device is connected to: its address and token (a section of the settings).
 * Sync, the server's language model and remote collections all go through it; whether data syncs is
 * Settings → Sync. Once connected, also the server's API tokens (ApiTokens).
 */
export function ServerConnection() {
  const { repo } = useStore();
  const uid = useId();
  const { sync } = repo;
  useSyncExternalStore(sync.subscribe.bind(sync), () => sync.status);
  const [draft, setDraft] = useState({ url: sync.config.url, token: sync.config.token });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const { confirm, dialog } = useConfirm();
  const connected = sync.config.token !== "";
  const dirty = draft.url.trim().replace(/\/+$/, "") !== sync.config.url || draft.token !== sync.config.token;

  const save = async (e?: { preventDefault(): void }) => {
    e?.preventDefault();
    if (
      sync.config.enabled &&
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
      await sync.configure({ ...sync.config, url: draft.url, token: draft.token });
      setDraft({ url: sync.config.url, token: sync.config.token });
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setResult(undefined);
    try {
      await sync.testServer(draft.url, draft.token);
      setResult({ ok: true, text: "The server answers and accepts the token." });
    } catch (err) {
      setResult({ ok: false, text: errorMessage(err) });
    } finally {
      setTesting(false);
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
    setDraft({ url: sync.config.url, token: sync.config.token });
    setResult(undefined);
  };

  return (
    <>
      <p className="helper">The Kubus server this device syncs with, and that offers it a language model and remote collections.</p>
      <Stack gap={7}>
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
            {result && <InlineNotification kind={result.ok ? "success" : "error"} title={result.ok ? "Connected" : "Can't connect"} subtitle={result.text} lowContrast hideCloseButton />}
            <div>
              <Button size="sm" kind="primary" type="submit" disabled={saving || !dirty}>
                Save
              </Button>{" "}
              <Button size="sm" kind="tertiary" disabled={testing || !draft.url.trim()} onClick={() => void test()}>
                Test connection
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
        {connected && sync.config.url && <ApiTokens />}
      </Stack>
      {dialog}
    </>
  );
}
