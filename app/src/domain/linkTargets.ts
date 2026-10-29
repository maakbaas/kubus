// What a link to a page of the app can point at, as options to pick from (the Markdown editor's
// link picker, the search page's link hits): collections, views, items, item views, an item's fields
// and the blocks of a page. Choosing one gives the stored form of the link (by id,
// `#/collections/<id>/items…`, the same as domain/links.ts writes), so a rename breaks nothing.
// Matching works on the name, on a link's address (`#/collections/<id>/items?view=<id>`, typed or
// pasted), on a link written by name part by part (`books/reading-list#table`, `book/dune/compact#author`),
// and `item#field` lists the fields of the items named (the item page is what a field link opens).

import type { ItemView } from "./fieldLayout";
import { blockName, describeLink, slug, slugs, type LinkData } from "./links";
import type { Collection, ItemLabel } from "./model";
import { isRemote } from "./sources";
import type { CollectionView } from "./views";

export type LinkTargetKind = "collection" | "view" | "item" | "field" | "block";

export interface LinkTarget {
  /** Unique, and the same for the same page whichever way it was found (to leave out repeats). */
  key: string;
  kind: LinkTargetKind;
  /** What it is called: a collection's plural name, a view's, an item's label, a field's, a block's. */
  name: string;
  /** Where it is: "Books" for a view, "Book" for an item, "Book › Dune" for a field or an item view, "Books › Reading list" for a block. */
  context: string;
  /** The stored link. */
  href: string;
  /** The link by name (`book/dune#author`, domain/links.ts), shown with the option; set by searchLinkTargets. */
  link?: string;
  collectionId: string;
  /** For an item and a field: the item. */
  itemId?: string;
}

const KIND_ORDER: Record<LinkTargetKind, number> = { collection: 0, view: 1, item: 2, field: 3, block: 4 };
const LIST = (c: Pick<Collection, "id">) => `#/collections/${c.id}/items`;
/** A link's query, of the parameters set, in this order (as domain/links.ts writes them). */
const search = (params: Record<string, string | undefined>) => {
  const set = Object.entries(params).filter((e): e is [string, string] => !!e[1]);
  return set.length ? "?" + set.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&") : "";
};
/** The default of a list of views: the starred one, else the first. */
const defaultOf = <T extends { isDefault: boolean }>(views: T[]): T | undefined => views.find((v) => v.isDefault) ?? views[0];
const fieldKey = (itemId: string, fieldId: string, itemViewId?: string) => `field:${itemId}:${fieldId}${itemViewId ? `:${itemViewId}` : ""}`;

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

/** An item's page under one of its item views. */
export const itemViewTarget = (c: Collection, item: ItemLabel, v: ItemView): LinkTarget => ({
  key: `itemview:${item.id}:${v.id}`,
  kind: "view",
  name: v.name,
  context: `${c.name} › ${item.label ?? ""}`,
  href: `${LIST(c)}/${item.id}${search({ view: v.id })}`,
  collectionId: c.id,
  itemId: item.id,
});

/** The fields of an item's page (`itemView`: under that item view, named in the link). */
export const fieldTargets = (c: Collection, item: ItemLabel, itemView?: ItemView): LinkTarget[] =>
  c.fields.map((f) => ({
    key: fieldKey(item.id, f.id, itemView?.id),
    kind: "field",
    name: f.name,
    context: `${c.name} › ${item.label ?? ""}`,
    href: `${LIST(c)}/${item.id}${search({ view: itemView?.id, field: f.id })}`,
    collectionId: c.id,
    itemId: item.id,
  }));

/** The blocks of a collection view (`named`: the view is named in the link, else it is the collection's default one). */
export const viewBlockTargets = (c: Collection, v: CollectionView, named: boolean): LinkTarget[] =>
  v.blocks.map((b) => ({
    key: `block:${v.id}:${b.id}`,
    kind: "block",
    name: blockName(b),
    context: `${c.pluralName} › ${v.name}`,
    href: `${LIST(c)}${search({ view: named ? v.id : undefined, block: b.id })}`,
    collectionId: c.id,
  }));

/** The blocks of an item's page under an item view (`named`: the item view is named in the link, else it is the default one). */
export const itemBlockTargets = (c: Collection, item: ItemLabel, v: ItemView, named: boolean): LinkTarget[] =>
  v.layout.blocks.map((b) => ({
    key: `block:${item.id}:${v.id}:${b.id}`,
    kind: "block",
    name: blockName(b),
    context: `${c.name} › ${item.label ?? ""}`,
    href: `${LIST(c)}/${item.id}${search({ view: named ? v.id : undefined, block: b.id })}`,
    collectionId: c.id,
    itemId: item.id,
  }));

