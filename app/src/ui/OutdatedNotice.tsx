import { useState } from "react";
import { Button } from "@carbon/react";
import { updateAndReload } from "../platform/serviceWorker";
import { SYNC_OUTDATED } from "../data/repository";
import type { SyncStatus } from "../data/repository";
import { inDesktopShell } from "../platform/shell";

/** The installed desktop app bundles its build: only a new install updates it. The web and home-screen app load a new build on reload. */
const reloads = !inDesktopShell();

const DETAIL = {
  app: "This device runs an older version of Kubus than the server. Your changes stay on this device and sync once it is updated.",
  server: "The server runs an older version of Kubus than this device. Your changes stay on this device and sync once the server is updated.",
} as const;

/** What a refused device (`SyncStatus.outdated`) is told, with Reload where reloading brings the new build. */
export function OutdatedNotice({ update, className }: { update: NonNullable<SyncStatus["outdated"]>; className?: string }) {
  const [updating, setUpdating] = useState(false);
  return (
    <div className={className}>
      <p className="sync-popover__state">{SYNC_OUTDATED[update]}</p>
      <p className="helper sync-popover__detail">{DETAIL[update]}</p>
      {update === "app" && reloads && (
        <Button size="sm" kind="tertiary" disabled={updating} onClick={() => {
            setUpdating(true);
            void updateAndReload();
          }}
        >
          {updating ? "Updating…" : "Reload to update"}
        </Button>
      )}
    </div>
  );
}
