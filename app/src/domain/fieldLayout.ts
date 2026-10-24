// Which fields are shown, and in which order: one approach for table columns, card fields and
// item pages. A layout is an ordered list of field ids, or null for "all, in the collection's order".
// Item pages hold blocks too (lists of items, components; domain/views.ts), placed among the
// fields: their ids are in the same list.

import { isMetaField, labelField, type Item, type Collection } from "./model";
import { NOTHING_COLLAPSED, parseBlock, parseCollapsed, type Collapsed, type ViewBlock } from "./views";

/** The fields to show, in the layout's order (unknown ids are skipped); the default ones for null. */
export function orderFields<F extends { id: string }>(all: F[], ids: string[] | null): F[] {
  if (ids === null) return all.filter((f) => !isMetaField(f));
  const byId = new Map(all.map((f) => [f.id, f]));
  return ids.map((id) => byId.get(id)).filter((f): f is F => f !== undefined);
}

/** Which fields show, in which order, and how: of an item page, or of a block (table columns, card fields). */
export interface FieldLayout {
  /** Shown fields, in order; null = all, in the collection's order. */
  fields: string[] | null;
  /** Fields can be edited (clicked on an item page, in place in a table). */
  editable: boolean;
  /** Fields shown without their name. */
  hiddenLabels: string[];
  /** Fields without a value are left out. */
  hideEmpty: boolean;
}

/** How an item page shows its fields, and the blocks among them (their ids are in `fields`). */
export interface ItemLayout extends FieldLayout {
  blocks: ViewBlock[];
}

/** A named item page layout of a collection (shown as tabs on its item pages once there are several). */
export interface ItemView {
  id: string;
  name: string;
  layout: ItemLayout;
  /** The layout items of the collection use unless they have their own. */
  isDefault: boolean;
  /** Its collapsed blocks and groups (saved as toggled, without "Save changes"). */
  collapsed: Collapsed;
}

/**
 * A collection's item views: there is always at least one. Without stored ones it is "Default"
 * (the standard page), which is stored once it is changed, renamed or another view is added.
 */
export const withDefaultItemView = (views: ItemView[]): ItemView[] =>
  views.length > 0 ? views : [{ id: "default", name: "Default", layout: FULL_LAYOUT, isDefault: true, collapsed: NOTHING_COLLAPSED }];

/** Stored item views (JSON), validated; [] when absent or unreadable. */
export function parseItemViews(json: string | null): ItemView[] {
  if (!json) return [];
  try {
    const list = JSON.parse(json) as Partial<ItemView>[];
    return list.flatMap((v) => {
      const layout = parseLayout(JSON.stringify(v.layout ?? null));
      return typeof v.id === "string" && layout
        ? [{ id: v.id, name: String(v.name ?? ""), layout, isDefault: v.isDefault === true, collapsed: parseCollapsed(v.collapsed) }]
        : [];
    });
  } catch {
    return [];
  }
}

/** The standard item page: every field, editable, with its name. */
export const FULL_LAYOUT: ItemLayout = { fields: null, editable: true, hiddenLabels: [], hideEmpty: false, blocks: [] };

/** Two layouts show the same page. */
export const sameLayout = (a: ItemLayout, b: ItemLayout) =>
  a.editable === b.editable &&
  a.hideEmpty === b.hideEmpty &&
  JSON.stringify(a.fields) === JSON.stringify(b.fields) &&
  JSON.stringify(a.hiddenLabels) === JSON.stringify(b.hiddenLabels) &&
  JSON.stringify(a.blocks) === JSON.stringify(b.blocks);

/**
 * The item view an item's page opens with: the one it is pinned to, else the collection's starred
 * one, else the first; null when the collection has none (the standard page).
 */
export function itemViewOf(collection: Collection, item: Item): ItemView | null {
  const views = collection.itemViews;
  return views.find((v) => v.id === item.itemViewId) ?? views.find((v) => v.isDefault) ?? views[0] ?? null;
}

/**
 * The fields an item page shows under a layout: the chosen ones, or by default every field
 * but the one shown as the page title (it can still be chosen explicitly).
 */
export function itemPageFields<F extends { id: string }>(fields: F[], layout: ItemLayout, titleFieldId: string | undefined): F[] {
  return layout.fields === null ? fields.filter((f) => f.id !== titleFieldId && !isMetaField(f)) : orderFields(fields, layout.fields);
}

/** Whether a layout holds something back (read-only, or fields left out): the page then offers an edit icon. */
export function isRestricted(collection: Collection, item: Item, layout: ItemLayout): boolean {
  if (!layout.editable || layout.hideEmpty) return true;
  const titleId = labelField(collection, item)?.id;
  const shown = new Set(itemPageFields(collection.fields, layout, titleId).map((f) => f.id));
  // Fields kept out of all-fields views don't count: the standard page doesn't show them either.
  return collection.fields.some((f) => f.id !== titleId && !shown.has(f.id));
}

/** A new item view id (client-generated, like every id). */
export const newItemViewId = () => crypto.randomUUID();

/** A stored field layout, validated; null when absent. */
export function parseFieldLayout(raw: unknown): FieldLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<FieldLayout>;
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((id): id is string => typeof id === "string") : null);
  return {
    fields: ids(o.fields),
    editable: o.editable !== false,
    hiddenLabels: ids(o.hiddenLabels) ?? [],
    hideEmpty: o.hideEmpty === true,
  };
}

/** A stored item page layout (JSON), validated; null when absent or unreadable. */
export function parseLayout(json: string | null): ItemLayout | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as Partial<ItemLayout> | null;
    const layout = parseFieldLayout(o);
    if (!layout) return null;
    const blocks = Array.isArray(o?.blocks) ? o.blocks.map(parseBlock).filter((b): b is ViewBlock => b !== null) : [];
    return { ...layout, blocks };
  } catch {
    return null;
  }
}

