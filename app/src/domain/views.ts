// Views of a collection's items. A view = a view type (how items are shown: table,
// cards, …) + a query (filter / sort / group) + options specific to that view type.
// The "current" view state is ephemeral; it becomes a CollectionView only when the user saves it.

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

export interface CollectionView extends ViewState {
  id: string;
  collectionId: string;
  name: string;
  position: number;
  /** Starred: the collection's default view, shown when its items are opened. */
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The unsaved starting view of every collection: a table of all items, sorted by title. */
export function defaultViewState(defaultOptions: unknown): ViewState {
  return { kind: "table", query: defaultQuery(), options: defaultOptions };
}

/** Whether two view states show the same thing (used to tell if a saved view was changed). */
export function sameView(a: ViewState, b: ViewState): boolean {
  return a.kind === b.kind && JSON.stringify(a.query) === JSON.stringify(b.query) && JSON.stringify(a.options) === JSON.stringify(b.options);
}
