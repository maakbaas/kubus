// Platform adapter: the desktop shell's own right-click menu (Reload, Inspect, …) is not part
// of the app, so it is suppressed there. Browsers keep their normal menu.
import { inDesktopShell } from "./shell";

export function suppressShellContextMenu() {
  if (!inDesktopShell()) return;
  window.addEventListener("contextmenu", (e) => e.preventDefault());
}
