import { Button } from "@carbon/react";
import { SYNC_OUTDATED } from "../data/repository";
import type { SyncStatus } from "../data/repository";

/** The installed desktop app bundles its build: only a new install updates it. The web and home-screen app load a new build on reload. */
const reloads = typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);

const DETAIL = {
  app: "This device runs an older version of Kubus than the server. Your changes stay on this device and sync once it is updated.",
  server: "The server runs an older version of Kubus than this device. Your changes stay on this device and sync once the server is updated.",
} as const;

/** What a refused device (`SyncStatus.outdated`) is told, with Reload where reloading brings the new build. */
export function OutdatedNotice({ update, className }: { update: NonNullable<SyncStatus["outdated"]>; className?: string }) {
  return (
    <div className={className}>
      <p className="sync-popover__state">{SYNC_OUTDATED[update]}</p>
      <p className="helper sync-popover__detail">{DETAIL[update]}</p>
      {update === "app" && reloads && (
        <Button size="sm" kind="tertiary" onClick={() => location.reload()}>
          Reload to update
        </Button>
      )}
    </div>
  );
}
