// What a link to a page of the app can point at, as options to pick from (the Markdown editor's
// link picker, the search page's link hits): collections, views, items and an item's fields.
// Choosing one gives the stored form of the link (by id, `#/collections/<id>/items…`, the same as
// domain/links.ts writes), so a rename breaks nothing. Matching works on the name, or on a link's
// address (`#/collections/<id>/items?view=<id>`, typed or pasted), and `item#field` lists the fields
// of the items named (the item page is what a field link opens).

import type { Collection, ItemLabel } from "./model";
import { isRemote } from "./sources";
import type { CollectionView } from "./views";

export type LinkTargetKind = "collection" | "view" | "item" | "field";

export interface LinkTarget {
  /** Unique, and the same for the same page whichever way it was found (to leave out repeats). */
  key: string;
  kind: LinkTargetKind;
  /** What it is called: a collection's plural name, a view's, an item's label, a field's. */
  name: string;
  /** Where it is: "Books" for a view, "Book" for an item, "Book › Dune" for a field. */
  context: string;
  /** The stored link. */
  href: string;
  collectionId: string;
  /** For an item and a field: the item. */
  itemId?: string;
}

const KIND_ORDER: Record<LinkTargetKind, number> = { collection: 0, view: 1, item: 2, field: 3 };
const LIST = (c: Pick<Collection, "id">) => `#/collections/${c.id}/items`;

export const collectionTarget = (c: Collection): LinkTarget => ({
  key: `collection:${c.id}`,
  kind: "collection",
  name: c.pluralName,
  context: "Collection",
  href: LIST(c),
  collectionId: c.id,
});

export const viewTarget = (c: Collection, v: CollectionView): LinkTarget => ({
  key: `view:${v.id}`,
  kind: "view",
  name: v.name,
  context: c.pluralName,
  href: `${LIST(c)}?view=${encodeURIComponent(v.id)}`,
  collectionId: c.id,
});

export const itemTarget = (c: Collection, l: ItemLabel): LinkTarget => ({
  key: `item:${l.id}`,
  kind: "item",
  name: l.label ?? "",
  context: c.name,
  href: `${LIST(c)}/${l.id}`,
  collectionId: c.id,
  itemId: l.id,
});

export const fieldTargets = (c: Collection, item: ItemLabel): LinkTarget[] =>
  c.fields.map((f) => ({
    key: `field:${item.id}:${f.id}`,
    kind: "field",
    name: f.name,
    context: `${c.name} › ${item.label ?? ""}`,
    href: `${LIST(c)}/${item.id}?field=${encodeURIComponent(f.id)}`,
    collectionId: c.id,
    itemId: item.id,
  }));

/** A stored link taken apart: which collection, item, view and field it names. */
export interface StoredLink {
  collectionId: string;
  itemId?: string;
  viewId?: string;
  fieldId?: string;
}

/**
 * The parts of a link to a page of the app as typed or pasted: `#/collections/<id>/items…`, with or
 * without the address before its `#`, and also `…/collections/<id>/views/<id>`; null for anything else.
 */
