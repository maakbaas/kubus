import { cardsView } from "./CardsView";
import type { ViewTypeDefinition } from "./registry";
import { tableView } from "./TableView";

/** All view types, in the order the view switcher shows them. Add new view types here. */
export const VIEW_TYPES: ViewTypeDefinition[] = [tableView, cardsView];

/** The view type for a kind; falls back to the table for unknown (e.g. removed) kinds. */
export const viewType = (kind: string): ViewTypeDefinition => VIEW_TYPES.find((v) => v.kind === kind) ?? tableView;

export type { ItemActions, ViewProps, ViewTypeDefinition } from "./registry";
