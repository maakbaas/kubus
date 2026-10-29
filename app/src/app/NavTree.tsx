import { useState, type ElementType, type MouseEvent } from "react";
import { TreeNode, TreeView } from "@carbon/react";
import { Bookmark as BookmarkIcon, Cube, Code as ComponentIcon, Dashboard as DashboardIcon, DataBase, Help as HelpIcon, Settings as SettingsIcon } from "@carbon/icons-react";
import { bookmarkPath } from "../domain/bookmarks";
import { dashboardIcon } from "../domain/dashboards";
import { readPref, writePref } from "../ui/localPrefs";
import { CollectionIcon } from "../ui/collectionIcons";
import { isRemote } from "../domain/sources";
import { useStore } from "./store";
import { useRemotesShown } from "./useRemotes";

const EXPANDED_KEY = "kubus.navExpanded";


// TreeNode renders its icon as a component; one stable component per collection icon name.
const iconComponents = new Map<string, ElementType>();
function collectionIcon(name: string | null): ElementType {
  const key = name ?? "";
  let Icon = iconComponents.get(key);
  if (!Icon) {
    // Carbon passes its icon class (spacing, colour); keep it, on a wrapper around the icon.
    Icon = function NavCollectionIcon({ className }: { className?: string }) {
      return (
        <span className={`${className ?? ""} nav-tree__icon`}>
          <CollectionIcon name={name} />
        </span>
      );
    };
    iconComponents.set(key, Icon);
  }
  return Icon;
}

/**
 * The side nav as a Carbon tree: Bookmarks (the space's bookmarked views, items and dashboard tabs), Dashboards (its
 * page, with the space's dashboards below it), Collections
 * (its page, with the space's native collections below it), Remotes (while the server has a remote
 * connection or remote collections exist: its page, with the space's remote collections below it)
 * and Components. Choosing a node opens its page in the active tab
 * (through `navigate`: Carbon's tree stops clicks, so plain links wouldn't reach the workspace).
 * The selected node follows the active tab's page (a bookmark of it wins). Middle click opens a
 * node's page in a new tab.
 */
