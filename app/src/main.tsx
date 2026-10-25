import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@carbon/react";
import "@carbon/styles/css/styles.css";
import "./styles.css";
import { App } from "./app/App";
import { suppressShellContextMenu } from "./platform/contextMenu";
import { registerServiceWorker } from "./platform/serviceWorker";
import { trackKeyboardInset } from "./platform/keyboardInset";
import { useMediaQuery } from "./ui/useMediaQuery";
import { escapeThroughDropdowns } from "./ui/escapeThroughDropdowns";

function Root() {
  const dark = useMediaQuery("(prefers-color-scheme: dark)");
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