export function parseStoredLink(text: string): StoredLink | null {
  const t = text.trim();
  const hash = t.indexOf("#/");
  const route = hash >= 0 ? t.slice(hash + 1) : t.startsWith("/collections/") ? t : null;
  if (!route) return null;
  const m = /^\/collections\/([^/?#]+)(?:\/(items|views)(?:\/([^/?#]+))?)?(?:\?([^#]*))?(?:#.*)?$/.exec(route);
  if (!m) return null;
  const [, collectionId, segment, id, search] = m;
  const params = new URLSearchParams(search ?? "");
  if (segment === "views") return id ? { collectionId, viewId: id } : { collectionId };
  const link: StoredLink = { collectionId };
  if (id && id !== "new") link.itemId = id;
  const view = params.get("view");
  const field = params.get("field");
  if (view && !link.itemId) link.viewId = view;
  if (field && link.itemId) link.fieldId = field;
  return link;
}

/** What the options are made from. Items are loaded only when a search needs them. */
export interface LinkTargetData {
  /** The shown space's collections. */
  collections: Collection[];
  /** The shown space's collection views. */
  views: CollectionView[];
  /** The labels of a collection's items (every space; `spaceId` tells), or just these. */
  labels(collection: Collection, ids?: string[]): Promise<ItemLabel[]>;
  spaceId: string;
}

/** The option for a pasted or typed link, built from the names it points at; null when it points at nothing there. */
export async function storedLinkTarget(link: StoredLink, data: LinkTargetData): Promise<LinkTarget | null> {
  const c = data.collections.find((x) => x.id === link.collectionId);
  if (!c) return null;
  if (link.itemId) {
    const label = isRemote(c) ? undefined : (await data.labels(c, [link.itemId]))[0];
    if (!label) return null;
    if (!link.fieldId) return itemTarget(c, label);
    return fieldTargets(c, label).find((t) => t.href.endsWith(`field=${encodeURIComponent(link.fieldId!)}`)) ?? null;
  }
  if (link.viewId) {
    const v = data.views.find((x) => x.id === link.viewId && x.collectionId === c.id);
    return v ? viewTarget(c, v) : null;
  }
  return collectionTarget(c);
}

/** Whether a search text is (part of) a link's address, rather than words: it has a `/`, `?` or `=`, or a `#` after its first character. */
export const isAddressQuery = (text: string): boolean => /[/?=]/.test(text.trim()) || text.trim().indexOf("#") > 0;

const lower = (s: string) => s.toLowerCase();

/** How well a target fits the typed text: lower is better, null = not at all. */
export function matchScore(target: LinkTarget, query: string, nameOnly = false): number | null {
  const q = lower(query.trim());
  if (!q) return 5;
  const name = lower(target.name);
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.split(/[\s\-_/.,:;()]+/).some((w) => w.startsWith(q))) return 2;
  if (name.includes(q)) return 3;
  if (nameOnly) return null;
  if (lower(target.context).includes(q)) return 4;
  // A link's address, or a part of one: only when it is typed as one (a short word would match ids).
  if (/[/?=#]/.test(q) && lower(target.href).includes(q)) return 5;
  return null;
}

/** The targets that fit `query`, best first (then collections, views, items, fields; then by name), at most `limit`. */
export function rankTargets(targets: LinkTarget[], query: string, limit = 50, nameOnly = false): LinkTarget[] {
  const scored: { t: LinkTarget; score: number }[] = [];
  for (const t of targets) {
    const score = matchScore(t, query, nameOnly);
    if (score !== null) scored.push({ t, score });
  }
  scored.sort(
    (a, b) =>
      a.score - b.score || KIND_ORDER[a.t.kind] - KIND_ORDER[b.t.kind] || a.t.name.localeCompare(b.t.name, undefined, { sensitivity: "base" }),
  );
  return scored.slice(0, limit).map((s) => s.t);
}

/** The targets without the ones already shown (`shown`: their keys), and without repeats. */
export function withoutShown(targets: LinkTarget[], shown: Iterable<string>): LinkTarget[] {
  const seen = new Set(shown);
  return targets.filter((t) => {
    if (seen.has(t.key)) return false;
    seen.add(t.key);
    return true;
  });
}

/**
 * The options for what was typed:
 *  - a link's address (`#/collections/<id>/items/<id>?field=<id>`): the page it names, if it is there;
 *  - `book#au`: the fields matching `au` of the items matching `book` (an empty part after `#` lists them all);
 *  - otherwise the collections, views and (`items`) items whose name, or address, fits.
 */
export async function searchLinkTargets(query: string, data: LinkTargetData, opts: { items: boolean; limit?: number }): Promise<LinkTarget[]> {
  const limit = opts.limit ?? 50;
  const stored = parseStoredLink(query);
  if (stored) {
    const target = await storedLinkTarget(stored, data);
    return target ? [target] : [];
  }
  const nativeItems = async () => {
    const lists = await Promise.all(
      data.collections
        .filter((c) => !isRemote(c))
        .map(async (c) => (await data.labels(c)).filter((l) => l.spaceId === data.spaceId && l.label).map((l) => itemTarget(c, l))),
    );
    return lists.flat();
  };
  const hash = query.startsWith("#") ? -1 : query.indexOf("#");
  if (hash >= 0) {
    const items = rankTargets(await nativeItems(), query.slice(0, hash), 3, true);
    const fields = items.flatMap((i) => {
      const c = data.collections.find((x) => x.id === i.collectionId)!;
      return fieldTargets(c, { id: i.itemId!, label: i.name, spaceId: data.spaceId });
    });
    return rankTargets(fields, query.slice(hash + 1), limit, true);
  }
  const targets = [
    ...data.collections.map(collectionTarget),
    ...data.views.flatMap((v) => {
      const c = data.collections.find((x) => x.id === v.collectionId);
      return c ? [viewTarget(c, v)] : [];
    }),
    ...(opts.items ? await nativeItems() : []),
  ];
  return rankTargets(targets, query, limit);
}
