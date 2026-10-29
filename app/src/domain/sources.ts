// Remote collections: a table or query of one of the server's sources (shared/sources.ts), shown
// like any collection but read-only. Their items aren't stored here: blocks ask the source for a
// page of rows (the view's query, translated here), and an item page for one row by its key.
// What a field can do (filter operators, sorting, grouping) follows its column; fields of the
// collection's own (component fields) are only shown, computed for the rows that are loaded.

import { TITLE_COLUMN, type SourceColumn, type SourceCondition, type SourceFilter, type SourceQuery, type SourceRow, type SourceShape, type SourceSort } from "../../../shared/sources";
import { resolveRange, rollingRangeValue } from "./datePeriod";
import { fieldKindList } from "./fieldKinds";
import { dateGroupLabel } from "./groupDate";
import { blankField, isMetaField, newId, SELF_FIELD, selfField, titleFields, type Collection, type CollectionSource, type FieldDef, type FieldKind, type FieldValue, type Item } from "./model";
import { filterTree, mapTree } from "./filterTree";
import { filterValueProblem, isGroupable, waitsForValue, operatorsFor, TITLE, type FilterRule, type OperatorSpec, type ViewQuery } from "./query";

export const isRemote = (collection: Pick<Collection, "source">): boolean => !!collection.source;

/** Whether a collection's items can't be changed here: a remote one's rows, a virtual one's (the backlinks). */
export const isReadOnly = (collection: Pick<Collection, "source" | "virtual">): boolean => isRemote(collection) || !!collection.virtual;

/** Field types a column's field can be shown as (they read the same values): text also as Markdown or HTML. */
export const columnKinds = (kind: FieldKind): FieldKind[] => (kind === "string" || kind === "markdown" || kind === "html" ? ["string", "markdown", "html"] : [kind]);

/**
 * The field types offered for a field: any (but AI, chosen as a component field) in a native
 * collection; in a remote one, for a column's field the types reading its values, and a field of
 * its own is a component field (nothing is stored there).
 */
export function offeredKinds(collection: Pick<Collection, "source">, field: Pick<FieldDef, "kind" | "column"> | null): FieldKind[] {
  if (!collection.source) return fieldKindList;
  return field?.column ? columnKinds(field.kind) : ["component"];
}

/** The source column a field of a remote collection shows (none for a field of its own). */
export function sourceColumn(collection: Collection, field: FieldDef): SourceColumn | undefined {
  return field.column ? collection.source?.columns.find((c) => c.name === field.column) : undefined;
}

const PLAIN_OPS = new Set(["contains", "notContains", "isEmpty", "isNotEmpty"]);

/** The filter operators of a field: in a remote collection, those its column supports (none for a field of its own). */
export function fieldOperators(collection: Collection, field: FieldDef): OperatorSpec[] {
  // The item itself is this one or not (always set: never empty).
  if (field.id === SELF_FIELD) return operatorsFor(field.kind).filter((o) => o.needsValue);
  if (!collection.source || isMetaField(field)) return operatorsFor(field.kind);
  const column = sourceColumn(collection, field);
  if (!column) return [];
  return column.plain ? operatorsFor(field.kind).filter((o) => PLAIN_OPS.has(o.id)) : operatorsFor(field.kind);
}

/** Whether items can be filtered by a field. */
export const canFilter = (collection: Collection, field: FieldDef) => fieldOperators(collection, field).length > 0;

/** Whether items can be sorted by a field (or the title, created, updated). */
export function canSort(collection: Collection, fieldId: string): boolean {
  if (!collection.source) return true;
  if (fieldId === TITLE) return true;
  const field = collection.fields.find((f) => f.id === fieldId);
  const column = field && sourceColumn(collection, field);
  return !!column && !column.plain;
}

/** Whether items can be grouped by a field. */
export function canGroup(collection: Collection, field: FieldDef): boolean {
  if (!isGroupable(field.kind)) return false;
  if (!collection.source) return true;
  const column = sourceColumn(collection, field);
  return !!column && !column.plain;
}