/** A stored link taken apart: which collection, item, view (with an item: item view), field and block it names. */
export interface StoredLink {
  collectionId: string;
  itemId?: string;
  viewId?: string;
  fieldId?: string;
  blockId?: string;
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
  const block = params.get("block");
  if (view) link.viewId = view;
  if (field && link.itemId) link.fieldId = field;
  else if (block) link.blockId = block;
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
    const itemView = link.viewId ? c.itemViews.find((v) => v.id === link.viewId) : undefined;
    if (link.viewId && !itemView) return null;
    if (link.fieldId) return fieldTargets(c, label, itemView).find((t) => t.key === fieldKey(label.id, link.fieldId!, itemView?.id)) ?? null;
    if (link.blockId) {
      const shown = itemView ?? defaultOf(c.itemViews);
      return (shown && itemBlockTargets(c, label, shown, !!itemView).find((t) => t.key === `block:${label.id}:${shown.id}:${link.blockId}`)) || null;
    }
    return itemView ? itemViewTarget(c, label, itemView) : itemTarget(c, label);
  }
  const views = data.views.filter((x) => x.collectionId === c.id);
  const v = link.viewId ? views.find((x) => x.id === link.viewId) : undefined;
  if (link.viewId && !v) return null;
  if (link.blockId) {
    const shown = v ?? defaultOf(views);
    return (shown && viewBlockTargets(c, shown, !!v).find((t) => t.key === `block:${shown.id}:${link.blockId}`)) || null;
  }
  return v ? viewTarget(c, v) : collectionTarget(c);
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

/** Options with the slugs they go by in a link (a repeated name's slug ends in `-1`, as domain/links.ts counts). */
const withSlugs = (targets: LinkTarget[], names: string[]) => {
  const s = slugs(names);
  return targets.map((t, i) => ({ t, slug: s[i] }));
};

/** The options whose slug fits the part being typed (its slug), best first (exact, prefix, word start, inside; then kind, then as listed). */
function rankBySlug(options: { t: LinkTarget; slug: string }[], typed: string, limit: number): LinkTarget[] {
  const score = (s: string) =>
    !typed ? 0 : s === typed ? 0 : s.startsWith(typed) ? 1 : s.split("-").some((w) => w.startsWith(typed)) ? 2 : s.includes(typed) ? 3 : null;
  const scored: { t: LinkTarget; score: number }[] = [];
  for (const o of options) {
    const sc = score(o.slug);
    if (sc !== null) scored.push({ t: o.t, score: sc });
  }
  scored.sort((a, b) => a.score - b.score || KIND_ORDER[a.t.kind] - KIND_ORDER[b.t.kind]);
  return scored.slice(0, limit).map((s) => s.t);
}

/**
 * The options for a link written by name (domain/links.ts), part by part as it is typed (a leading `#/` skipped):
 * `books/` lists the views of Books (by the plural name) and the items (by the singular name; `views/` or
 * `items/` after it only those), `book/dune/` the item views of Dune, and after a `#` the blocks of the
 * collection's default view or the view named, or the fields and blocks of the item's page. The parts
 * before the last are matched exactly (as slugs), the last as typed. Null when it is a single word
 * (no `/` or `#`) or its first part names no collection (or two).
 */
