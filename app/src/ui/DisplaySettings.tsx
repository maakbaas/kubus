import { useId, useState } from "react";
import { Button, InlineNotification, Select, SelectItem, Stack } from "@carbon/react";
import { Renew } from "@carbon/icons-react";
import type { MapStyleId } from "../../../shared/settings";
import { setDisplaySetting, useDisplaySettings, type DisplaySettings as Settings } from "../app/settings";
import { useStore } from "../app/store";
import { MAP_STYLES } from "../views/mapLibre";
import { errorMessage } from "./useConfirm";
import { updateAndReload } from "../platform/serviceWorker";
import { inDesktopShell } from "../platform/shell";

const THEMES: { value: Settings["theme"]; text: string }[] = [
  { value: "auto", text: "Automatic (like the system)" },
  { value: "light", text: "Light" },
  { value: "dark", text: "Dark" },
];

/** The installed desktop app bundles its build (only a new install updates it); the web and home-screen app load a new one. */
const reloads = !inDesktopShell();

/**
 * How the app looks: its theme and how the maps of Map blocks look. Synced like content (app/settings.ts):
 * the same on every device that syncs, and set without a server too. A section of the settings.
 */
export function DisplaySettings() {
  const uid = useId();
  const { repo } = useStore();
  const settings = useDisplaySettings();
  const [error, setError] = useState<string>();
  const [updating, setUpdating] = useState(false);
  const change = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setError(undefined);
    setDisplaySetting(repo, key, value).catch((e) => setError(errorMessage(e)));
  };
  return (
    <>
      <p className="helper">How Kubus looks, the same on every device that syncs.</p>
      <Stack gap={5}>
        <Select size="sm" id={`${uid}-theme`} labelText="Theme" value={settings.theme} onChange={(e) => change("theme", e.target.value as Settings["theme"])}>
          {THEMES.map((t) => (
            <SelectItem key={t.value} value={t.value} text={t.text} />
          ))}
        </Select>
        <Select
          size="sm"
          id={`${uid}-map-style`}
          labelText="Map style"
          helperText="How the maps of Map blocks look. Automatic: light or dark like the app."
          value={settings.mapStyle}
          onChange={(e) => change("mapStyle", e.target.value as MapStyleId)}
        >
          {MAP_STYLES.map((s) => (
            <SelectItem key={s.value} value={s.value} text={s.text} />
          ))}
        </Select>
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle={error} />}
        {/* The app starts from its cache and takes a new build in the background; iOS can keep a home-screen app on the
            old one a while after the server was updated. This loads the newest build now (platform/serviceWorker.ts). */}
        {reloads && (
          <div className="settings-reload">
            <Button
              size="sm"
              kind="tertiary"
              renderIcon={Renew}
              disabled={updating}
              onClick={() => {
                setUpdating(true);
                void updateAndReload();
              }}
            >
              {updating ? "Updating…" : "Reload app"}
            </Button>
            <p className="helper">Loads the newest version of Kubus, e.g.    right after the server was updated. It updates itself too, but a home-screen app can take a while.</p>
          </div>
        )}
      </Stack>
    </>
  );
}
