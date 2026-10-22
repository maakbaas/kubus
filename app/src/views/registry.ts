// View types: the ways a type's objects can be shown (table, cards, …).
//
// To add a view type: implement ViewTypeDefinition in its own file and add it to VIEW_TYPES.
// Nothing else needs to change: the objects page, the view switcher and saved views all
// work from this registry. A view type gets the already filtered / sorted / grouped
// objects (QueryResult) and only decides how to present them, plus its own options.

import type { ComponentType } from "react";
import type { CarbonIconType } from "@carbon/icons-react";
import type { FieldDef, FieldValue, ObjectInstance, ObjectType } from "../domain/model";
import type { QueryResult, SortRule } from "../domain/query";
import type { RefOptions } from "../ui/useReferenceOptions";
import type { OpenMode } from "../workspace/Workspace";

/** What a view can do with objects; provided by the objects page. */
export interface ObjectActions {
  /**
   * Opens an object: here (plain click), beside (Ctrl/Cmd click) or in a new tab (middle click);
   * `edit` opens its standard page (all fields, editable) whatever its layout.
   */
  open(object: ObjectInstance, mode?: OpenMode, options?: { edit?: boolean }): void;
  remove(object: ObjectInstance): void;
  /** Adds a copy of an object (its title numbered: "Name 2"). */
  duplicate?(object: ObjectInstance): void;
  /** Saves one field right away (a checkbox toggle, an inline cell edit). */
  setValue(object: ObjectInstance, field: FieldDef, value: FieldValue): Promise<void>;
  /** The values that put a new object in a group (by the group's key), when grouped. */
  groupPreset?(groupKey: string): Record<string, FieldValue>;
  /** The field the objects are grouped by: a new object takes its group's value, not edited. */
  groupBy?: string | null;
  /** Creates an object from the values entered inline (the table's add row). */
  create?(values: Record<string, FieldValue>): Promise<void>;
  /** The primary sort, and a way to change it (e.g. clicking a column header). */
  sort?: SortRule;
  sortBy?(fieldId: string): void;
}

export interface ViewProps<O> {
  type: ObjectType;
  result: QueryResult;
  options: O;
  refs: RefOptions;
  /** Free-text search, for highlighting matches. */
  search: string;
  actions: ObjectActions;
}

export interface ViewTypeDefinition<O = unknown> {
  kind: string;
  label: string;
  icon: CarbonIconType;
  defaultOptions(type: ObjectType): O;
  /** Turns stored (possibly outdated) options into valid ones, e.g. dropping removed fields. */
  normalizeOptions(raw: unknown, type: ObjectType): O;
  /** The shown fields in order (null = all), carried over when the view type is switched. */
  fieldsOf(options: O): string[] | null;
  withFields(options: O, fields: string[] | null): O;
  View: ComponentType<ViewProps<O>>;
  /** Settings specific to this view type, shown in the view settings panel. */
  OptionsEditor?: ComponentType<{ type: ObjectType; options: O; onChange(options: O): void }>;
}

/** Typed helper so each view type's options stay type-checked inside its own file. */
export const defineViewType = <O,>(definition: ViewTypeDefinition<O>) => definition as unknown as ViewTypeDefinition;
