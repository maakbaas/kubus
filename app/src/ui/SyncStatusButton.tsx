import { useSyncExternalStore } from "react";
import { Button } from "@carbon/react";
import { CheckmarkOutline, Cloud, Renew, WarningAltFilled } from "@carbon/icons-react";
import { useStore } from "../app/store";
import { ToolbarPopover } from "./ToolbarPopover";
import { ServerReplaced } from "./ServerReplaced";
import { OutdatedNotice } from "./OutdatedNotice";
import { SYNC_OUTDATED } from "../data/repository";

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
  // Paused because the server's database is another one: shown as a failure until answered.
  const replaced = status.replaced;
  const state = replaced ? "error" : status.state;
  const outdated = status.outdated;
  return (
    <ToolbarPopover label={replaced ? "Server database replaced" : outdated ? SYNC_OUTDATED[outdated] : TITLES[state]} icon={ICONS[state]} className={`sync-status sync-status--${state}`} fit>
      {(close) => replaced ? (
        <div className="sync-popover">
          <ServerReplaced replaced={replaced} onConnect={close}>
            {" "}
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
          </ServerReplaced>
        </div>
      ) : (
        <div className="sync-popover">
          {outdated ? (
            <OutdatedNotice update={outdated} />
          ) : (
            <p className="sync-popover__state">{TITLES[status.state]}</p>
          )}
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
