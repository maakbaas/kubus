// What a link to a page of the app can point at, as options to pick from (the Markdown editor's
// link picker, the search page's link hits): collections, views, items, item views, an item's fields,
// dashboards and their tabs, and the blocks of a page. Choosing one gives the stored form of the link (by id,
// `#/collections/<id>/items…`, `#/dashboards/<id>…`, the same as domain/links.ts writes), so a rename breaks nothing.
// Matching works on the name, on a link's address (`#/collections/<id>/items?view=<id>`, typed or
// pasted), on a link written by name part by part (`books/reading-list#table`, `book/dune/compact#author`),
// and `item#field` lists the fields of the items named (the item page is what a field link opens).

import { listsField, type ItemView } from "./fieldLayout";
import { blockName, DASHBOARDS, describeLink, resolveNameLink, slug, slugs, type LinkData } from "./links";
import { titleFields, type Collection, type ItemLabel } from "./model";
import { isRemote } from "./sources";
import type { CollectionView } from "./views";
import { findTab, tabLinkId, type Dashboard, type DashboardView } from "./dashboards";

export type LinkTargetKind = "collection" | "view" | "item" | "field" | "dashboard" | "tab" | "block";

export interface LinkTarget {
  /** Unique, and the same for the same page whichever way it was found (to leave out repeats). */
  key: string;
  kind: LinkTargetKind;
  /** What it is called: a collection's plural name, a view's, an item's label, a field's, a dashboard's, a tab's, a block's. */
  name: string;
  /** Where it is: "Books" for a view, "Book" for an item, "Book / Dune" for a field or an item view, "Books / Reading list" for a block, "Health" for a tab. */
  context: string;
  /** The stored link. */
  href: string;
  /** The link by name (`book/dune#author`, domain/links.ts), shown with the option; set by searchLinkTargets. */
  link?: string;
  /** Its collection; none for a dashboard's page. */
  collectionId?: string;
  /** For a dashboard, its tab and their blocks: the dashboard. */
  dashboardId?: string;
  /** For an item and a field: the item. */
  itemId?: string;
}

const KIND_ORDER: Record<LinkTargetKind, number> = { collection: 0, view: 1, item: 2, field: 3, dashboard: 4, tab: 5, block: 6 };
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
  context: `${c.name} / ${item.label ?? ""}`,
  href: `${LIST(c)}/${item.id}${search({ view: v.id })}`,
  collectionId: c.id,
  itemId: item.id,
});

/**
 * The fields of an item's page. Without an item view: every field (the page opens the view that shows it, else the
 * standard page: pages/ItemPage.tsx). Under an item view named in the link: only those it lists, and the title field,
 * shown as its title.
 */
export const fieldTargets = (c: Collection, item: ItemLabel, itemView?: ItemView): LinkTarget[] => {
  const title = titleFields(c).find((f) => f.kind === "string")?.id;
  return c.fields.filter((f) => !itemView || f.id === title || listsField(itemView.layout, f.id)).map((f) => ({
    key: fieldKey(item.id, f.id, itemView?.id),
    kind: "field",
    name: f.name,
    context: `${c.name} / ${item.label ?? ""}`,
    href: `${LIST(c)}/${item.id}${search({ view: itemView?.id, field: f.id })}`,
    collectionId: c.id,
    itemId: item.id,
  }));
};

/** The blocks of a collection view (`named`: the view is named in the link, else it is the collection's default one). */
export const viewBlockTargets = (c: Collection, v: CollectionView, named: boolean): LinkTarget[] =>
  v.blocks.map((b) => ({
    key: `block:${v.id}:${b.id}`,
    kind: "block",
    name: blockName(b),
    context: `${c.pluralName} / ${v.name}`,
    href: `${LIST(c)}${search({ view: named ? v.id : undefined, block: b.id })}`,
    collectionId: c.id,
  }));

