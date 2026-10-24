// Block types: the ways a block shows a collection's items (table, cards, a component, …).
//
// To add a block type: implement BlockTypeDefinition in its own file and add it to BLOCK_TYPES.
// Nothing else needs to change: collection views, item pages and their menus all work from this
// registry. A block type gets the already filtered / sorted / grouped items (QueryResult) and the
// fields its layout shows, and only decides how to present them, plus its own options. What is
// the same for every type (filter, sort and group, fields) is the block's, not in options,
// so it carries over when the type is switched.

import type { ComponentType } from "react";
import type { CarbonIconType } from "@carbon/icons-react";
import type { Component } from "../domain/components";
import type { FieldLayout } from "../domain/fieldLayout";
import type { FieldDef, FieldValue, Item, Collection } from "../domain/model";
import type { QueryResult, SortRule } from "../domain/query";
import type { RefLabel } from "../domain/components";
import type { RefOptions } from "../ui/useReferenceOptions";
import type { OpenMode } from "../workspace/Workspace";

/** What a view can do with items; provided by the collection page. */
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
  /** Opens the form for a new item (the collection page's "New" button). */
  openNew?(mode?: OpenMode): void;
  /** Creates an item from the values entered inline (the table's add row). */
  create?(values: Record<string, FieldValue>): Promise<void>;
  /** The primary sort, and a way to change it (e.g. clicking a column header). */
  sort?: SortRule;
  sortBy?(fieldId: string): void;
}

/** The page an item page's block is on: its item (a component's $item; filter values "this item"). */
export interface PageItem {
  collection: Collection;
  item: Item;
  refLabel: RefLabel;
}

export interface BlockProps<O> {
  collection: Collection;
  result: QueryResult;
  /** The fields the block's layout shows, in order. */
  fields: FieldDef[];
  layout: FieldLayout;
  options: O;
  /** Stores changed options right away (a block that edits its own content, like Markdown). */
  onOptions(options: O): void;
  refs: RefOptions;
  /** Free-text search, for highlighting matches. */
  search: string;
  actions: ItemActions;
  /** Every item of the collection in the shown space, unfiltered (a component's $all). */
  all: Item[];
  /** On an item page: its item; null in a collection view. */
  page: PageItem | null;
  /** Keys of the groups shown collapsed (stored with the view), and collapsing / expanding one. */
  collapsedGroups: string[];
  onGroupCollapse(key: string, collapsed: boolean): void;
}

/** Which of a block's common settings a block type uses: its menus show only those. */
export interface BlockUses {
  /** Its items are listed: filter, sort and group apply. */
  query: boolean;
  /** Fields can be chosen, with these of the layout's settings; null = no field choice. */
  fields: { labels: boolean; hideEmpty: boolean } | null;
}

/** Where a block is: in a collection view, or on an item page (which can give it an item). */
export type BlockPlace = "collection" | "item";

export interface BlockOptionsProps<O> {
  collection: Collection;
  options: O;
  place: BlockPlace;
  onChange(options: O): void;
}

export interface BlockTypeDefinition<O = unknown> {
  kind: string;
  label: string;
  icon: CarbonIconType;
  defaultOptions(collection: Collection): O;
  /** Turns stored (possibly outdated) options into valid ones, e.g. dropping removed fields. */
  normalizeOptions(raw: unknown, collection: Collection): O;
  /** Which common settings apply (a component's depend on what its code uses). */
  uses(options: O, components: Component[]): BlockUses;
  View: ComponentType<BlockProps<O>>;
  /** Settings specific to this block type, in its own menu. */
  OptionsEditor?: ComponentType<BlockOptionsProps<O>>;
}

/** Typed helper so each block type's options stay type-checked inside its own file. */
export const defineBlockType = <O,>(definition: BlockTypeDefinition<O>) => definition as unknown as BlockTypeDefinition;
