import { useState, type ElementType, type MouseEvent } from "react";
import { TreeNode, TreeView } from "@carbon/react";
import { Bookmark as BookmarkIcon, Cube, Code as ComponentIcon } from "@carbon/icons-react";
import { bookmarkPath } from "../domain/bookmarks";
import { readPref, writePref } from "../ui/localPrefs";
import { CollectionIcon } from "../ui/collectionIcons";
import { useStore } from "./store";

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
 * The side nav as a Carbon tree: Bookmarks (the space's bookmarked views and items), Collections
 * (its page, with the space's collections below it), and Components. Choosing a node opens its page in the active tab
 * (through `navigate`: Carbon's tree stops clicks, so plain links wouldn't reach the workspace).
 * The selected node follows the active tab's page (a bookmark of it wins). Middle click opens a
 * node's page in a new tab.
 */
export function NavTree({ activePath, navigate, openTab }: { activePath: string; navigate(path: string): void; openTab(path: string): void }) {
  const { collections, spaceCollections, bookmarks } = useStore();
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
  const selected = bookmark
    ? `bookmark-${bookmark.id}`
    : collection
      ? `collection-${collection.id}`
      : pathname === "/collections"
        ? "collections"
        : pathname === "/bookmarks"
          ? "bookmarks"
          : pathname.startsWith("/components")
            ? "components"
            : undefined;

  // Every node's page, by node id (Carbon renders the id on the node's <li>), for middle clicks.
  const paths: Record<string, string> = {
    bookmarks: "/bookmarks",
    collections: "/collections",
    components: "/components",
    ...Object.fromEntries(bookmarks.map((b) => [`bookmark-${b.id}`, bookmarkPath(b)])),
    ...Object.fromEntries(collections.map((t) => [`collection-${t.id}`, `/collections/${t.id}/items`])),
  };
  const nodePath = (e: MouseEvent) => paths[(e.target as HTMLElement).closest("li[id]")?.id ?? ""];

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
      <TreeView label="Navigation" hideLabel size="xs" selected={selected ? [selected] : []} active={selected} className="nav-tree">
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
                renderIcon={collectionIcon(collections.find((t) => t.id === b.collectionId)?.icon ?? null)}
              />
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
          {spaceCollections.map((t) => (
            <TreeNode autoAlign key={t.id} id={`collection-${t.id}`} label={t.pluralName} onSelect={() => navigate(`/collections/${t.id}/items`)} renderIcon={collectionIcon(t.icon)} />
          ))}
        </TreeNode>
        <TreeNode autoAlign id="components" label="Components" onSelect={() => navigate("/components")} renderIcon={ComponentIcon} />
      </TreeView>
    </div>
  );
}