/** The blocks of an item's page under an item view (`named`: the item view is named in the link, else it is the default one). */
export const itemBlockTargets = (c: Collection, item: ItemLabel, v: ItemView, named: boolean): LinkTarget[] =>
  v.layout.blocks.map((b) => ({
    key: `block:${item.id}:${v.id}:${b.id}`,
    kind: "block",
    name: blockName(b),
    context: `${c.name} / ${item.label ?? ""}`,
    href: `${LIST(c)}/${item.id}${search({ view: named ? v.id : undefined, block: b.id })}`,
    collectionId: c.id,
    itemId: item.id,
  }));

const DASHBOARD = (d: Pick<Dashboard, "id">) => `#/dashboards/${d.id}`;

export const dashboardTarget = (d: Dashboard): LinkTarget => ({
  key: `dashboard:${d.id}`,
  kind: "dashboard",
  name: d.name,
  context: "Dashboard",
  href: DASHBOARD(d),
  dashboardId: d.id,
});

/** A tab of a dashboard (a copy of another space's goes by the id of the tab it copies: tabLinkId). */
export const tabTarget = (d: Dashboard, v: DashboardView): LinkTarget => ({
  key: `tab:${tabLinkId(v)}`,
  kind: "tab",
  name: v.name,
  context: d.name,
  href: `${DASHBOARD(d)}${search({ view: tabLinkId(v) })}`,
  dashboardId: d.id,
});

/** The blocks of a dashboard view (`named`: the tab is named in the link, else it is the dashboard's default one). */
export const tabBlockTargets = (d: Dashboard, v: DashboardView, named: boolean): LinkTarget[] =>
  v.blocks.map((b) => ({
    key: `block:${tabLinkId(v)}:${b.id}`,
    kind: "block",
    name: blockName(b),
    context: `${d.name} / ${v.name}`,
    href: `${DASHBOARD(d)}${search({ view: named ? tabLinkId(v) : undefined, block: b.id })}`,
    dashboardId: d.id,
  }));

/** A stored link to a dashboard taken apart: the dashboard, its tab and a block. */
export interface StoredDashboardLink {
  dashboardId: string;
  viewId?: string;
  blockId?: string;
}

