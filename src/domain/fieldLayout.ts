// Which fields are shown, and in which order: one approach for table columns, card fields and
// object pages. A layout is an ordered list of field ids, or null for "all, in the type's order".

import { isMetaField, labelField, type ObjectInstance, type ObjectType } from "./model";

/** The fields to show, in the layout's order (unknown ids are skipped); the default ones for null. */
export function orderFields<F extends { id: string }>(all: F[], ids: string[] | null): F[] {
  if (ids === null) return all.filter((f) => !isMetaField(f));
  const byId = new Map(all.map((f) => [f.id, f]));
  return ids.map((id) => byId.get(id)).filter((f): f is F => f !== undefined);
}

/** How an object page shows its fields (a type's default, or one object's own). */
export interface ObjectLayout {
  /** Shown fields, in order; null = all, in the type's order. */
  fields: string[] | null;
  /** Fields can be clicked to edit. */
  editable: boolean;
  /** Fields shown without their small name above the value. */
  hiddenLabels: string[];
  /** Fields without a value are left out. */
  hideEmpty: boolean;
}

/** A named object page layout of a type (shown as tabs on its object pages once there are several). */
export interface ObjectView {
  id: string;
  name: string;
  layout: ObjectLayout;
  /** The layout objects of the type use unless they have their own. */
  isDefault: boolean;
}

/**
 * A type's object views: there is always at least one. Without stored ones it is "Default"
 * (the standard page), which is stored once it is changed, renamed or another view is added.
 */
export const withDefaultObjectView = (views: ObjectView[]): ObjectView[] =>
  views.length > 0 ? views : [{ id: "default", name: "Default", layout: FULL_LAYOUT, isDefault: true }];

/** Stored object views (JSON), validated; [] when absent or unreadable. */
export function parseObjectViews(json: string | null): ObjectView[] {
  if (!json) return [];
  try {
    const list = JSON.parse(json) as Partial<ObjectView>[];
    return list.flatMap((v) => {
      const layout = parseLayout(JSON.stringify(v.layout ?? null));
      return typeof v.id === "string" && layout ? [{ id: v.id, name: String(v.name ?? ""), layout, isDefault: v.isDefault === true }] : [];
    });
  } catch {
    return [];
  }
}

/** The standard object page: every field, editable, with its name. */
export const FULL_LAYOUT: ObjectLayout = { fields: null, editable: true, hiddenLabels: [], hideEmpty: false };

/** Two layouts show the same page. */
export const sameLayout = (a: ObjectLayout, b: ObjectLayout) =>
  a.editable === b.editable &&
  a.hideEmpty === b.hideEmpty &&
  JSON.stringify(a.fields) === JSON.stringify(b.fields) &&
  JSON.stringify(a.hiddenLabels) === JSON.stringify(b.hiddenLabels);

/**
 * The object view an object's page opens with: the one it is pinned to, else the type's starred
 * one, else the first; null when the type has none (the standard page).
 */
export function objectViewOf(type: ObjectType, object: ObjectInstance): ObjectView | null {
  const views = type.objectViews;
  return views.find((v) => v.id === object.objectViewId) ?? views.find((v) => v.isDefault) ?? views[0] ?? null;
}

/**
 * The fields an object page shows under a layout: the chosen ones, or by default every field
 * but the one shown as the page title (it can still be chosen explicitly).
 */
export function objectPageFields<F extends { id: string }>(fields: F[], layout: ObjectLayout, titleFieldId: string | undefined): F[] {
  return layout.fields === null ? fields.filter((f) => f.id !== titleFieldId && !isMetaField(f)) : orderFields(fields, layout.fields);
}

/** Whether a layout holds something back (read-only, or fields left out): the page then offers an edit icon. */
export function isRestricted(type: ObjectType, object: ObjectInstance, layout: ObjectLayout): boolean {
  if (!layout.editable || layout.hideEmpty) return true;
  const titleId = labelField(type, object)?.id;
  const shown = new Set(objectPageFields(type.fields, layout, titleId).map((f) => f.id));
  // Fields kept out of all-fields views don't count: the standard page doesn't show them either.
  return type.fields.some((f) => f.id !== titleId && !shown.has(f.id));
}

/** A new object view id (client-generated, like every id). */
export const newObjectViewId = () => crypto.randomUUID();

/** A stored layout (JSON), validated; null when absent or unreadable. */
export function parseLayout(json: string | null): ObjectLayout | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as Partial<ObjectLayout>;
    return {
      fields: Array.isArray(o.fields) ? o.fields.filter((id): id is string => typeof id === "string") : null,
      editable: o.editable !== false,
      hiddenLabels: Array.isArray(o.hiddenLabels) ? o.hiddenLabels.filter((id): id is string => typeof id === "string") : [],
      hideEmpty: o.hideEmpty === true,
    };
  } catch {
    return null;
  }
}

