// Internal links in Markdown. Written by name, as plain GFM links with no scheme:
//
//   books                    the collection (its default view)
//   books/reading-list#table a block of a collection view
//   book/dune                an item (the singular name)
//   book/dune#author         a field (or block) of its page
//   book/dune/compact#author ... shown under an item view
//   dashboards               the Dashboards page
//   dashboards/health        a dashboard (its default tab)
//   dashboards/health/daily  a tab of it
//   dashboards/health/daily#chart  a block of a tab (dashboards/health#chart: of its default tab)
//
// Stored by id (`#/collections/<id>/items?view=<id>&block=<id>`, `#/dashboards/<id>?view=<id>&block=<id>`, the app's
// own routes), so a rename breaks nothing; the editor shows the name form again (describeLink). Names are matched as
// slugs (lower case, spaces as hyphens, as GFM heading anchors); the same slug twice gets -1, -2 …. "dashboards"
// names a collection called so when there is one and no dashboard fits the rest.

import type { Collection, ItemLabel } from "./model";
import type { CollectionView, ViewBlock } from "./views";
import { findTab, tabLinkId, type Dashboard, type DashboardView } from "./dashboards";

/** What a link may point at, loaded as needed (views and items are not kept in memory). */
export interface LinkData {
  collections: Collection[];
  views(collection: Collection): Promise<CollectionView[]>;
  items(collection: Collection): Promise<ItemLabel[]>;
  /** The dashboards, and the tabs a dashboard shows in the shown space (copies of another space's included). */
  dashboards?: Dashboard[];
  tabs?(dashboard: Dashboard): Promise<DashboardView[]>;
}

/** The first part of a link by name to a dashboard (or the Dashboards page). */
export const DASHBOARDS = "dashboards";

/** A name as it is written in a link: lower case, no punctuation, hyphens for spaces. */
export const slug = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");

/** The slugs of names that are listed together: the second "Dune" is "dune-1". */
export function slugs(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const s = slug(n);
    const count = seen.get(s) ?? 0;
    seen.set(s, count + 1);
    return count === 0 ? s : `${s}-${count}`;
  });
}

/** The name a block goes by: its title, else its type ("table", "cards"). */
export const blockName = (b: ViewBlock) => b.title || b.kind;

const indexOfSlug = (names: string[], wanted: string) => slugs(names).indexOf(wanted);

