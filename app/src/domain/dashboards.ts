// Dashboards: pages of blocks belonging to no collection, each block listing collections of its own
// (one, or several read as one: mergedCollection.ts). Shown in some spaces (spaceIds, like a
// collection: spaces.ts inSpace). Their tabs are views (a filter and blocks, as a collection view's
// config) per space, like collection views: a space the dashboard is shown in without tabs of its own
// shows copies of the tabs of the space it was first given tabs in (`dashboardViewsIn`), stored there
// once one is changed. The dashboard's filter applies to every block it can: a rule on a field to the
// blocks of that field's collection, a rule on "Date" (DASHBOARD_DATE) to each block's own first date.

import { pageFilterScope, pageFiltersFor, newBlock, type BlockKind, type Collapsed, type ViewBlock, type ViewState } from "./views";
import { blankField, nextName, type Collection, type FieldDef } from "./model";
import type { FilterRule } from "./query";

export interface Dashboard {
  id: string;
  name: string;
  /** Carbon icon name, like a collection's; null for the default icon. */
  icon: string | null;
  description: string;
  /** The spaces it is shown in; null = every space. A new one starts in the space it is made in. */
  spaceIds: string[] | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

/** A tab of a dashboard: what a collection view is to a collection, but its blocks may be none. */
export interface DashboardView extends ViewState {
  id: string;
  dashboardId: string;
  /** Tabs belong to a space, like collection views. */
  spaceId: string;
  name: string;
  position: number;
  /** Starred: opened first on the dashboard in its space. */
  isDefault: boolean;
  /** Its collapsed blocks and groups (stored as toggled, like a collection view's). */
  collapsed: Collapsed;
  /** "Show filter bar", as a collection view's: stored as soon as it is set. Absent = off. */
  filterBar?: true;
  /** "Full width", as a collection view's: stored as soon as it is set. Absent = on (`isFullWidth("dashboard", …)`). */
  fullWidth?: boolean;
  /**
   * Not stored: a copy of another space's tab, shown in a space without tabs of its own (`dashboardViewsIn`). It is
   * stored there (`Repository.storeDashboardViews`) before it is changed, starred or bookmarked.
   */
  virtual?: true;
  createdAt: string;
  updatedAt: string;
}

/** The name a new dashboard gets: "Dashboard", else "Dashboard 2", … (free among all dashboards). */
export function newDashboardName(taken: string[]): string {
  return taken.includes("Dashboard") ? nextName("Dashboard", taken) : "Dashboard";
}

/** The name a dashboard's first tab gets. */
export const FIRST_TAB_NAME = "Dashboard";

/** A virtual tab's id: the id of the tab it copies behind this. */
export const VIRTUAL_TAB = "virtual:";
export const isVirtualTab = (id: string) => id.startsWith(VIRTUAL_TAB);

/**
 * The tabs a dashboard shows in a space, out of all its stored tabs (any order): the space's own, in their order, or,
 * when it has none, virtual copies of the tabs of the space whose tab is the oldest (where the dashboard was first given
 * tabs, while one is left there; worked out from the tabs, so it holds after that space is deleted). None when it has no
 * tabs anywhere.
 */
export function dashboardViewsIn(views: DashboardView[], dashboardId: string, spaceId: string): DashboardView[] {
  const order = (a: DashboardView, b: DashboardView) => a.position - b.position || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  const own = views.filter((v) => v.dashboardId === dashboardId);
  const here = own.filter((v) => v.spaceId === spaceId);
  if (here.length > 0) return here.sort(order);
  const oldest = [...own].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
  if (!oldest) return [];
  return own
    .filter((v) => v.spaceId === oldest.spaceId)
    .sort(order)
    .map((v) => ({ ...v, id: VIRTUAL_TAB + v.id, spaceId, virtual: true as const }));
}

/** The filter-only field "Date": each block's own first date (or date & time) field. */
export const DASHBOARD_DATE = "$date";

/** The field a dashboard's "Date" rules stand for in a collection: its first date or date & time field, if any. */
export const blockDateField = (collection: Collection): FieldDef | undefined => collection.fields.find((f) => f.kind === "date" || f.kind === "datetime");

/**
 * The collection a dashboard's filter is edited against: the fields of all its blocks' collections (pageFilterScope),
 * with "Date" first, so the filter bar's period is on it unless another field is picked.
 */
export function dashboardScope(collections: Collection[]): Collection {
  const date = blankField(DASHBOARD_DATE, "Date", "date");
  if (collections.length === 0) {
    return { id: "", name: "Dashboard", pluralName: "Dashboard", icon: null, description: "", fields: [date], itemViews: [], spaceIds: null, createdAt: "", updatedAt: "" };
  }
  const scope = pageFilterScope(collections);
  return { ...scope, fields: [{ ...date, collectionId: scope.id }, ...scope.fields] };
}

/**
 * What a dashboard's filter does to one block's collection: a "Date" rule becomes the same rule on its first date field
 * (dropped when it has none: the block isn't dated), the others as an item page's filter does (`pageFiltersFor`: rules
 * on fields it has). For a block of several collections, pass the merged collection: a rule on a field of one of its
 * collections becomes the rule on the column showing that field.
 */
export function dashboardFiltersFor(collection: Collection, filters: FilterRule[]): FilterRule[] {
  const date = blockDateField(collection);
  const rules = collection.mergedFrom ? filters.map((r) => onColumn(collection, r)) : filters;
  const kept = new Set(pageFiltersFor(collection, rules));
  return rules.flatMap((r) => (r.fieldId === DASHBOARD_DATE ? (date ? [{ ...r, fieldId: date.id }] : []) : kept.has(r) ? [r] : []));
}

/** A rule on a field of one of a merged collection's parts, as the rule on the column showing it (as it is otherwise). */
function onColumn(merged: Collection, rule: FilterRule): FilterRule {
  if (rule.fieldId.startsWith("$")) return rule;
  for (const part of merged.mergedFrom?.parts ?? []) {
    const column = Object.entries(part.map).find(([, field]) => field === rule.fieldId)?.[0];
    if (column) return { ...rule, fieldId: column };
  }
  return rule;
}


/** The collection a dashboard block starts from: its own, or the first of several. */
export const dashboardBlockCollection = (block: Pick<ViewBlock, "collectionId" | "collectionIds">): string | null =>
  block.collectionId ?? block.collectionIds?.[0] ?? null;

/** A new block of a dashboard: as a collection view's, but it always names its collection (a dashboard has none of its own). */
export function newDashboardBlock(kind: BlockKind, options: unknown, collection: Pick<Collection, "id">): ViewBlock {
  return { ...newBlock(kind, options), collectionId: collection.id };
}

/** The icon a dashboard without one of its own shows (Carbon's Dashboard). */
export const DASHBOARD_ICON = "Dashboard";
export const dashboardIcon = (dashboard: Pick<Dashboard, "icon">): string => dashboard.icon ?? DASHBOARD_ICON;

/**
 * The id a link stores for a tab: its own, or for a virtual one the id of the tab it copies (stable in that space; in a
 * space showing the copies, `findTab` finds the copy by it).
 */
export const tabLinkId = (tab: Pick<DashboardView, "id">): string => (isVirtualTab(tab.id) ? tab.id.slice(VIRTUAL_TAB.length) : tab.id);

/** The tab a link's (or bookmark's) tab id names among the tabs shown: by its id, or the copy of it. */
export const findTab = <T extends Pick<DashboardView, "id">>(tabs: T[], id: string): T | undefined =>
  tabs.find((v) => v.id === id) ?? tabs.find((v) => v.id === VIRTUAL_TAB + id);