/** The parts of a link to a dashboard as typed or pasted (`#/dashboards/<id>?view=<id>&block=<id>`, with or without the address before its `#`); null for anything else. */
export function parseStoredDashboardLink(text: string): StoredDashboardLink | null {
  const t = text.trim();
  const hash = t.indexOf("#/");
  const route = hash >= 0 ? t.slice(hash + 1) : t.startsWith("/dashboards/") ? t : null;
  const m = route && /^\/dashboards\/([^/?#]+)(?:\?([^#]*))?(?:#.*)?$/.exec(route);
  if (!m) return null;
  const params = new URLSearchParams(m[2] ?? "");
  const link: StoredDashboardLink = { dashboardId: m[1] };
  const view = params.get("view");
  const block = params.get("block");
  if (view) link.viewId = view;
  if (block) link.blockId = block;
  return link;
}

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
  /** The shown space's dashboards, and the tabs they show there (domain/dashboards.ts dashboardViewsIn: copies of another space's included). */
  dashboards?: Dashboard[];
  tabs?: DashboardView[];
}

const tabsOf = (data: LinkTargetData, d: Pick<Dashboard, "id">) => (data.tabs ?? []).filter((v) => v.dashboardId === d.id);

/** The option for a pasted or typed link to a dashboard, its tab or a block; null when it points at nothing there. */
export function storedDashboardTarget(link: StoredDashboardLink, data: LinkTargetData): LinkTarget | null {
  const d = data.dashboards?.find((x) => x.id === link.dashboardId);
  if (!d) return null;
  const tabs = tabsOf(data, d);
  const v = link.viewId ? findTab(tabs, link.viewId) : undefined;
  if (link.viewId && !v) return null;
  if (link.blockId) {
    const shown = v ?? defaultOf(tabs);
    return (shown && tabBlockTargets(d, shown, !!v).find((t) => t.key === `block:${tabLinkId(shown)}:${link.blockId}`)) || null;
  }
  return v ? tabTarget(d, v) : dashboardTarget(d);
}

/** The option for a pasted or typed link, built from the names it points at; null when it points at nothing there. */
export async function storedLinkTarget(link: StoredLink, data: LinkTargetData): Promise<LinkTarget | null> {
  const c = data.collections.find((x) => x.id === link.collectionId);
  if (!c) return null;
  if (link.itemId) {
    const label = isRemote(c) ? undefined : (await data.labels(c, [link.itemId]))[0];
    // An item of another space is no page here (as the options offer only the shown space's items).
    if (!label || label.spaceId !== data.spaceId) return null;
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

/** How searchLinkTargets looks: `items` whether items are offered, at most `limit` options, only those `filter` keeps. */
export interface LinkSearchOptions {
  items: boolean;
  limit?: number;
  filter?(target: LinkTarget): boolean;
}

/** With a filter, this many times the limit is looked for before it is applied. */
const FILTERED_POOL = 4;

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
 * before the last are matched exactly (as slugs), the last as typed. `dashboards/` lists the dashboards,
 * `dashboards/health/` the tabs of Health, and after a `#` the blocks of its default tab or the tab named
 * (with those of a collection called Dashboards, if there is one). A first part that names no collection but another
 * page the name alone finds (an item, a dashboard, a view) is read as that page's full link (shortNameTargets).
 * Null when it is a single word (no `/` or `#`) or its first part names nothing.
 */
async function nameLinkTargets(query: string, data: LinkTargetData, limit: number): Promise<LinkTarget[] | null> {
  const dashboards = dashboardNameTargets(query, data, limit);
  const collections = await collectionNameTargets(query, data, limit);
  if (!dashboards && !collections) return shortNameTargets(query, data, limit);
  if (!dashboards) return collections;
  return [...dashboards, ...(collections ?? [])].slice(0, limit);
}

/** The parts of a link by name as typed (a leading `#/` skipped): the path's parts and the fragment, as slugs. */
function nameLinkParts(query: string): { parts: string[]; fragment: string | null } {
  const text = query.trim().replace(/^#?\//, "");
  const hash = text.indexOf("#");
  const decode = (s: string) => {
    try {
      return slug(decodeURIComponent(s));
    } catch {
      return slug(s);
    }
  };
  return { parts: (hash < 0 ? text : text.slice(0, hash)).split("/").map(decode), fragment: hash < 0 ? null : decode(text.slice(hash + 1)) };
}

/** `dashboards/…` part by part (nameLinkTargets); null when it doesn't start so. */
function dashboardNameTargets(query: string, data: LinkTargetData, limit: number): LinkTarget[] | null {
  const { parts, fragment } = nameLinkParts(query);
  if (parts[0] !== DASHBOARDS || !data.dashboards || (parts.length < 2 && fragment === null)) return null;
  const rest = parts.slice(1);
  if (fragment === null && rest.length === 1) {
    return rankBySlug(data.dashboards.map((d) => ({ t: dashboardTarget(d), slug: slug(d.name) })), rest[0], limit);
  }
  const found = data.dashboards.filter((d) => slug(d.name) === rest[0]);
  if (found.length !== 1 || rest.length > 2) return [];
  const d = found[0];
  const tabs = tabsOf(data, d);
  if (fragment === null) return rankBySlug(withSlugs(tabs.map((v) => tabTarget(d, v)), tabs.map((v) => v.name)), rest[1], limit);
  const tab = rest.length === 2 ? tabs[slugs(tabs.map((v) => v.name)).indexOf(rest[1])] : defaultOf(tabs);
  return tab ? rankBySlug(withSlugs(tabBlockTargets(d, tab, rest.length === 2), tab.blocks.map(blockName)), fragment, limit) : [];
}

/**
 * A link by name whose first part names no collection but another page the name alone finds (nameLinkTargets), read as
 * that page's full link with the rest after it: an item of the shown space (`dune/compact`, `dune#author` as
 * `book/dune/…`), a dashboard (`health/daily` as `dashboards/health/daily`), and, before a `#`, a collection view
 * (`reading-list#shelf` as `books/reading-list#shelf`) or a dashboard view (`daily#chart` as
 * `dashboards/health/daily#chart`). Every page of that name counts (their options together); null when none.
 */
async function shortNameTargets(query: string, data: LinkTargetData, limit: number): Promise<LinkTarget[] | null> {
  const text = query.trim().replace(/^#?\//, "");
  const hash = text.indexOf("#");
  const path = (hash < 0 ? text : text.slice(0, hash)).split("/");
  const { parts, fragment } = nameLinkParts(query);
  if (parts.length < 2 && fragment === null) return null;
  const head = parts[0];
  if (!head || head === DASHBOARDS) return null;
  // What follows the first part, as typed.
  const rest = text.slice(path[0].length);
  const full: string[] = [];
  for (const c of data.collections) {
    if (isRemote(c)) continue;
    // Counted among every space's items, as domain/links.ts counts; only the shown space's are offered.
    const labels = await data.labels(c);
    const at = slugs(labels.map((l) => l.label ?? "")).indexOf(head);
    if (at >= 0 && labels[at].spaceId === data.spaceId && labels[at].label) full.push(`${slug(c.name)}/${head}${rest}`);
  }
  for (const d of data.dashboards ?? []) if (slug(d.name) === head) full.push(`${DASHBOARDS}/${head}${rest}`);
  // A view has nothing under it but its blocks: only before a `#`.
  if (parts.length === 1 && fragment !== null) {
    for (const c of data.collections) {
      const views = data.views.filter((v) => v.collectionId === c.id);
      if (slugs(views.map((v) => v.name)).includes(head)) full.push(`${slug(c.pluralName)}/${head}${rest}`);
    }
    for (const d of data.dashboards ?? []) {
      if (slugs(tabsOf(data, d).map((v) => v.name)).includes(head)) full.push(`${DASHBOARDS}/${slug(d.name)}/${head}${rest}`);
    }
  }
  if (full.length === 0) return null;
  const found = await Promise.all(full.map(async (q) => dashboardNameTargets(q, data, limit) ?? (await collectionNameTargets(q, data, limit)) ?? []));
  return withoutShown(found.flat(), []).slice(0, limit);
}

/** A link by name to a collection's page part by part (nameLinkTargets). */
async function collectionNameTargets(query: string, data: LinkTargetData, limit: number): Promise<LinkTarget[] | null> {
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
  // A field's slug counts among all the fields (as domain/links.ts counts), whichever a view offers.
  const fieldSlugs = slugs(c.fields.map((f) => f.name));
  const itemPage = (item: ItemLabel, itemView: ItemView | undefined, named: boolean) => {
    const viewId = named ? itemView?.id : undefined;
    const slugOf = new Map(c.fields.map((f, i) => [fieldKey(item.id, f.id, viewId), fieldSlugs[i]]));
    const fields = fieldTargets(c, item, named ? itemView : undefined).map((t) => ({ t, slug: slugOf.get(t.key) ?? "" }));
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
export async function searchLinkTargets(query: string, data: LinkTargetData, opts: LinkSearchOptions): Promise<LinkTarget[]> {
  const { filter, ...find } = opts;
  if (!filter) return withNameLinks(await findLinkTargets(query, data, find), data);
  // Some are left out: more are looked for, so the list stays full; only those kept are described.
  const limit = find.limit ?? 50;
  const found = await findLinkTargets(query, data, { ...find, limit: limit * FILTERED_POOL });
  return withNameLinks(found.filter(filter).slice(0, limit), data);
}

/** What domain/links.ts reads a link by name with, from what the options are made of. */
const linkDataOf = (data: LinkTargetData): LinkData => ({
  collections: data.collections,
  views: async (c) => data.views.filter((v) => v.collectionId === c.id),
  items: (c) => (isRemote(c) ? Promise.resolve([]) : data.labels(c)),
  dashboards: data.dashboards,
  tabs: async (d) => tabsOf(data, d),
});

/** The options with their links by name (what typing it out would be), as the editor shows a stored link. */
async function withNameLinks(targets: LinkTarget[], data: LinkTargetData): Promise<LinkTarget[]> {
  const linkData = linkDataOf(data);
  return Promise.all(targets.map(async (t) => ({ ...t, link: (await describeLink(t.href, linkData).catch(() => null)) ?? undefined })));
}

/**
 * The page a link names, stored by id (`#/collections/…`, `#/dashboards/…`, with or without the address before its
 * `#`) or written by name (`book/dune/details#author`); null when it names no page there (what a bookmark can't be of).
 */
export async function linkTargetOf(link: string, data: LinkTargetData): Promise<LinkTarget | null> {
  const typed = link.trim();
  const isStored = !!parseStoredDashboardLink(typed) || !!parseStoredLink(typed);
  const stored = isStored ? typed : await resolveNameLink(typed, linkDataOf(data)).catch(() => null);
  if (!stored) return null;
  const dashboard = parseStoredDashboardLink(stored);
  if (dashboard) return storedDashboardTarget(dashboard, data);
  const page = parseStoredLink(stored);
  return page ? storedLinkTarget(page, data) : null;
}

async function findLinkTargets(query: string, data: LinkTargetData, opts: Omit<LinkSearchOptions, "filter">): Promise<LinkTarget[]> {
  const limit = opts.limit ?? 50;
  const dashboardLink = parseStoredDashboardLink(query);
  if (dashboardLink) {
    const target = storedDashboardTarget(dashboardLink, data);
    return target ? [target] : [];
  }
  const stored = parseStoredLink(query);
  if (stored) {
    const target = await storedLinkTarget(stored, data);
    return target ? [target] : [];
  }
  const named = await nameLinkTargets(query, data, limit);
  // A leading `#/` (or `/`) only says a page of the app is meant: what follows is searched for as words too
  // (`#/dune` finds Dune, `#/une` too, `#/dune#author` its fields), unless it is an address with a `/` in it.
  const words = query.replace(/^#?\//, "");
  const nativeItems = async () => {
    const lists = await Promise.all(
      data.collections
        .filter((c) => !isRemote(c))
        .map(async (c) => (await data.labels(c)).filter((l) => l.spaceId === data.spaceId && l.label).map((l) => itemTarget(c, l))),
    );
    return lists.flat();
  };
  const hash = words.startsWith("#") ? -1 : words.indexOf("#");
  if (hash >= 0) {
    const items = rankTargets(await nativeItems(), words.slice(0, hash), 3, true);
    const fields = items.flatMap((i) => {
      const c = data.collections.find((x) => x.id === i.collectionId)!;
      return fieldTargets(c, { id: i.itemId!, label: i.name, spaceId: data.spaceId });
    });
    return withoutShown([...(named ?? []), ...rankTargets(fields, words.slice(hash + 1), limit, true)], []).slice(0, limit);
  }
  if (named) return named;
  const targets = [
    ...data.collections.map(collectionTarget),
    ...data.views.flatMap((v) => {
      const c = data.collections.find((x) => x.id === v.collectionId);
      return c ? [viewTarget(c, v)] : [];
    }),
    ...(data.dashboards ?? []).flatMap((d) => [dashboardTarget(d), ...tabsOf(data, d).map((v) => tabTarget(d, v))]),
    ...(opts.items ? await nativeItems() : []),
  ];
  return rankTargets(targets, words.includes("/") ? query : words, limit);

}
