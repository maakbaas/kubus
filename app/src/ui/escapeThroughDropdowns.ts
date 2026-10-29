/**
 * Carbon's dropdowns (ListBox) stop every Escape from going further, also with their menu closed;
 * that is meant for an open menu in a dialog, but it left a dialog or popover that Escape couldn't
 * close while one of its dropdowns had focus. An Escape on a closed dropdown that didn't get past
 * it is sent on to the document, where dialogs (Carbon's Modal) and toolbar popovers listen.
 * A closed multi-select would also clear its choice on Escape (Delete does that): it doesn't get the Escape at all.
 */
export function escapeThroughDropdowns() {
  let pending: KeyboardEvent | null = null;
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !e.isTrusted) return;
      const field = (e.target as Element | null)?.closest?.(".cds--list-box__field, .cds--list-box input");
      if (!field || field.getAttribute("aria-expanded") === "true") return;
      if (field.closest(".cds--multi-select")) e.stopPropagation();
      pending = e;
      setTimeout(() => {
        if (pending !== e) return;
        pending = null;
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true }));
      });
    },
    true,
  );
  // It got through by itself: nothing to send on.
  document.addEventListener("keydown", (e) => {
    if (e === pending) pending = null;
  });
}
