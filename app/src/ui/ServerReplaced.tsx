import { useState, type ReactNode } from "react";
import { Button } from "@carbon/react";
import type { SyncStatus } from "../data/repository";
import { useStore } from "../app/store";
import { errorMessage, useConfirm } from "./useConfirm";

/**
 * Sync paused because the server's database is another one than this device synced with (wiped
 * or replaced since): what happened and connecting again, which is a first connection to the new
 * database (its data replaces this device's; an empty one gets this device's data). `children`:
 * further buttons beside it.
 */
export function ServerReplaced({ replaced, onConnect, children }: { replaced: NonNullable<SyncStatus["replaced"]>; onConnect?(): void; children?: ReactNode }) {
  const { repo } = useStore();
  const { confirm, dialog } = useConfirm();
  const [error, setError] = useState<string>();
  const created = replaced.createdAt ? new Date(replaced.createdAt).toLocaleString() : undefined;
  const connect = async () => {
    // Replacing this device's data asks first; uploading to an empty server needs no answer.
    if (
      !replaced.empty &&
      !(await confirm({
        title: "Replace this device's data?",
        body: "Everything on this device is replaced with what the server's new database holds. It can't be undone.",
        confirmLabel: "Replace",
      }))
    ) {
      return;
    }
    setError(undefined);
    onConnect?.();
    try {
      await repo.sync.reconnect();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <>
      <p className="sync-popover__state">The server's database was wiped or replaced</p>
      <p className="helper sync-popover__detail">
        {created ? `The server now holds a database made ${created}. ` : ""}
        Sync is paused, so nothing from this device lands in it by accident.{" "}
        {replaced.empty ? "It is empty: connecting again uploads this device's data." : "Connecting again replaces this device's data with the server's."}
      </p>
      {error && <p className="helper sync-popover__detail">{error}</p>}
      <div>
        <Button size="sm" kind="tertiary" onClick={() => void connect()}>
          {replaced.empty ? "Upload this device's data" : "Download the server's data"}
        </Button>
        {children}
      </div>
      {dialog}
    </>
  );
}
