import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@carbon/react";
import "@carbon/styles/css/styles.css";
import "./fonts.css";
import "./styles.css";
import { App } from "./app/App";
import { suppressShellContextMenu } from "./platform/contextMenu";
import { registerServiceWorker } from "./platform/serviceWorker";
import { trackKeyboardInset } from "./platform/keyboardInset";
import { useDark, usePageTheme } from "./app/settings";
import { escapeThroughDropdowns } from "./ui/escapeThroughDropdowns";

function Root() {
  // The theme chosen in Settings → Display (synced; the device's copy until the database opens).
  const dark = useDark();
  usePageTheme(dark);
  return (
    <Theme theme={dark ? "g100" : "white"} className="app-root">
      <App />
    </Theme>
  );
}

suppressShellContextMenu();
// iOS ignores user-scalable=no for pinch gestures in some versions; this stops them everywhere.
for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}
registerServiceWorker();
trackKeyboardInset();
escapeThroughDropdowns();

// The first render waits (at most a second) for the bundled faces nearly every page uses: drawn in
// a fallback first and swapped, their different widths re-wrapped the text and moved the page.
const FACES = ['400 1em "IBM Plex Sans"', '600 1em "IBM Plex Sans"', '300 1em "IBM Plex Sans"', '400 1em "IBM Plex Mono"'];
const fontsLoaded = Promise.all(FACES.map((f) => document.fonts?.load(f))).catch(() => undefined);
void Promise.race([fontsLoaded, new Promise((r) => setTimeout(r, 1000))]).then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  ),
);
