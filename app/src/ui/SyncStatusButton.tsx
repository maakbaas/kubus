import { useSyncExternalStore } from "react";
import { Button } from "@carbon/react";
import { CheckmarkOutline, Cloud, Renew, WarningAltFilled } from "@carbon/icons-react";
import { useStore } from "../app/store";
import { ToolbarPopover } from "./ToolbarPopover";

const ICONS = { off: Cloud, idle: CheckmarkOutline, syncing: Renew, error: WarningAltFilled } as const;
const TITLES = { off: "Sync is off", idle: "Up to date", syncing: "Syncing…", error: "Sync failed" } as const;

/**
 * The sync state at the end of the top-right tab strip: off, syncing, up to date or failed. The
 * icon only shows the state; its popover tells more and leads to the sync settings.
 */
export function SyncStatusButton({ onConfigure }: { onConfigure(): void }) {
  const { repo } = useStore();
  const { sync } = repo;
  const status = useSyncExternalStore(sync.subscribe.bind(sync), () => sync.status);
  const lastSync = status.lastSync ? new Date(status.lastSync).toLocaleString() : undefined;
  return (
    <ToolbarPopover label={TITLES[status.state]} icon={ICONS[status.state]} className={`sync-status sync-status--${status.state}`} fit>
      {(close) => (
        <div className="sync-popover">
          <p className="sync-popover__state">{TITLES[status.state]}</p>
          {status.error && <p className="helper sync-popover__detail">{status.error}</p>}
          {lastSync && <p className="helper sync-popover__detail">Last synced {lastSync}</p>}
          <Button
            size="sm"
            kind="tertiary"
            onClick={() => {
              close();
              onConfigure();
            }}
          >
            Configure sync
          </Button>
        </div>
      )}
    </ToolbarPopover>
  );
}
