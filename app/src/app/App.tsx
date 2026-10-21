import { useEffect, useState, type PointerEvent } from "react";
import { IconButton, InlineNotification, Layer, Loading, Search, SideNav } from "@carbon/react";
import { OpenPanelFilledLeft, OpenPanelLeft } from "@carbon/icons-react";
import { SyncStatusButton } from "../ui/SyncStatusButton";
import { GlobalLinks, useWorkspace, WorkspaceProvider, WorkspaceView } from "../workspace/Workspace";
import { readPref, writePref } from "../ui/localPrefs";
import { useMediaQuery } from "../ui/useMediaQuery";
import { NavTree } from "./NavTree";
import { StoreProvider, useStore } from "./store";

export function App() {
  return (
    <StoreProvider
      fallback={({ loading, error }) => (
        <main className="app-content app-content--bare">
          {loading && (
            <div className="page-loading page-loading--window">
              <Loading description="Opening database" withOverlay={false} />
            </div>
          )}
          {error && <InlineNotification kind="error" title="Could not open database" subtitle={error} hideCloseButton />}
        </main>
      )}
    >
      <WorkspaceProvider>
        <Shell />
      </WorkspaceProvider>
    </StoreProvider>
  );
}

const NAV_DOCKED_KEY = "kubus.navDocked";
const NAV_WIDTH_KEY = "kubus.navWidth";
/** Docked side nav width limits in rem (Carbon's default width is 16rem). */
const NAV_WIDTH = { min: 12, max: 32, initial: 16 };

function readNavWidth(): number {
  const v = Number(readPref(NAV_WIDTH_KEY, NAV_WIDTH.initial));
  return v >= NAV_WIDTH.min && v <= NAV_WIDTH.max ? v : NAV_WIDTH.initial;
}

function Shell() {
  const { repo } = useStore();
  const ws = useWorkspace();
  const [navOpen, setNavOpen] = useState(false);
  // Desktop: the side nav is docked unless the user collapsed it (remembered per device).
  const desktop = useMediaQuery("(min-width: 66rem)");
  const [docked, setDocked] = useState(() => readPref(NAV_DOCKED_KEY, true) === true);
  const toggleNav = () => {
    if (!desktop) return setNavOpen((open) => !open);
    setDocked((d) => {
      writePref(NAV_DOCKED_KEY, !d);
      return !d;
    });
  };
  const navShown = desktop ? docked : navOpen;

  // Docked side nav width (rem), resized by dragging the gutter at its edge.
  const [navWidth, setNavWidth] = useState(readNavWidth);
  useEffect(() => {
    document.documentElement.style.setProperty("--nav-width", `${navWidth}rem`);
  }, [navWidth]);
  const startNavResize = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    let width = navWidth;
    const move = (ev: globalThis.PointerEvent) => {
      width = Math.min(NAV_WIDTH.max, Math.max(NAV_WIDTH.min, ev.clientX / rem));
      setNavWidth(width);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      writePref(NAV_WIDTH_KEY, width);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  /** Double click on the gutter: back to the default width. */
  const resetNavWidth = () => {
    setNavWidth(NAV_WIDTH.initial);
    writePref(NAV_WIDTH_KEY, undefined);
  };
  const [pathname, queryString = ""] = ws.activePath.split("?");

  // A link opened from outside (e.g. "#/types/…" in the address bar) goes to the active tab.
  useEffect(() => {
    const hash = window.location.hash;
    if (hash.startsWith("#/")) {
      ws.navigate(hash.slice(1));
      history.replaceState(null, "", window.location.pathname);
    }
    // Only on start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On narrow screens the side nav is an overlay; close it after navigating
  // (but not while typing a search, which navigates on every keystroke).
  useEffect(() => {
    if (pathname !== "/search") setNavOpen(false);
  }, [pathname]);

  const query = pathname === "/search" ? (new URLSearchParams(queryString).get("q") ?? "") : "";
  const search = (q: string) => ws.navigate(q ? `/search?q=${encodeURIComponent(q)}` : "/search");

  // The side nav toggle: filled panel = menu shown, outlined panel = hidden. There is no header
  // bar (the space goes to content): while the menu is shown the toggle starts its top row,
  // before the search; while it is hidden it leads the top-left tab strip (like "+" ends each),
  // so it stays at the window's left edge either way.
  const navToggle = (
    <IconButton
      autoAlign
      kind="ghost"
      size="sm"
      align="bottom-start"
      label={navShown ? "Hide menu" : "Show menu"}
      aria-expanded={navShown}
      onClick={toggleNav}
    >
      {navShown ? <OpenPanelFilledLeft /> : <OpenPanelLeft />}
    </IconButton>
  );

  return (
    <>
      <GlobalLinks>
        <SideNav
          aria-label="Side navigation"
          expanded={navShown}
          isPersistent={desktop && docked}
          onOverlayClick={() => setNavOpen(false)}
          href="#main-content"
        >
          <Layer className="side-nav-search">
            {navShown && navToggle}
            <Search
              size="sm"
              labelText="Search all objects"
              placeholder="Search"
              value={query}
              onChange={(e) => search(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && setNavOpen(false)}
            />
          </Layer>
          <NavTree activePath={ws.activePath} navigate={(path) => ws.navigate(path)} openTab={(path) => ws.openTab(path)} />
        </SideNav>
      </GlobalLinks>
      {desktop && docked && (
        // Divider between the docked side nav and the workspace; drag to resize the nav.
        <div
          className="ws-divider nav-gutter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize menu"
          onPointerDown={startNavResize}
          onDoubleClick={resetNavWidth}
        />
      )}
      <main id="main-content" className={`app-content app-content--workspace${desktop && docked ? " app-content--nav-docked" : ""}`}>
        {!repo.storage.persistent && (
          <InlineNotification
            kind="warning"
            title="Temporary storage"
            subtitle="This browser does not support persistent storage (OPFS). Changes are lost when you reload."
            hideCloseButton
          />
        )}
        <WorkspaceView tabStripStart={navShown ? null : navToggle} tabStripEnd={<SyncStatusButton onOpen={() => ws.navigate("/sync")} />} />
      </main>
    </>
  );
}