/** A link written by name: its path segments (as slugs) and fragment; null for any other link (a URL, `#…`, `?…`). */
export function parseNameLink(href: string): { segments: string[]; fragment: string | null } | null {
  const text = href.trim();
  if (!text || /^[a-z][a-z0-9+.-]*:/i.test(text) || text.startsWith("#") || text.startsWith("?") || text.startsWith("//")) return null;
  const hash = text.indexOf("#");
  const path = hash < 0 ? text : text.slice(0, hash);
  const decode = (s: string) => {
    try {
      return slug(decodeURIComponent(s));
    } catch {
      return slug(s);
    }
  };
  const segments = path.replace(/^\.?\//, "").split("/").filter(Boolean).map(decode);
  // Stored files (`files/<sha256>`) and the like are not links to pages.
  if (segments.length === 0 || segments.length > 4) return null;
  return { segments, fragment: hash < 0 ? null : decode(text.slice(hash + 1)) || null };
}

const query = (params: Record<string, string | undefined>) => {
  const q = Object.entries(params).filter((e): e is [string, string] => !!e[1]);
  return q.length ? "?" + q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&") : "";
};

const listPath = (c: Collection) => `#/collections/${c.id}/items`;

/** The default of a list of views: the starred one, else the first. */
const defaultOf = <T extends { isDefault: boolean }>(views: T[]): T | undefined => views.find((v) => v.isDefault) ?? views[0];

/**
 * The stored form of a link written by name, or null when it isn't one or names nothing (a
 * collection, view, item, field or block that doesn't exist, or two that fit).
 */
export async function resolveNameLink(href: string, data: LinkData): Promise<string | null> {
  const parsed = parseNameLink(href);
  if (!parsed) return null;
  const { fragment } = parsed;
  let segments = parsed.segments;
  const head = segments[0];
  const plural = data.collections.filter((c) => slug(c.pluralName) === head);
  const singular = data.collections.filter((c) => slug(c.name) === head);
  const all = [...new Set([...plural, ...singular])];
  if (head === DASHBOARDS && (segments.length > 1 || all.length === 0)) {
    const link = await dashboardNameLink(segments.slice(1), fragment, data);
    // Else a collection called "Dashboards" (when there is one).
    if (link || all.length === 0) return link;
  }
  if (all.length === 0 && head !== DASHBOARDS && (segments.length > 1 || fragment)) return shortNameLink(segments, fragment, data);
  if (all.length !== 1) return null;
  const collection = all[0];
  // "views/" and "items/" name the kind of the next segment, for when the name could be either.
  let kind: "view" | "item" | null = null;
  if (segments[1] === "views" || segments[1] === "items") {
    kind = segments[1] === "views" ? "view" : "item";
    segments = [head, ...segments.slice(2)];
  }
  const rest = segments.slice(1);

  if (rest.length === 0) {
    // The collection: its default view.
    if (!fragment) return listPath(collection);
    return viewLink(collection, undefined, fragment, data);
  }
  const isPlural = plural.length > 0;
  const isSingular = singular.length > 0;
  if (kind !== "item" && isPlural && rest.length === 1) {
    const views = await data.views(collection);
    const i = indexOfSlug(views.map((v) => v.name), rest[0]);
    if (i >= 0) return viewLink(collection, views[i], fragment, data);
    if (kind === "view" || !isSingular) return null;
  }
  if (kind === "view" || (!isSingular && !kind)) return null;
  // An item, and under which of its item views.
  const labels = await data.items(collection);
  const at = indexOfSlug(labels.map((l) => l.label ?? ""), rest[0]);
  if (at < 0) return null;
  const path = `#/collections/${collection.id}/items/${labels[at].id}`;
  const itemViews = collection.itemViews;
  let itemView = defaultOf(itemViews);
  if (rest.length > 1) {
    const v = indexOfSlug(itemViews.map((x) => x.name), rest[1]);
    if (v < 0) return null;
    itemView = itemViews[v];
  }
  const view = rest.length > 1 ? itemView?.id : undefined;
  if (!fragment) return path + query({ view });
  const f = indexOfSlug(collection.fields.map((x) => x.name), fragment);
  if (f >= 0) return path + query({ view, field: collection.fields[f].id });
  const blocks = itemView?.layout.blocks ?? [];
  const b = indexOfSlug(blocks.map(blockName), fragment);
  return b >= 0 ? path + query({ view, block: blocks[b].id }) : null;
}

/**
 * A link by name whose first part names no collection but another page its name alone finds, read as that page's full
 * link with the rest after it (as the link options read it, domain/linkTargets.ts shortNameTargets): an item of a native
 * collection (`dune/compact#author` as `book/dune/…`), a dashboard (`health/daily` as `dashboards/health/daily`), and,
 * before a `#`, a collection view (`reading-list#shelf`) or a dashboard view (`daily#chart`). Null unless exactly one
 * page goes by that name.
 */
async function shortNameLink(segments: string[], fragment: string | null, data: LinkData): Promise<string | null> {
  const [head] = segments;
  const after = `${segments.length > 1 ? `/${segments.slice(1).join("/")}` : ""}${fragment ? `#${fragment}` : ""}`;
  const full: string[] = [];
  for (const c of data.collections) {
    if (!c.source && indexOfSlug((await data.items(c)).map((l) => l.label ?? ""), head) >= 0) full.push(`${slug(c.name)}/${head}${after}`);
  }
  for (const d of data.dashboards ?? []) if (slug(d.name) === head) full.push(`${DASHBOARDS}/${head}${after}`);
  if (segments.length === 1 && fragment) {
    for (const c of data.collections) {
      if (indexOfSlug((await data.views(c)).map((v) => v.name), head) >= 0) full.push(`${slug(c.pluralName)}/${head}${after}`);
    }
    for (const d of data.dashboards ?? []) {
      if (data.tabs && indexOfSlug((await data.tabs(d)).map((v) => v.name), head) >= 0) full.push(`${DASHBOARDS}/${slug(d.name)}/${head}${after}`);
    }
  }
  const links = new Set((await Promise.all(full.map((f) => resolveNameLink(f, data)))).filter((l): l is string => !!l));
  return links.size === 1 ? [...links][0] : null;
}

async function viewLink(collection: Collection, view: CollectionView | undefined, fragment: string | null, data: LinkData): Promise<string | null> {
  if (!fragment) return listPath(collection) + query({ view: view?.id });
  const target = view ?? defaultOf(await data.views(collection));
  if (!target) return null;
  const blocks = target.blocks;
  const b = indexOfSlug(blocks.map(blockName), fragment);
  return b >= 0 ? listPath(collection) + query({ view: view?.id, block: blocks[b].id }) : null;
}

/** The stored form of `dashboards/<dashboard>[/<tab>][#<block>]` (the parts after "dashboards"), or null. */
async function dashboardNameLink(rest: string[], fragment: string | null, data: LinkData): Promise<string | null> {
  if (rest.length === 0) return fragment ? null : "#/dashboards";
  if (rest.length > 2) return null;
  const found = (data.dashboards ?? []).filter((d) => slug(d.name) === rest[0]);
  if (found.length !== 1) return null;
  const d = found[0];
  const path = `#/dashboards/${d.id}`;
  if (rest.length === 1 && !fragment) return path;
  const tabs = (await data.tabs?.(d)) ?? [];
  let tab: DashboardView | undefined;
  if (rest.length === 2) {
    tab = tabs[indexOfSlug(tabs.map((v) => v.name), rest[1])];
    if (!tab) return null;
  }
  const view = tab && tabLinkId(tab);
  if (!fragment) return path + query({ view });
  const blocks = (tab ?? defaultOf(tabs))?.blocks ?? [];
  const b = indexOfSlug(blocks.map(blockName), fragment);
  return b >= 0 ? path + query({ view, block: blocks[b].id }) : null;
}

const DASHBOARD_ROUTE = /^#\/dashboards(?:\/([^/?#]+))?(?:\?([^#]*))?$/;

/** The name form of a stored link to the Dashboards page, a dashboard, its tab or a block of one; null when it is gone. */
async function describeDashboardLink(m: RegExpExecArray, data: LinkData): Promise<string | null> {
  const [, dashboardId, search] = m;
  if (!dashboardId) return DASHBOARDS;
  const d = data.dashboards?.find((x) => x.id === dashboardId);
  if (!d) return null;
  const params = new URLSearchParams(search ?? "");
  const view = params.get("view");
  const block = params.get("block");
  const tabs = view || block ? ((await data.tabs?.(d)) ?? []) : [];
  const shown = view ? findTab(tabs, view) : undefined;
  if (view && !shown) return null;
  const tabSlug = shown ? slugs(tabs.map((v) => v.name))[tabs.indexOf(shown)] : undefined;
  let name: string | undefined;
  if (block) {
    const blocks = (shown ?? defaultOf(tabs))?.blocks ?? [];
    const i = blocks.findIndex((b) => b.id === block);
    if (i < 0) return null;
    name = slugs(blocks.map(blockName))[i];
  }
  return [DASHBOARDS, slug(d.name), tabSlug].filter(Boolean).join("/") + (name === undefined ? "" : `#${name}`);
}

const ROUTE = /^#\/collections\/([^/?#]+)\/items(?:\/([^/?#]+))?(?:\?([^#]*))?$/;

/**
 * The name form of a stored link, for the editor to show; null when it isn't a link to a
 * collection, view, item, field or block, or what it points at is gone (then the stored form is shown as it is).
 */
export async function describeLink(href: string, data: LinkData): Promise<string | null> {
  const dashboard = DASHBOARD_ROUTE.exec(href.trim());
  if (dashboard) return describeDashboardLink(dashboard, data);
  const m = ROUTE.exec(href.trim());

  if (!m) return null;
  const [, collectionId, itemId, search] = m;
  const collection = data.collections.find((c) => c.id === collectionId);
  if (!collection) return null;
  const params = new URLSearchParams(search ?? "");
  const view = params.get("view");
  const block = params.get("block");
  const field = params.get("field");
  const fragment = (name: string | undefined) => (name === undefined ? null : `#${name}`);
  if (!itemId) {
    const views = await data.views(collection);
    const shown = view ? views.find((v) => v.id === view) : undefined;
    if (view && !shown) return null;
    const viewSlug = shown ? slugs(views.map((v) => v.name))[views.indexOf(shown)] : undefined;
    let name: string | undefined;
    if (block) {
      const blocks = (shown ?? defaultOf(views))?.blocks ?? [];
      const i = blocks.findIndex((b) => b.id === block);
      if (i < 0) return null;
      name = slugs(blocks.map(blockName))[i];
    }
    return [slug(collection.pluralName), viewSlug].filter(Boolean).join("/") + (fragment(name) ?? "");
  }
  const labels = await data.items(collection);
  const at = labels.findIndex((l) => l.id === itemId);
  if (at < 0) return null;
  const itemViews = collection.itemViews;
  const chosen = view ? itemViews.find((v) => v.id === view) : undefined;
  if (view && !chosen) return null;
  let name: string | undefined;
  if (field) {
    const i = collection.fields.findIndex((f) => f.id === field);
    if (i < 0) return null;
    name = slugs(collection.fields.map((f) => f.name))[i];
  } else if (block) {
    const blocks = (chosen ?? defaultOf(itemViews))?.layout.blocks ?? [];
    const i = blocks.findIndex((b) => b.id === block);
    if (i < 0) return null;
    name = slugs(blocks.map(blockName))[i];
  }
  const viewSlug = chosen ? slugs(itemViews.map((v) => v.name))[itemViews.indexOf(chosen)] : undefined;
  return [slug(collection.name), slugs(labels.map((l) => l.label ?? ""))[at], viewSlug].filter(Boolean).join("/") + (fragment(name) ?? "");
}
