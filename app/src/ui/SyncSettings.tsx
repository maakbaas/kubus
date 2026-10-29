import { useId, useReducer, useState, useSyncExternalStore } from "react";
import { Button, FormGroup, InlineNotification, Select, SelectItem, Stack, Toggle } from "@carbon/react";
import type { SyncConfig } from "../data/repository";
import { useStore } from "../app/store";
import { errorMessage, useConfirm } from "./useConfirm";
import { ServerReplaced } from "./ServerReplaced";
import { OutdatedNotice } from "./OutdatedNotice";

const STATE_TEXT = { off: "Off", idle: "Up to date", syncing: "Syncing…", error: "Failed" } as const;

/** Whether this device syncs with its server (Settings → Server), how it downloads images, and wiping data (a section of the settings). */
export function SyncSettings() {
  const { repo } = useStore();
  const uid = useId();
  const { sync } = repo;
  const status = useSyncExternalStore(sync.subscribe.bind(sync), () => sync.status);
  // The config isn't a store of its own: shown again after each change.
  const [, configChanged] = useReducer((n: number) => n + 1, 0);
  const { confirm, dialog } = useConfirm();
  const [wipeError, setWipeError] = useState<string>();
  const { config } = sync;
  const hasServer = config.url !== "" && config.token !== "";

  // Each takes effect at once.
  const configure = async (patch: Partial<SyncConfig>) => {
    if (
      patch.enabled &&
      sync.isNewServer(config.url) &&
      !(await confirm({
        title: "Connect to this server?",
        body: "The server is the source of truth. If it already holds data, that replaces all data on this device. If it is empty, this device's data is uploaded to it.",
        confirmLabel: "Connect",
      }))
    ) {
      return;
    }
    const done = sync.configure({ ...sync.config, ...patch });
    configChanged();
    await done;
    configChanged();
  };

  const wipe = async () => {
    const ok = await confirm({
      title: "Wipe this device's data?",
      body: hasServer
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
      body: `Deletes ALL data on ${config.url}: every collection, item and file of every device that syncs with it, and the server's own settings: its language model, its connections and its API tokens. It can't be undone. Sync on this device is paused; switching it on again uploads this device's data. Other devices keep their data but stop matching the server: disconnect and connect them again, or wipe them.`,
      confirmLabel: "Wipe server database",
    });
    if (!ok) return;
    setWipeError(undefined);
    try {
      await sync.wipeServer();
      configChanged();
    } catch (e) {
      setWipeError(errorMessage(e));
    }
  };

  return (
    <>
      <p className="helper">Keeps this device's data in step with your Kubus server. The data stays on this device too, so Kubus works offline.</p>
      {status.outdated && <OutdatedNotice update={status.outdated} className="sync-popover" />}
      {status.error && <InlineNotification kind="error" title="Sync failed" subtitle={status.error} hideCloseButton />}
      {status.replaced && (
        <div className="sync-popover">
          <ServerReplaced replaced={status.replaced} onConnect={() => void configure({ enabled: true })} />
        </div>
      )}
      {wipeError && <InlineNotification kind="error" title="Wiping the server failed" subtitle={wipeError} onClose={() => setWipeError(undefined)} />}
      <Stack gap={7}>
        <Stack gap={6}>
          {!hasServer && (
            <InlineNotification kind="info" title="No server" subtitle="Connect this device to a Kubus server first (Settings → Server)." lowContrast hideCloseButton />
          )}
          <Toggle
            size="sm"
            id={`${uid}-enabled`}
            labelText="Sync this device"
            labelA="Off"
            labelB="On"
            disabled={!hasServer}
            toggled={config.enabled}
            onToggle={(enabled) => void configure({ enabled })}
          />
          <Select
            size="sm"
            id={`${uid}-originals`}
            labelText="Download images"
            helperText={
              config.originals === "opened"
                ? "Thumbnails after each sync; a full-size image when it is first shown (then kept for offline use)."
                : "Every image, full size, after each sync: all of them are available offline."
            }
            value={config.originals}
            onChange={(e) => void configure({ originals: e.target.value === "opened" ? "opened" : "always" })}
          >
            <SelectItem value="always" text="All, full size" />
            <SelectItem value="opened" text="Full size when opened" />
          </Select>
          <p className="helper">
            {status.outdated ? "Not syncing" : STATE_TEXT[status.state]}
            {status.lastSync && `, last synced ${new Date(status.lastSync).toLocaleString()}`}
          </p>
        </Stack>
        <FormGroup legendText="Wipe">
          <div className="button-row">
            <Button size="sm" kind="danger--tertiary" onClick={() => void wipe()}>
              Wipe local database
            </Button>
            {hasServer && (
              <Button size="sm" kind="danger--tertiary" onClick={() => void wipeServer()}>
                Wipe server database
              </Button>
            )}
          </div>
        </FormGroup>
      </Stack>
      {dialog}
    </>
  );
}