/** The fields made for a table's or query's columns (hidden ones too: they are left out of the first view). */
export function columnFields(columns: SourceColumn[]): FieldDef[] {
  return columns.map((c) => blankField(newId(), c.name, c.kind, { column: c.name }));
}

/** The fields shown at first: all but the noise (JSON, XML); null = all of them. */
export function firstShownFields(collection: { source?: CollectionSource | null; fields: { id: string; column?: string | null }[] }): string[] | null {
  const hidden = new Set(collection.source?.columns.filter((c) => c.hidden).map((c) => c.name));
  if (hidden.size === 0) return null;
  return collection.fields.filter((f) => !f.column || !hidden.has(f.column)).map((f) => f.id);
}

// --- Items ---------------------------------------------------------------------------------------

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** An item id for a row (its key, made safe for links): the same row always gets the same id. */
export const rowItemId = (key: string): string => base64url(new TextEncoder().encode(key));

/** The key of the row an item id names (null when it names none). */
export function rowKey(itemId: string): string | null {
  try {
    const text = atob(itemId.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(text, (ch) => ch.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** The fields that show a column, each column once: what is read. */
const columnFieldsOf = (collection: Collection) => collection.fields.filter((f) => f.column && sourceColumn(collection, f));

/** What a collection reads of its source: its columns, title and key. */
export function sourceShape(collection: Collection): SourceShape {
  const source = collection.source!;
  const columns = [...new Set(columnFieldsOf(collection).map((f) => f.column!))];
  // The title is the first of its title fields with a value (labelField), in field order.
  const title = titleFields(collection).filter((f) => f.column && sourceColumn(collection, f)).map((f) => f.column!);
  return { target: source.target, key: source.key, columns, title, untitled: collection.name };
}

/** A row as an item: its values by field id (a column's value as the field reads it). */
export function rowItem(collection: Collection, shape: SourceShape, row: SourceRow): Item {
  const at = new Map(shape.columns.map((c, i) => [c, i]));
  const values: Record<string, FieldValue> = {};
  for (const f of collection.fields) {
    const i = f.column ? at.get(f.column) : undefined;
    if (i === undefined) continue;
    const v = row.values[i];
    if (v !== null && v !== undefined) values[f.id] = v;
  }
  return { id: rowItemId(row.key), collectionId: collection.id, spaceId: "", values, createdAt: "", updatedAt: "" };
}

// --- Queries -------------------------------------------------------------------------------------

/** The label of a group by its key, as the app names groups (checkboxes "Checked", none "(empty)"). */
export function groupLabel(field: FieldDef | undefined, key: string): string {
  if (key === "") return "(empty)";
  if (field?.kind === "checkbox") return key === "yes" ? "Checked" : "Not checked";
  if (field?.kind === "date" || field?.kind === "datetime") return dateGroupLabel(key);
  return key;
}

/**
 * A view's query for the source, its filter values already worked out (resolveFilterValues): the
 * same condition tree as the app checks its own items with (filterTree: the inherited filter, then
 * the block's, And and Or). Rules on fields it can't filter by are left out, sorts it can't sort by
 * too (as rules on removed fields are); a rule that can't match (a value that can't be compared, as
 * in the app) is `{ or: [] }`, which keeps no row.
 */
/** A rule with the field and column it filters. */
type Paired = FilterRule & { field: FieldDef; column: string };

export function sourceQuery(
  collection: Collection,
  query: ViewQuery,
  search: string,
  timeZone: string,
): Omit<SourceQuery, "offset" | "limit" | "counts"> {
  const shape = sourceShape(collection);
  // The item itself is its row's key ("Item is This Row": the page's row).
  const byId = new Map([...collection.fields, { ...selfField(collection), column: shape.key }].map((f) => [f.id, f]));
  // A rule still without its value (just added) doesn't filter yet; one on a column the source can't filter by neither.
  const paired = (rules: FilterRule[]): Paired[] =>
    rules.flatMap((rule) => {
      const field = byId.get(rule.fieldId);
      if (!field?.column || waitsForValue(field, rule)) return [];
      if (!fieldOperators(collection, field).some((o) => o.id === rule.operator || rule.operator === "between")) return [];
      return [{ ...rule, field, column: field.column }];
    });
  const tree = filterTree([paired(query.inherited ?? []), paired(query.filters)]);
  const never: SourceCondition = { or: [] };
  const filter: SourceCondition =
    tree === null
      ? { and: [] }
      : mapTree<Paired, SourceFilter>(tree, (rule) => {
          const value = rule.value.trim();
          if (filterValueProblem(rule.field, rule.operator, value)) return never;
          if (rule.field.id === SELF_FIELD) {
            const key = rowKey(value);
            return key === null ? never : { column: rule.column, operator: rule.operator, value: key };
          }
          if (rule.operator !== "between") return { column: rule.column, operator: rule.operator, value };
          const period = resolveRange(value);
          return period ? { column: rule.column, operator: "between", value: `${period.start}..${period.end}` } : never;
        });
  const sort: SourceSort[] = query.sort.flatMap((s) => {
    if (s.fieldId === TITLE) return [{ column: TITLE_COLUMN, direction: s.direction }];
    const field = byId.get(s.fieldId);
    return field?.column && canSort(collection, field.id) ? [{ column: field.column, direction: s.direction }] : [];
  });
  const groupField = query.groupBy ? byId.get(query.groupBy) : undefined;
  const groupBy = groupField?.column && canGroup(collection, groupField) ? groupField.column : null;
  return { ...shape, filter, search: search.trim(), sort, groupBy, groupOrder: query.groupOrder ?? "asc", timeZone };
}

/** The device's time zone (its days: dates are compared and grouped by them). */
export const deviceTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

// --- Editing a remote collection -----------------------------------------------------------------

/**
 * A draft that reads `target` of the source `name`, with the columns just read: fields of columns
 * still there stay (renamed, reordered, shown as Markdown: as they were; a column whose type
 * changed gets its new one), fields of columns gone go, new columns get a field at the end (but
 * those hidden: `hiddenColumns`, kept while the column is there). The key
 * stays while its column does, else the primary key (one column), else the first column.
 */
export function withSourceColumns<D extends { source?: CollectionSource | null; fields: (Omit<FieldDef, "collectionId" | "position">)[] }>(
  draft: D,
  name: string,
  target: CollectionSource["target"],
  description: { columns: SourceColumn[]; key: string[]; time?: string },
): D {
  const columns = new Map(description.columns.map((c) => [c.name, c]));
  const hidden = (draft.source?.hiddenColumns ?? []).filter((name) => columns.has(name));
  const had = new Set([...draft.fields.flatMap((f) => (f.column ? [f.column] : [])), ...hidden]);
  const fields = draft.fields.flatMap((f) => {
    if (!f.column) return [f];
    const c = columns.get(f.column);
    if (!c) return [];
    return [columnKinds(c.kind).includes(f.kind) ? f : { ...f, kind: c.kind }];
  });
  for (const c of description.columns) {
    if (had.has(c.name)) continue;
    const { collectionId: _c, position: _p, ...field } = columnFields([c])[0];
    fields.push(field);
  }
  const old = draft.source?.key;
  const key = old && columns.has(old) ? old : description.key.length === 1 && columns.has(description.key[0]) ? description.key[0] : (description.columns[0]?.name ?? "");
  const time = description.time && columns.has(description.time) ? description.time : undefined;
  return { ...draft, source: { name, target, key, columns: description.columns, ...(hidden.length > 0 && { hiddenColumns: hidden }), ...(time && { time }) }, fields };
}

/**
 * A remote collection's columns hidden or shown again (in its settings): a hidden column's field
 * goes (it stays hidden when the columns are read again), a column shown again gets a field at the end.
 */
export function withHiddenColumns<D extends { source?: CollectionSource | null; fields: (Omit<FieldDef, "collectionId" | "position">)[] }>(draft: D, hidden: string[]): D {
  if (!draft.source) return draft;
  const names = new Set(hidden);
  const fields = draft.fields.filter((f) => !f.column || !names.has(f.column));
  const had = new Set(fields.flatMap((f) => (f.column ? [f.column] : [])));
  for (const c of draft.source.columns) {
    if (names.has(c.name) || had.has(c.name) || !(draft.source.hiddenColumns ?? []).includes(c.name)) continue;
    const { collectionId: _c, position: _p, ...field } = columnFields([c])[0];
    fields.push(field);
  }
  const { hiddenColumns: _old, ...source } = draft.source;
  return { ...draft, source: names.size > 0 ? { ...source, hiddenColumns: [...names] } : source, fields };
}

/** A table's name as a collection's names: "customer_orders" → "Customer order" / "Customer orders". */
export function namesOfTable(table: string): { name: string; pluralName: string } {
  const words = table.replace(/[_-]+/g, " ").trim();
  const plural = words.charAt(0).toUpperCase() + words.slice(1);
  const name = /ies$/i.test(plural) ? plural.slice(0, -3) + "y" : /(ss|us)$/i.test(plural) ? plural : plural.replace(/s$/i, "");
  return { name, pluralName: plural };
}

/** A block's rows made into items so far, for one first page and what they are made with (`basis`). */
export interface BuiltRows {
  basis: readonly unknown[];
  /** Rows made into items. */
  count: number;
  /** The rows of the build before, by key: a row that didn't change keeps its item. */
  known: Map<string, { values: string; item: Item }>;
  seen: Map<string, { values: string; item: Item }>;
  /** An item per row, in order. */
  computed: Item[];
  /** Each item once (a list column puts a row in a group per value). */
  all: Item[];
  inAll: Set<Item>;
  /** Grouped: the items by their row's group. */
  byGroup: Map<string, Item[]>;
}

/**
 * The rows made into items (`make`, then `compute`, e.g. computed fields) as they come in: rows added after
 * those made before (the next page) are made alone, so many pages cost as much as their rows, not their
 * square. Anything else in `basis` (another first page, collection, …) or fewer rows: made anew, rows that
 * didn't change keeping their item (memoized rows and computed values rely on it). Updates `prev` in place.
 */
export function addRows(prev: BuiltRows | null, basis: readonly unknown[], rows: SourceRow[], grouped: boolean, make: (row: SourceRow) => Item, compute: (items: Item[]) => Item[]): BuiltRows {
  let b = prev;
  if (!b || b.basis.length !== basis.length || b.basis.some((x, i) => x !== basis[i]) || b.count > rows.length) {
    b = { basis, count: 0, known: b?.seen ?? new Map(), seen: new Map(), computed: [], all: [], inAll: new Set(), byGroup: new Map() };
  }
  const added = rows.slice(b.count);
  const { known, seen } = b;
  const items = added.map((row) => {
    const values = JSON.stringify(row.values);
    const before = known.get(row.key) ?? seen.get(row.key);
    const entry = before && before.values === values ? before : { values, item: make(row) };
    seen.set(row.key, entry);
    return entry.item;
  });
  compute(items).forEach((item, i) => {
    b.computed.push(item);
    if (!b.inAll.has(item)) {
      b.inAll.add(item);
      b.all.push(item);
    }
    if (grouped) {
      const key = added[i].group ?? "";
      const list = b.byGroup.get(key);
      if (list) list.push(item);
      else b.byGroup.set(key, [item]);
    }
  });
  b.count = rows.length;
  return b;
}

/**
 * The date period a new view of a time series starts with: the last 7 days (rolling) on its time column's
 * field, as a time-series database is read by time (else a view reads all of it); none for other collections.
 * Its rule's id is fixed, so the starting view is the same each time it is made.
 */
export function sourcePeriod(collection: { source?: CollectionSource | null; fields: Pick<FieldDef, "id" | "kind" | "column">[] }): FilterRule[] {
  const field = collection.source?.time ? collection.fields.find((f) => f.column === collection.source!.time && (f.kind === "date" || f.kind === "datetime")) : undefined;
  return field ? [{ id: `${field.id}-period`, fieldId: field.id, operator: "between", value: rollingRangeValue({ from: -6, to: 0 }) }] : [];
}
