// View types: the ways a collection's items can be shown (table, cards, …).
//
// To add a view type: implement ViewTypeDefinition in its own file and add it to VIEW_TYPES.
// Nothing else needs to change: the items page, the view switcher and saved views all
// work from this registry. A view type gets the already filtered / sorted / grouped
// items (QueryResult) and only decides how to present them, plus its own options.

import type { ComponentType } from "react";
import type { CarbonIconType } from "@carbon/icons-react";
import type { FieldDef, FieldValue, Item, Collection } from "../domain/model";
import type { QueryResult, SortRule } from "../domain/query";
import type { RefOptions } from "../ui/useReferenceOptions";
import type { OpenMode } from "../workspace/Workspace";

/** What a view can do with items; provided by the items page. */
export interface ItemActions {
  /**
   * Opens an item: here (plain click), beside (Ctrl/Cmd click) or in a new tab (middle click);
   * `edit` opens its standard page (all fields, editable) whatever its layout.
   */
  open(item: Item, mode?: OpenMode, options?: { edit?: boolean }): void;
  remove(item: Item): void;
  /** Adds a copy of an item (its title numbered: "Name 2"). */
  duplicate?(item: Item): void;
  /** Saves one field right away (a checkbox toggle, an inline cell edit). */
  setValue(item: Item, field: FieldDef, value: FieldValue): Promise<void>;
  /** The values that put a new item in a group (by the group's key), when grouped. */
  groupPreset?(groupKey: string): Record<string, FieldValue>;
  /** The field the items are grouped by: a new item takes its group's value, not edited. */
  groupBy?: string | null;
  /** Creates an item from the values entered inline (the table's add row). */
  create?(values: Record<string, FieldValue>): Promise<void>;
  /** The primary sort, and a way to change it (e.g. clicking a column header). */
  sort?: SortRule;
  sortBy?(fieldId: string): void;
}

export interface ViewProps<O> {
  collection: Collection;
  result: QueryResult;
  options: O;
  refs: RefOptions;
  /** Free-text search, for highlighting matches. */
  search: string;
  actions: ItemActions;
}

export interface ViewTypeDefinition<O = unknown> {
  kind: string;
  label: string;
  icon: CarbonIconType;
  defaultOptions(collection: Collection): O;
  /** Turns stored (possibly outdated) options into valid ones, e.g. dropping removed fields. */
  normalizeOptions(raw: unknown, collection: Collection): O;
  /** The shown fields in order (null = all), carried over when the view type is switched. */
  fieldsOf(options: O): string[] | null;
  withFields(options: O, fields: string[] | null): O;
  View: ComponentType<ViewProps<O>>;
  /** Settings specific to this view type, shown in the view settings panel. */
  OptionsEditor?: ComponentType<{ collection: Collection; options: O; onChange(options: O): void }>;
}

/** Typed helper so each view type's options stay type-checked inside its own file. */
export const defineViewType = <O,>(definition: ViewTypeDefinition<O>) => definition as unknown as ViewTypeDefinition;
