import { useRef, useState, type CSSProperties, type ElementType, type ReactNode } from "react";
import { InlineNotification, Link, Tile } from "@carbon/react";
import { Bookmark as BookmarkIcon, Code as ComponentIcon, Cube, Dashboard as DashboardIcon, DataBase, Grid as GridIcon, SettingsAdjust } from "@carbon/icons-react";
import { useStore } from "../app/store";
import { useHomeLayout } from "../app/homeLayout";
import { HOME_BLOCKS, shownHomeBlocks, withHomeCollapsed, type HomeBlockId } from "../domain/home";
import { FieldOrderEditor } from "../ui/FieldOrderEditor";
import { ToolbarPopover } from "../ui/ToolbarPopover";
import { useRemotesShown } from "../app/useRemotes";
import { isRemote } from "../domain/sources";
import { PageHeader } from "../ui/PageHeader";
import { SectionHeader } from "../ui/SectionHeader";
import { errorMessage } from "../ui/useConfirm";
import { useCardColumns } from "../views/CardsView";
import { BookmarksTable } from "./BookmarksPage";

/** A card's target width in rem (a cards block's default). */
const CARD_WIDTH = 16;

interface Section {
  path: string;
  label: string;
  icon: ElementType;
  /** What it holds, in the space: "3 collections". */
  count: string;
}

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A Home block's name with its icon, as its header and the Page layout list show it. */
const BLOCK_LABELS: Record<HomeBlockId, { icon: ElementType; text: string }> = {
  pages: { icon: GridIcon, text: "Pages" },
  bookmarks: { icon: BookmarkIcon, text: "Bookmarks" },
};
const blockLabel = (id: HomeBlockId) => {
  const { icon: Icon, text } = BLOCK_LABELS[id];
  return (
    <span className="icon-label">
      <Icon size={16} aria-hidden="true" />
      <span className="icon-label__text">{text}</span>
    </span>
  );
};

/**
 * The start page: the side nav's top-level sections as cards (as a cards block shows them), each opening its page,
 * and the space's bookmarks below them. Its blocks are shown, ordered and collapsed as an item page's are (Page layout:
 * the item page's list of fields and blocks; the collapse caret of a block's header), stored as a synced setting
 * (domain/home.ts).
 */
export function HomePage() {
  const { spaceCollections, spaceDashboards, components, bookmarks } = useStore();
  const remotesShown = useRemotesShown();
  const [error, setError] = useState<string>();
  const [layout, setLayout] = useHomeLayout((e) => setError(errorMessage(e)));
  const remotes = spaceCollections.filter(isRemote).length;
  // The side nav's order (app/NavTree.tsx).
  const sections: Section[] = [
    { path: "/bookmarks", label: "Bookmarks", icon: BookmarkIcon, count: counted(bookmarks.length, "bookmark", "bookmarks") },
    { path: "/collections", label: "Collections", icon: Cube, count: counted(spaceCollections.length - remotes, "collection", "collections") },
    ...(remotesShown ? [{ path: "/remotes", label: "Remotes", icon: DataBase, count: counted(remotes, "remote collection", "remote collections") }] : []),
    { path: "/dashboards", label: "Dashboards", icon: DashboardIcon, count: counted(spaceDashboards.length, "dashboard", "dashboards") },
    { path: "/components", label: "Components", icon: ComponentIcon, count: counted(components.length, "component", "components") },
  ];
  const grid = useRef<HTMLDivElement>(null);
  // Measured again whenever the cards come back (the block shown again, or expanded).
  const cardsShown = shownHomeBlocks(layout).includes("pages") && !layout.collapsed.includes("pages");
  const columns = useCardColumns(grid, CARD_WIDTH, cardsShown);

  const contents: Record<HomeBlockId, ReactNode> = {
    pages: (
      <div ref={grid} className="item-cards" style={{ "--card-columns": columns } as CSSProperties}>
        {sections.map((s) => (
          <Tile key={s.path} className="item-card home-card">
            <Link className="item-card__link" href={`#${s.path}`} aria-label={s.label} />
            <div className="item-card__body">
              <div className="item-card__title icon-label">
                <s.icon size={20} aria-hidden="true" />
                <span className="icon-label__text">{s.label}</span>
              </div>
              <p className="helper home-card__count">{s.count}</p>
            </div>
          </Tile>
        ))}
      </div>
    ),
    bookmarks: <BookmarksTable onError={(e) => setError(errorMessage(e))} />,
  };

  return (
    <>
      <PageHeader
        title="Home"
        actions={
          <ToolbarPopover label="Page layout" icon={SettingsAdjust} fit>
            <FieldOrderEditor
              id="home-blocks"
              label="Blocks"
              fields={[]}
              extra={HOME_BLOCKS.map((id) => ({ id, label: blockLabel(id) }))}
              value={layout.shown}
              onChange={(shown) => setLayout({ ...layout, shown: shown as HomeBlockId[] | null })}
            />
          </ToolbarPopover>
        }
      />
      {error && <InlineNotification kind="error" title="Error" subtitle={error} onClose={() => setError(undefined)} />}
      {shownHomeBlocks(layout).map((id) => {
        const collapsed = layout.collapsed.includes(id);
        return (
          <section key={id} className="block" data-block-id={id}>
            <SectionHeader heading label={blockLabel(id)} collapsed={collapsed} onToggle={() => setLayout(withHomeCollapsed(layout, id, !collapsed))} />
            {!collapsed && contents[id]}
          </section>
        );
      })}
    </>
  );
}
