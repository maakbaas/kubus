// Bookmarks: links in the side nav to any page of the app a link can name (domain/links.ts,
// domain/linkTargets.ts): a collection, a collection view, an item (under an item view), a field
// of an item's page (opened with the field flashed), a block, a dashboard, a dashboard view. Stored
// as the link itself, by id (`#/collections/<id>/items/<id>?view=<id>&field=<id>`, as a Markdown
// link stores it), so a rename breaks nothing; toggled with the bookmark icon on a view, a
// dashboard view or an item page, or added on the Bookmarks page. When what a link names is deleted,
// its bookmarks are deleted with it (SqliteRepository: `bookmarksOf`).

import type { LinkTarget } from "./linkTargets";

export interface Bookmark {
  id: string;
  /** The page, as a stored link: `#/collections/…` or `#/dashboards/…`. */
  link: string;
  /** Shown in the side nav; a snapshot, refreshed whenever the bookmarked page is shown. */
  label: string;
  position: number;
  createdAt: string;
}

/** Where a bookmark leads (an in-app path: the link without its `#`). */
export const bookmarkPath = (b: Pick<Bookmark, "link">): string => (b.link.startsWith("#") ? b.link.slice(1) : b.link);

/** The stored link of an in-app path (what a bookmark of the page shown stores). */
export const linkOfPath = (path: string): string => (path.startsWith("#") ? path : `#${path}`);

/** What a deleted thing is to the links naming it (SqliteRepository deletes their bookmarks with it). */
export type BookmarkOwner =
  | { collection: string }
  | { dashboard: string }
  | { item: string }
  /** A collection view, item view or dashboard view: links name all of them `view=<id>`. */
  | { view: string }
  | { field: string }
  | { block: string };

/**
 * SQL (a condition on `link`, its id bound as ?n) for the bookmarks of a deleted thing. Ids are UUIDs, so an id
 * after its marker can't be the start of another one; a collection's and a dashboard's start the link.
 */
export function bookmarkCondition(owner: BookmarkOwner, n: number): { sql: string; id: string } {
  if ("collection" in owner) return { sql: `instr(link, '#/collections/' || ?${n} || '/') = 1`, id: owner.collection };
  if ("dashboard" in owner) return { sql: `instr(link, '#/dashboards/' || ?${n}) = 1`, id: owner.dashboard };
  if ("item" in owner) return { sql: `instr(link, '/items/' || ?${n}) > 0`, id: owner.item };
  if ("view" in owner) return { sql: `instr(link, 'view=' || ?${n}) > 0`, id: owner.view };
  if ("field" in owner) return { sql: `instr(link, 'field=' || ?${n}) > 0`, id: owner.field };
  return { sql: `instr(link, 'block=' || ?${n}) > 0`, id: owner.block };
}

// The stored links of the pages that have a bookmark button, as domain/linkTargets.ts writes them (so the
// button and the New bookmark dialog store the same link for the same page).
const param = (id: string) => encodeURIComponent(id);
export const collectionViewLink = (collectionId: string, viewId: string) => `#/collections/${collectionId}/items?view=${param(viewId)}`;
/** An item's page; under an item view only when one is named (none: whichever it shows by default). */
export const itemLink = (collectionId: string, itemId: string, itemViewId?: string | null) =>
  `#/collections/${collectionId}/items/${itemId}${itemViewId ? `?view=${param(itemViewId)}` : ""}`;
export const dashboardViewLink = (dashboardId: string, viewId: string) => `#/dashboards/${dashboardId}?view=${param(viewId)}`;

/**
 * A bookmark's label for a page found by its link: a collection's, dashboard's or item's name; a view's with where it is
 * ("Books / Reading list", "Health / Daily", "Dune / Details"); a field's or block's with its page ("Dune / Author").
 */
export function bookmarkLabel(t: Pick<LinkTarget, "kind" | "name" | "context">): string {
  if (t.kind === "collection" || t.kind === "dashboard" || t.kind === "item") return t.name;
  const parts = t.context.split(" / ");
  if (t.kind === "view" || t.kind === "tab") return `${parts[parts.length - 1]} / ${t.name}`;
  return `${parts[parts.length - 1]} / ${t.name}`;
}

/** A link with one id of its `view=` replaced (a dashboard view copied from another space, stored in this one). */
export const withViewId = (link: string, from: string, to: string): string => link.replace(`view=${param(from)}`, `view=${param(to)}`);
