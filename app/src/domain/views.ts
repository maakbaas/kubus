// Views of a type's objects. A view = a view type (how objects are shown: table,
// cards, …) + a query (filter / sort / group) + options specific to that view type.
// The "current" view state is ephemeral; it becomes a SavedView only when the user saves it.

import { defaultQuery, type ViewQuery } from "./query";

/** Name of a view type in the registry (src/views/registry.ts). */
export type ViewKind = string;

/** What is shown right now; may or may not match a saved view. */
export interface ViewState {
  kind: ViewKind;
  query: ViewQuery;
  /** View-type specific options, validated by that view type. */
  options: unknown;
}

export interface SavedView extends ViewState {
  id: string;
  typeId: string;
  name: string;
  position: number;
  /** Starred: the type's default view, shown when its objects are opened. */
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The unsaved starting view of every type: a table of all objects, sorted by title. */
export function defaultViewState(defaultOptions: unknown): ViewState {
  return { kind: "table", query: defaultQuery(), options: defaultOptions };
}

/** Whether two view states show the same thing (used to tell if a saved view was changed). */
export function sameView(a: ViewState, b: ViewState): boolean {
  return a.kind === b.kind && JSON.stringify(a.query) === JSON.stringify(b.query) && JSON.stringify(a.options) === JSON.stringify(b.options);
}
