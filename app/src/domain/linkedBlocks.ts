// Linked blocks: a block that shows another block (or one field of an item), wherever that one is (a collection view, an item page, a
// dashboard view), as it is set up there. It stores a link to it in the stored form of links (domain/links.ts),
// `#/collections/<id>/items?view=&block=`, `#/collections/<id>/items/<item>?view=&block=`, `#/dashboards/<id>?view=&block=`,
// written by name in its settings like any link (`books/reading-list#chart`, `book/dune#chart`, `dashboards/health#chart`).
// Nothing is copied: the original's changes show wherever it is linked.

import type { ViewBlock } from "./views";

/**
 * What a linked block shows: a block where it is (`viewId` null: the page's own choice, the default view, the item's item
 * view, the default dashboard view), or one field of an item (its value as the item's page shows it).
 */
export type BlockLink =
  | { place: "collection"; collectionId: string; viewId: string | null; blockId: string }
  | { place: "item"; collectionId: string; itemId: string; viewId: string | null; blockId: string }
  | { place: "dashboard"; dashboardId: string; viewId: string | null; blockId: string }
  | { place: "field"; collectionId: string; itemId: string; fieldId: string };

/** The block kind of a linked block. */
export const LINKED = "linked";

/** At most this many linked blocks inside one another (one linking to another that links …). */
export const MAX_LINK_DEPTH = 4;

const COLLECTION_ROUTE = /^#\/collections\/([^/?#]+)\/items(?:\/([^/?#]+))?(?:\?([^#]*))?$/;
const DASHBOARD_ROUTE = /^#\/dashboards\/([^/?#]+)(?:\?([^#]*))?$/;

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** The block or item's field a stored link names; null for any other link (a page, a URL, a link by name not yet resolved). */
export function parseBlockLink(href: string): BlockLink | null {
  const text = href.trim();
  const d = DASHBOARD_ROUTE.exec(text);
  if (d) {
    const params = new URLSearchParams(d[2] ?? "");
    const blockId = params.get("block");
    return blockId ? { place: "dashboard", dashboardId: decode(d[1]), viewId: params.get("view") || null, blockId } : null;
  }
  const m = COLLECTION_ROUTE.exec(text);
  if (!m) return null;
  const params = new URLSearchParams(m[3] ?? "");
  const blockId = params.get("block");
  const fieldId = params.get("field");
  const collectionId = decode(m[1]);
  // A field of an item (its item view doesn't matter: the value is the same).
  if (fieldId && m[2]) return { place: "field", collectionId, itemId: decode(m[2]), fieldId };
  if (!blockId || fieldId) return null;
  const viewId = params.get("view") || null;
  return m[2] ? { place: "item", collectionId, itemId: decode(m[2]), viewId, blockId } : { place: "collection", collectionId, viewId, blockId };
}

/** What a link points at, the same whichever way it is written: its page and block (a view id doesn't count: a block is in one). */
export const blockLinkKey = (link: BlockLink): string =>
  link.place === "collection"
    ? `c/${link.collectionId}/${link.blockId}`
    : link.place === "item"
      ? `i/${link.collectionId}/${link.itemId}/${link.blockId}`
      : link.place === "field"
        ? `f/${link.collectionId}/${link.itemId}/${link.fieldId}`
        : `d/${link.dashboardId}/${link.blockId}`;

/**
 * The block a link names among a page's views (a collection's views, its item views, a dashboard's views): in the view it
 * names, else in the view the page shows by default (`fallback`), else in any of them (a block moved to another view keeps
 * its id). null when it is gone.
 */
export function findLinkedBlock<V>(views: V[], blocksOf: (view: V) => ViewBlock[], named: V | undefined, fallback: V | undefined, blockId: string): { view: V; block: ViewBlock } | null {
  for (const view of [named, fallback, ...views]) {
    const block = view && blocksOf(view).find((b) => b.id === blockId);
    if (view && block) return { view, block };
  }
  return null;
}

/**
 * Why a linked block can't show what it links (null: it can). `chain` is the links it is shown inside, outermost first:
 * a block shown inside itself, or too deep, stops there.
 */
export function linkProblem(link: BlockLink | null, href: string, chain: string[]): string | null {
  if (!href.trim()) return "No block linked yet: choose one in its settings.";
  if (!link) return "The link doesn't name a block or an item's field.";
  if (chain.includes(blockLinkKey(link))) return "The block links to itself.";
  if (chain.length >= MAX_LINK_DEPTH) return "Too many linked blocks inside one another.";
  return null;
}