async function nameLinkTargets(query: string, data: LinkTargetData, limit: number): Promise<LinkTarget[] | null> {
  const text = query.trim().replace(/^#?\//, "");
  const hash = text.indexOf("#");
  const decode = (s: string) => {
    try {
      return slug(decodeURIComponent(s));
    } catch {
      return slug(s);
    }
  };
  const parts = (hash < 0 ? text : text.slice(0, hash)).split("/").map(decode);
  const fragment = hash < 0 ? null : decode(text.slice(hash + 1));
  if (parts.length < 2 && fragment === null) return null;
  const head = parts[0];
  const plural = data.collections.filter((c) => slug(c.pluralName) === head);
  const singular = data.collections.filter((c) => slug(c.name) === head);
  const all = [...new Set([...plural, ...singular])];
  if (all.length !== 1) return null;
  const c = all[0];
  let rest = parts.slice(1);
  let kind: "view" | "item" | null = null;
  if ((rest.length > 1 || fragment !== null) && (rest[0] === "views" || rest[0] === "items")) {
    kind = rest[0] === "views" ? "view" : "item";
    rest = rest.slice(1);
  }
  const viewsOk = kind !== "item" && plural.length > 0;
  const itemsOk = kind !== "view" && (singular.length > 0 || kind === "item") && !isRemote(c);
  const views = data.views.filter((v) => v.collectionId === c.id);
  const viewSlugs = slugs(views.map((v) => v.name));
  // Every space's items count for the slugs (as domain/links.ts counts); only the shown space's are offered.
  const labels = itemsOk && rest.length > 0 ? await data.labels(c) : [];
  const itemSlugs = slugs(labels.map((l) => l.label ?? ""));
  const offered = (l: ItemLabel) => l.spaceId === data.spaceId && !!l.label;
  const itemAt = (s: string) => {
    const at = itemSlugs.indexOf(s);
    return at >= 0 && offered(labels[at]) ? labels[at] : undefined;
  };
  const itemPage = (item: ItemLabel, itemView: ItemView | undefined, named: boolean) => {
    const fields = withSlugs(fieldTargets(c, item, named ? itemView : undefined), c.fields.map((f) => f.name));
    const blocks = itemView ? withSlugs(itemBlockTargets(c, item, itemView, named), itemView.layout.blocks.map(blockName)) : [];
    return [...fields, ...blocks];
  };

  if (fragment === null) {
    const typed = rest[rest.length - 1];
    if (rest.length === 1) {
      const options = [
        ...(viewsOk ? withSlugs(views.map((v) => viewTarget(c, v)), views.map((v) => v.name)) : []),
        ...(itemsOk ? labels.map((l, i) => ({ t: itemTarget(c, l), slug: itemSlugs[i] })).filter((_, i) => offered(labels[i])) : []),
      ];
      return rankBySlug(options, typed, limit);
    }
    const item = rest.length === 2 && itemsOk ? itemAt(rest[0]) : undefined;
    if (!item) return [];
    return rankBySlug(withSlugs(c.itemViews.map((v) => itemViewTarget(c, item, v)), c.itemViews.map((v) => v.name)), typed, limit);
  }
  if (rest.length === 0) {
    const v = defaultOf(views);
    return v ? rankBySlug(withSlugs(viewBlockTargets(c, v, false), v.blocks.map(blockName)), fragment, limit) : [];
  }
  if (rest.length === 1 && viewsOk) {
    const v = views[viewSlugs.indexOf(rest[0])];
    if (v) return rankBySlug(withSlugs(viewBlockTargets(c, v, true), v.blocks.map(blockName)), fragment, limit);
  }
  const item = rest.length <= 2 && itemsOk ? itemAt(rest[0]) : undefined;
  if (!item) return [];
  if (rest.length === 1) return rankBySlug(itemPage(item, defaultOf(c.itemViews), false), fragment, limit);
  const itemView = c.itemViews[slugs(c.itemViews.map((v) => v.name)).indexOf(rest[1])];
  return itemView ? rankBySlug(itemPage(item, itemView, true), fragment, limit) : [];
}

/**
 * The options for what was typed:
 *  - a link's address (`#/collections/<id>/items/<id>?field=<id>`): the page it names, if it is there;
 *  - a link by name (`books/reading-list#table`, `book/dune/compact#author`): the pages its last part
 *    being typed fits, under what the parts before it name (nameLinkTargets);
 *  - `book#au`: the fields matching `au` of the items matching `book` (an empty part after `#` lists them all),
 *    after the blocks matching `au` of a collection's default view when `book` names one;
 *  - otherwise the collections, views and (`items`) items whose name, or address, fits.
 */
export async function searchLinkTargets(query: string, data: LinkTargetData, opts: { items: boolean; limit?: number }): Promise<LinkTarget[]> {
  return withNameLinks(await findLinkTargets(query, data, opts), data);
}

/** The options with their links by name (what typing it out would be), as the editor shows a stored link. */
async function withNameLinks(targets: LinkTarget[], data: LinkTargetData): Promise<LinkTarget[]> {
  const linkData: LinkData = {
    collections: data.collections,
    views: async (c) => data.views.filter((v) => v.collectionId === c.id),
    items: (c) => (isRemote(c) ? Promise.resolve([]) : data.labels(c)),
  };
  return Promise.all(targets.map(async (t) => ({ ...t, link: (await describeLink(t.href, linkData).catch(() => null)) ?? undefined })));
}

async function findLinkTargets(query: string, data: LinkTargetData, opts: { items: boolean; limit?: number }): Promise<LinkTarget[]> {
  const limit = opts.limit ?? 50;
  const stored = parseStoredLink(query);
  if (stored) {
    const target = await storedLinkTarget(stored, data);
    return target ? [target] : [];
  }
  const named = await nameLinkTargets(query, data, limit);
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
    return withoutShown([...(named ?? []), ...rankTargets(fields, query.slice(hash + 1), limit, true)], []).slice(0, limit);
  }
  if (named) return named;
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
