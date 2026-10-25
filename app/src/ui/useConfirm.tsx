import { useCallback, useRef, useState, type ReactNode } from "react";
import { Modal } from "@carbon/react";
import { returnFocus } from "./useMountedDialog";

interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  /** Red styling, for deletions; false for a plain confirmation. */
  danger?: boolean;
}

/** Promise-based danger confirmation. Render `dialog` somewhere in the page. */
export function useConfirm() {
  const [request, setRequest] = useState<{ options: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);

  // What had focus when asked (the delete button): it gets it back once the dialog closes.
  const launcher = useRef<Element | null>(null);
  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        launcher.current = document.activeElement;
        setRequest({ options, resolve });
      }),
    [],
  );

  const close = (ok: boolean) => {
    request?.resolve(ok);
    setRequest(null);
    returnFocus(launcher.current);
  };

  const dialog = (
    <Modal
      open={request !== null}
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
  );

  return { confirm, dialog };
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
