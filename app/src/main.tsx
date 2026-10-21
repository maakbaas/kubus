import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@carbon/react";
import "@carbon/styles/css/styles.css";
import "./styles.css";
import { App } from "./app/App";
import { suppressShellContextMenu } from "./platform/contextMenu";
import { useMediaQuery } from "./ui/useMediaQuery";

function Root() {
  const dark = useMediaQuery("(prefers-color-scheme: dark)");
  return (
    <Theme theme={dark ? "g100" : "white"} className="app-root">
      <App />
    </Theme>
  );
}

suppressShellContextMenu();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
