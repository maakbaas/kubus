import { useEffect, useState, useSyncExternalStore } from "react";
import type { ServerSettingsUpdate, ServerSettingsView } from "../../../shared/settings";
import { useStore } from "../app/store";
import { errorMessage } from "./useConfirm";

// The settings of the Kubus server this device is connected to (Settings → Server), the same for every
// device: its language model (Settings → AI) and the databases it reads (Settings → Connections).
// Stored on the server only (shared/settings.ts), changed with the sync token. Each tab saves its own
// part on top of what the server holds then, so one tab's save never undoes another's.

/** What is set, as it would be saved again: secrets left out stay as they are. */
export const updateOf = (view: ServerSettingsView): ServerSettingsUpdate => ({
  ai: { url: view.ai.url, fieldModel: view.ai.fieldModel, codeModel: view.ai.codeModel },
  sources: view.sources.map(({ id, name, kind, fields, schemas, timeoutSeconds }) => ({ id, name, kind, fields, schemas, timeoutSeconds })),
  ...(view.map && { map: view.map }),
});

export function useServerSettings() {
  const { sources, ai, repo } = useStore();
  // Follows the server settings (another server, another token).
  useSyncExternalStore(repo.sync.subscribe.bind(repo.sync), () => repo.sync.status);
  const { url, token } = repo.sync.config;
  const connected = !!url && !!token;
  const [view, setView] = useState<ServerSettingsView | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!connected) return;
    setView(null);
    setError(undefined);
    sources.serverSettings().then(setView, (e) => setError(errorMessage(e)));
  }, [sources, connected, url, token]);

  /** Saves `change` applied to the server's settings as they are now; returns what the server holds then. */
  const save = async (change: (current: ServerSettingsUpdate) => ServerSettingsUpdate): Promise<ServerSettingsView> => {
    const next = await sources.saveServerSettings(change(updateOf(await sources.serverSettings())));
    setView(next);
    // What the server offers changed: the model, and the sources remote collections read.
    ai.serverChanged();
    sources.refresh(null);
    return next;
  };

  return { connected, url, view, error, save };
}
