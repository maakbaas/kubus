import { useSyncExternalStore } from "react";
import { IconButton } from "@carbon/react";
import { CheckmarkOutline, Cloud, Renew, WarningAltFilled } from "@carbon/icons-react";
import { useStore } from "../app/store";

const ICONS = { off: Cloud, idle: CheckmarkOutline, syncing: Renew, error: WarningAltFilled } as const;

/**
 * The sync state at the end of the top-right tab strip: off, syncing, up to date or failed.
 * Clicking it opens the Sync page.
 */
export function SyncStatusButton({ onOpen }: { onOpen(): void }) {
  const { repo } = useStore();
  const { sync } = repo;
  const status = useSyncExternalStore(sync.subscribe.bind(sync), () => sync.status);
  const Icon = ICONS[status.state];
  const label =
    status.state === "error"
      ? `Sync failed: ${status.error}`
      : status.state === "syncing"
        ? "Syncing…"
        : status.state === "idle"
          ? `Synced${status.lastSync ? ` ${new Date(status.lastSync).toLocaleTimeString()}` : ""}`
          : "Sync is off";
  return (
    <IconButton autoAlign label={label} kind="ghost" size="sm" align="bottom-end" className={`sync-status sync-status--${status.state}`} onClick={onOpen}>
      <Icon />
    </IconButton>
  );
}
