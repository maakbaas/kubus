import { useState, type ElementType, type MouseEvent } from "react";
import { TreeNode, TreeView } from "@carbon/react";
import { Bookmark as BookmarkIcon, Cube, Code as TemplateIcon } from "@carbon/icons-react";
import { bookmarkPath } from "../domain/bookmarks";
import { readPref, writePref } from "../ui/localPrefs";
import { TypeIcon } from "../ui/typeIcons";
import { useStore } from "./store";

const EXPANDED_KEY = "kubus.navExpanded";


// TreeNode renders its icon as a component; one stable component per type icon name.
const iconComponents = new Map<string, ElementType>();
function typeIcon(name: string | null): ElementType {
  const key = name ?? "";
  let Icon = iconComponents.get(key);
  if (!Icon) {
    // Carbon passes its icon class (spacing, colour); keep it, on a wrapper around the icon.
    Icon = function NavTypeIcon({ className }: { className?: string }) {
      return (
        <span className={`${className ?? ""} nav-tree__icon`}>
          <TypeIcon name={name} />
        </span>
      );
    };
    iconComponents.set(key, Icon);
  }
  return Icon;
}

/**
 * The side nav as a Carbon tree: Bookmarks (bookmarked views and objects), Types (its page,
 * with every type below it) and Templates. Choosing a node opens its page in the active tab
 * (through `navigate`: Carbon's tree stops clicks, so plain links wouldn't reach the workspace).
 * The selected node follows the active tab's page (a bookmark of it wins). Middle click opens a
 * node's page in a new tab.
 */
export function NavTree({ activePath, navigate, openTab }: { activePath: string; navigate(path: string): void; openTab(path: string): void }) {
  const { types, bookmarks } = useStore();
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
  const type = types.find((t) => pathname.startsWith(`/types/${t.id}/objects`));
  const selected = bookmark
    ? `bookmark-${bookmark.id}`
    : type
      ? `type-${type.id}`
      : pathname === "/types"
        ? "objects"
        : pathname === "/bookmarks"
          ? "bookmarks"
          : pathname.startsWith("/templates")
            ? "templates"
            : undefined;

  // Every node's page, by node id (Carbon renders the id on the node's <li>), for middle clicks.
  const paths: Record<string, string> = {
    bookmarks: "/bookmarks",
    objects: "/types",
    templates: "/templates",
    ...Object.fromEntries(bookmarks.map((b) => [`bookmark-${b.id}`, bookmarkPath(b)])),
    ...Object.fromEntries(types.map((t) => [`type-${t.id}`, `/types/${t.id}/objects`])),
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
                renderIcon={typeIcon(types.find((t) => t.id === b.typeId)?.icon ?? null)}
              />
            ))}
          </TreeNode>
        <TreeNode autoAlign
          id="objects"
          label="Types"
          onSelect={() => navigate("/types")}
          renderIcon={Cube}
          isExpanded={isOpen("objects")}
          onToggle={onToggle("objects")}
        >
          {types.map((t) => (
            <TreeNode autoAlign key={t.id} id={`type-${t.id}`} label={t.pluralName} onSelect={() => navigate(`/types/${t.id}/objects`)} renderIcon={typeIcon(t.icon)} />
          ))}
        </TreeNode>
        <TreeNode autoAlign id="templates" label="Templates" onSelect={() => navigate("/templates")} renderIcon={TemplateIcon} />
      </TreeView>
    </div>
  );
}
