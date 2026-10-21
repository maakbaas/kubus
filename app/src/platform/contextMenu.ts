// Platform adapter: the desktop shell's own right-click menu (Reload, Inspect, …) is not part
// of the app, so it is suppressed there. Browsers keep their normal menu.

export function suppressShellContextMenu() {
  if (!("__TAURI_INTERNALS__" in window)) return;
  window.addEventListener("contextmenu", (e) => e.preventDefault());
}
