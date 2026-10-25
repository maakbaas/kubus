import { useEffect, useState } from "react";

/**
 * Puts focus back on `launcher` once a dialog has closed, unless something else took it: focus is
 * on nothing or still in the closed dialog (one that stays mounted keeps it on its hidden button).
 */
export function returnFocus(launcher: Element | null) {
  setTimeout(() => {
    const focus = document.activeElement;
    const lost = !focus || focus === document.body || !!focus.closest(".cds--modal:not(.is-visible)");
    if (launcher instanceof HTMLElement && launcher.isConnected && lost) launcher.focus();
  });
}

/**
 * For a Carbon Modal rendered only while shown: its `open`, false on the first render and true
 * right after (Carbon moves focus into a dialog, and so keeps Tab inside it, when `open` turns
 * true, not when it mounts open: a dialog mounted open left focus on the page behind it). Once it
 * is gone, focus goes back to what had it when the dialog opened (its button), as Carbon only
 * does for a dialog that stays mounted and is given that button.
 */
export function useMountedDialog() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const launcher = document.activeElement;
    setOpen(true);
    return () => returnFocus(launcher);
  }, []);
  return open;
}
