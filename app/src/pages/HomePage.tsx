import { useRef, useState, type CSSProperties, type ElementType } from "react";
import { InlineNotification, Link, Tile } from "@carbon/react";
import { Bookmark as BookmarkIcon, Code as ComponentIcon, Cube, Dashboard as DashboardIcon, DataBase, Grid as GridIcon } from "@carbon/icons-react";
import { useStore } from "../app/store";
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

/**
 * The start page: the side nav's top-level sections as cards (as a cards block shows them), each opening its page,
 * and the space's bookmarks below them.
 */
export function HomePage() {
  const { spaceCollections, spaceDashboards, components, bookmarks } = useStore();
  const remotesShown = useRemotesShown();
  const [error, setError] = useState<string>();
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
  const columns = useCardColumns(grid, CARD_WIDTH, true);

  return (
    <>
      <PageHeader title="Home" />
      {error && <InlineNotification kind="error" title="Error" subtitle={error} onClose={() => setError(undefined)} />}
      <section className="block">
        <SectionHeader
          heading
          label={
            <span className="icon-label">
              <GridIcon size={16} aria-hidden="true" />
              <span className="icon-label__text">Pages</span>
            </span>
          }
        />
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
      </section>
      <section className="block">
        <SectionHeader
          heading
          label={
            <span className="icon-label">
              <BookmarkIcon size={16} aria-hidden="true" />
              <span className="icon-label__text">Bookmarks</span>
            </span>
          }
        />
        <BookmarksTable onError={(e) => setError(errorMessage(e))} />
      </section>
    </>
  );
}