export function NavTree({ activePath, navigate, openTab }: { activePath: string; navigate(path: string): void; openTab(path: string): void }) {
  const { collections, spaceCollections, dashboards, spaceDashboards, bookmarks } = useStore();
  const remotesShown = useRemotesShown();
  // Which sections are open, remembered per device.
  const [expanded, setExpanded] = useState(() => readPref<Record<string, boolean>>(EXPANDED_KEY, {}));
  const isOpen = (id: string) => expanded[id] ?? true;
  const toggle = (id: string, open: boolean) =>
    setExpanded((e) => {
      const next = { ...e, [id]: open };
      writePref(EXPANDED_KEY, next);
      return next;
    });

  // Carbon calls onToggle(event, node) with the node's new state.
  const onToggle = (id: string) => (_event: unknown, node?: { isExpanded?: boolean }) => toggle(id, !!node?.isExpanded);

  const [pathname] = activePath.split("?");
  const bookmark = bookmarks.find((b) => activePath === bookmarkPath(b));
  const collection = collections.find((t) => pathname.startsWith(`/collections/${t.id}/items`));
  const dashboard = dashboards.find((d) => pathname === `/dashboards/${d.id}`);
  const selected = bookmark
    ? `bookmark-${bookmark.id}`
    : collection
      ? `collection-${collection.id}`
      : dashboard
        ? `dashboard-${dashboard.id}`
      : pathname === "/dashboards"
        ? "dashboards"
      : pathname === "/collections"
        ? "collections"
        : pathname === "/remotes" || pathname.startsWith("/remotes/")
          ? "remotes"
          : pathname === "/bookmarks"
          ? "bookmarks"
          : pathname.startsWith("/components")
            ? "components"
            : undefined;

  // Every node's page, by node id (Carbon renders the id on the node's <li>), for middle clicks.
  const paths: Record<string, string> = {
    bookmarks: "/bookmarks",
    dashboards: "/dashboards",
    collections: "/collections",
    remotes: "/remotes",
    components: "/components",
    ...Object.fromEntries(bookmarks.map((b) => [`bookmark-${b.id}`, bookmarkPath(b)])),
    ...Object.fromEntries(collections.map((t) => [`collection-${t.id}`, `/collections/${t.id}/items`])),
    ...Object.fromEntries(dashboards.map((d) => [`dashboard-${d.id}`, `/dashboards/${d.id}`])),
  };
  const nodePath = (e: MouseEvent) => paths[(e.target as HTMLElement).closest("li[id]")?.id ?? ""];

  const collectionNode = (t: (typeof collections)[number]) => (
    <TreeNode autoAlign key={t.id} id={`collection-${t.id}`} label={t.pluralName} onSelect={() => navigate(`/collections/${t.id}/items`)} renderIcon={collectionIcon(t.icon)} />
  );

  return (
    <div
      // No middle-button autoscroll on nodes; the aux click opens the page in a new tab.
      onMouseDown={(e) => e.button === 1 && nodePath(e) && e.preventDefault()}
      // The tooltip is only for labels cut off with "…": mark the others so CSS hides theirs.
      onMouseOver={(e) => {
        const text = (e.target as HTMLElement).closest(".cds--tree-node__label__details")?.querySelector<HTMLElement>(".cds--tree-node__label__text");
        if (text) text.closest(".cds--tree-node__label__details")?.toggleAttribute("data-fits", text.scrollWidth <= text.clientWidth);
      }}
      onAuxClick={(e) => {
        const path = e.button === 1 && nodePath(e);
        if (!path) return;
        e.preventDefault();
        openTab(path);
      }}
    >
      {/* Carbon ignores an empty `selected` and keeps the last node lit (e.g. on the Spaces page, which has no node), so the tree is remounted when there is none. */}
      <TreeView key={selected ? "tree" : "tree-none"} label="Navigation" hideLabel size="xs" selected={selected ? [selected] : []} active={selected} className="nav-tree">
        <TreeNode autoAlign
            id="bookmarks"
            label="Bookmarks"
            onSelect={() => navigate("/bookmarks")}
            renderIcon={BookmarkIcon}
            isExpanded={isOpen("bookmarks")}
            onToggle={onToggle("bookmarks")}
          >
            {bookmarks.map((b) => (
              <TreeNode autoAlign
                key={b.id}
                id={`bookmark-${b.id}`}
                label={b.label}
                onSelect={() => navigate(bookmarkPath(b))}
                renderIcon={collectionIcon(b.kind === "dashboard" ? dashboardIcon(dashboards.find((d) => d.id === b.dashboardId) ?? { icon: null }) : (collections.find((t) => t.id === b.collectionId)?.icon ?? null))}
              />
            ))}
          </TreeNode>
        <TreeNode autoAlign
          id="dashboards"
          label="Dashboards"
          onSelect={() => navigate("/dashboards")}
          renderIcon={DashboardIcon}
          isExpanded={isOpen("dashboards")}
          onToggle={onToggle("dashboards")}
        >
          {spaceDashboards.map((d) => (
            <TreeNode autoAlign key={d.id} id={`dashboard-${d.id}`} label={d.name} onSelect={() => navigate(`/dashboards/${d.id}`)} renderIcon={collectionIcon(dashboardIcon(d))} />
          ))}
        </TreeNode>

        <TreeNode autoAlign
          id="collections"
          label="Collections"
          onSelect={() => navigate("/collections")}
          renderIcon={Cube}
          isExpanded={isOpen("collections")}
          onToggle={onToggle("collections")}
        >
          {spaceCollections.filter((t) => !isRemote(t)).map(collectionNode)}
        </TreeNode>
        {remotesShown && (
          <TreeNode autoAlign
            id="remotes"
            label="Remotes"
            onSelect={() => navigate("/remotes")}
            renderIcon={DataBase}
            isExpanded={isOpen("remotes")}
            onToggle={onToggle("remotes")}
          >
            {spaceCollections.filter(isRemote).map(collectionNode)}
          </TreeNode>
        )}
        <TreeNode autoAlign id="components" label="Components" onSelect={() => navigate("/components")} renderIcon={ComponentIcon} />
      </TreeView>
    </div>
  );
}

/**
 * Help and Settings at the bottom of the side nav, always in view (the tree above scrolls). The
 * selected node follows the active tab's page; middle click opens a node's page in a new tab.
 */
export function NavFooter({ activePath, navigate, openTab }: { activePath: string; navigate(path: string): void; openTab(path: string): void }) {
  const [pathname] = activePath.split("?");
  const selected = pathname === "/help" ? "help" : pathname === "/settings" ? "settings" : undefined;
  const paths: Record<string, string> = { help: "/help", settings: "/settings" };
  const nodePath = (e: MouseEvent) => paths[(e.target as HTMLElement).closest("li[id]")?.id ?? ""];
  return (
    <div
      className="side-nav-footer"
      onMouseDown={(e) => e.button === 1 && nodePath(e) && e.preventDefault()}
      onAuxClick={(e) => {
        const path = e.button === 1 && nodePath(e);
        if (!path) return;
        e.preventDefault();
        openTab(path);
      }}
    >
      {/* Remounted when nothing is selected, like the tree above (Carbon keeps the last node lit). */}
      <TreeView key={selected ? "tree" : "tree-none"} label="Help and settings" hideLabel size="xs" selected={selected ? [selected] : []} active={selected} className="nav-tree">
        <TreeNode autoAlign id="help" label="Help" onSelect={() => navigate("/help")} renderIcon={HelpIcon} />
        <TreeNode autoAlign id="settings" label="Settings" onSelect={() => navigate("/settings")} renderIcon={SettingsIcon} />
      </TreeView>
    </div>
  );
}
