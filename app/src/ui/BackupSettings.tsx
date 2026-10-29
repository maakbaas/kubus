import { useId, useState } from "react";
import { Button, FileUploaderButton, InlineNotification, Stack } from "@carbon/react";
import { useStore } from "../app/store";
import { downloadFile } from "../platform/download";
import { errorMessage, useConfirm } from "./useConfirm";

/** `kubus-backup-2026-10-29.sqlite`: today's date, on this device's calendar. */
export const backupFileName = (day = new Date()) =>
  `kubus-backup-${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}.sqlite`;

/**
 * A backup of this device's data as one SQLite file, and restoring from one (a section of the
 * settings). Restoring checks the file first (a refusal says why and changes nothing), asks, then
 * replaces everything and reloads the app; sync is left off, to be switched on again as a first connection.
 */
export function BackupSettings() {
  const { repo } = useStore();
  const uid = useId();
  const { confirm, dialog } = useConfirm();
  const [error, setError] = useState<{ title: string; message: string }>();
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setError(undefined);
    setBusy(true);
    try {
      const bytes = await repo.exportBackup();
      downloadFile(backupFileName(), bytes as Uint8Array<ArrayBuffer>, "application/vnd.sqlite3");
    } catch (e) {
      setError({ title: "The backup failed", message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const restore = async (file: File) => {
    setError(undefined);
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await repo.checkBackup(bytes);
      const ok = await confirm({
        title: "Replace all data on this device?",
        body: `Everything on this device is replaced with what ${file.name} holds: collections, items, views, components and images. It can't be undone. Sync is switched off; switching it on again is a first connection to the server.`,
        confirmLabel: "Replace all data",
      });
      if (!ok) return;
      await repo.restoreBackup(bytes);
      location.reload();
    } catch (e) {
      setError({ title: "This file can't be restored", message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="helper">
        Kubus keeps your data on this device only (and on your server, when sync is on). A backup is a copy of it in one file that you keep elsewhere: download one regularly.
      </p>
      {error && <InlineNotification kind="error" title={error.title} subtitle={error.message} onClose={() => setError(undefined)} />}
      <Stack gap={7}>
        <Stack gap={5}>
          <p className="helper">
            Included: all collections, items, views, components, spaces and bookmarks, the settings kept in the database, and the images stored on this device. Not included: this
            device's own AI key and the other preferences kept in this browser (including the server's address and token), and images this device has not downloaded.
          </p>
          <div className="button-row">
            <Button size="sm" kind="tertiary" disabled={busy} onClick={() => void download()}>
              Download backup
            </Button>
          </div>
        </Stack>
        <Stack gap={5}>
          <p className="helper">
            Restoring replaces all data on this device with a backup file. A backup made by an older Kubus is brought up to date; one made by a newer Kubus is refused.
          </p>
          <div className="button-row">
            <FileUploaderButton
              id={`${uid}-restore`}
              size="sm"
              buttonKind="danger--tertiary"
              labelText="Restore from backup…"
              accept={[".sqlite", ".sqlite3", ".db", ".kubus"]}
              disableLabelChanges
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void restore(file);
              }}
            />
          </div>
        </Stack>
      </Stack>
      {dialog}
    </>
  );
}
