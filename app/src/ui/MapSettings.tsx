import { useId, useState } from "react";
import { InlineNotification, Select, SelectItem, Stack } from "@carbon/react";
import type { MapStyleId } from "../../../shared/settings";
import { setMapStyle, useMapStyle } from "../app/mapStyle";
import { MAP_STYLES } from "../views/mapLibre";
import { errorMessage } from "./useConfirm";
import { useServerSettings } from "./useServerSettings";

/**
 * How every map looks (Map blocks): one style. With a server it is the server's setting, the same
 * for every device connected to it; without one, this device's own. A section of the settings.
 */
export function MapSettings() {
  const uid = useId();
  const server = useServerSettings();
  const local = useMapStyle();
  const [error, setError] = useState<string>();
  // A server of an earlier version has no map style: this device keeps its own.
  const onServer = server.connected && !!server.view?.map;
  const value = onServer ? server.view!.map!.style : local;
  const change = async (style: MapStyleId) => {
    setError(undefined);
    if (!onServer) return setMapStyle(style);
    try {
      const next = await server.save((current) => ({ ...current, map: { style } }));
      setMapStyle(next.map?.style ?? style);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <>
      <p className="helper">How the maps of Map blocks look.</p>
      <Stack gap={5}>
        <Select
          size="sm"
          id={`${uid}-map-style`}
          labelText="Map style"
          helperText={
            onServer
              ? "For every device connected to this server. Automatic: light or dark like the app."
              : server.connected && server.view
                ? "This server is of an earlier version: the style is this device's own. Automatic: light or dark like the app."
                : "This device's own (with a server it is the server's, for every device). Automatic: light or dark like the app."
          }
          value={value}
          disabled={server.connected && !server.view && !server.error}
          onChange={(e) => change(e.target.value as MapStyleId)}
        >
          {MAP_STYLES.map((s) => (
            <SelectItem key={s.value} value={s.value} text={s.text} />
          ))}
        </Select>
        {(error || server.error) && <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle={error ?? server.error} />}
      </Stack>
    </>
  );
}
