import { useCallback, useState, type ReactNode } from "react";
import { Modal } from "@carbon/react";
import { ShownDialog } from "./ShownDialog";
export { errorMessage } from "../domain/errors";

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  /** Red styling, for deletions; false for a plain confirmation. */
  danger?: boolean;
}

/** Promise-based danger confirmation. Render `dialog` somewhere in the page. */
export function useConfirm() {
  const [request, setRequest] = useState<{ options: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => setRequest({ options, resolve })), []);

  const close = (ok: boolean) => {
    request?.resolve(ok);
    setRequest(null);
  };

  // Only while asking (ShownDialog): what had focus (the delete button) gets it back once it closes.
  const dialog = (
    <ShownDialog shown={request !== null}>
      {(open) => (
        <Modal
          open={open}
          danger={request?.options.danger ?? true}
          size="xs"
          modalHeading={request?.options.title}
          primaryButtonText={request?.options.confirmLabel ?? "Delete"}
          secondaryButtonText="Cancel"
          onRequestSubmit={() => close(true)}
          onRequestClose={() => close(false)}
        >
          <p>{request?.options.body}</p>
        </Modal>
      )}
    </ShownDialog>
  );

  return { confirm, dialog };
}
