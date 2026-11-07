// Remote collections: a table or query of one of the server's sources (shared/sources.ts), shown
// like any collection but read-only. Their items aren't stored here: blocks ask the source for a
// page of rows (the view's query, translated here), and an item page for one row by its key.
// What a field can do (filter operators, sorting, grouping) follows its column. What the source can't
// work out (a column's field shown as another type, a component field: computed for the rows) the app
// does itself over every row (`queriesInApp`), the source asked for a filter that keeps at least those rows.

import { TITLE_COLUMN, type SourceColumn, type SourceCondition, type SourceFilter, type SourceQuery, type SourceRow, type SourceShape, type SourceSort } from "../../../shared/sources";
import { resolveRange, rollingRangeValue } from "./datePeriod";
import { fieldKindList } from "./fieldKinds";
import { dateGroupLabel } from "./groupDate";
import { blankField, isMetaField, newId, SELF_FIELD, selfField, titleFields, valueKind, type Collection, type CollectionSource, type FieldDef, type FieldKind, type FieldValue, type Item } from "./model";
import { filterTree, mapTree } from "./filterTree";
import { filterValueProblem, isGroupable, ruleMatches, waitsForValue, operatorsFor, TITLE, type FilterRule, type OperatorSpec, type ViewQuery } from "./query";

export const isRemote = (collection: Pick<Collection, "source">): boolean => !!collection.source;

/** Whether a collection's items can't be changed here: a remote one's rows, a virtual one's (the backlinks), a merged collection's. */
export const isReadOnly = (collection: Pick<Collection, "source" | "virtual" | "mergedFrom">): boolean => isRemote(collection) || !!collection.virtual || !!collection.mergedFrom;

const TEXT_KINDS: FieldKind[] = ["string", "markdown", "html"];
const isText = (kind: FieldKind) => TEXT_KINDS.includes(kind);

/**
 * Field types a column's field can be shown as: its own (text also as Markdown or HTML, the same values) and those its
 * values can be read as (numbers or dates stored as text, a checkbox as a number, ...): see `columnValue`.
 */
export function columnKinds(kind: FieldKind): FieldKind[] {
  if (isText(kind)) return [...TEXT_KINDS, "number", "checkbox", "date", "datetime"];
  switch (kind) {
    case "number":
      // A date & time or date also from a Unix timestamp (`columnValue`).
      return ["number", "string", "checkbox", "datetime", "date"];
    case "checkbox":
      return ["checkbox", "string", "number"];
    case "date":
      return ["date", "datetime", "string"];
    case "datetime":
      return ["datetime", "date", "string"];
    case "string_list":
      return ["string_list", "string"];
    default:
      return [kind];
  }
}

/** Whether a field shows its column's values as they are (the same type, or text as Markdown or HTML). */
const sameValues = (columnKind: FieldKind, fieldKind: FieldKind) => columnKind === fieldKind || (isText(columnKind) && isText(fieldKind));

/**
 * A merged block's part as a collection of the merged fields (mergedCollection.ts partProjection): its fields have the
 * merged types, over the part's columns, and the merged code turns the part's values into them. What a column is
 * read as there is the part's own field's type: set here, by field id.
 */
const projectedKinds = new WeakMap<Collection, Map<string, FieldKind>>();
export function setReadKinds(projection: Collection, kinds: Map<string, FieldKind>) {
  projectedKinds.set(projection, kinds);
}

/** The type a field reads its column as: its own, or in a merged block's part its part's field's. */
const readKind = (collection: Collection, field: FieldDef) => projectedKinds.get(collection)?.get(field.id) ?? field.kind;

/** A field showing its column's values converted to another type (text as a number, ...): see `columnValue`. */
export function isConverted(collection: Collection, field: FieldDef): boolean {
  const column = sourceColumn(collection, field);
  return !!column && !sameValues(column.kind, readKind(collection, field));
}

const TRUE = new Set(["true", "t", "yes", "y", "1", "on"]);
const FALSE = new Set(["false", "f", "no", "n", "0", "off"]);

/** A number written as text: "12", "-3.5", "1e3", a decimal comma ("3,5"), thousands separators ("1,234.5"); else null. */
function textNumber(text: string): number | null {
  let t = text.trim().replace(/[\s\u00a0']/g, "");
  if (!t) return null;
  if (t.includes(",") && t.includes(".")) t = t.lastIndexOf(",") > t.lastIndexOf(".") ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  else if (/^-?\d{1,3}(,\d{3})+$/.test(t)) t = t.replace(/,/g, "");
  else t = t.replace(",", ".");
  const n = Number(t);
  return t !== "" && Number.isFinite(n) ? n : null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * A moment from a value: a Unix timestamp (a number, or text of digits alone: seconds, or milliseconds when that many
 * seconds would be past the year 5000), else text the browser reads as a date ("2024-03-05", ISO 8601, ...); a date
 * alone is its day's start here. Null when it is none.
 */
function moment(v: FieldValue): Date | null {
  const t = typeof v === "string" ? v.trim() : v;
  const stamp = typeof t === "number" ? t : typeof t === "string" && /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
  if (stamp !== null) {
    if (!Number.isFinite(stamp)) return null;
    const d = new Date(Math.abs(stamp) < 1e11 ? stamp * 1000 : stamp);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof t !== "string" || !t) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00` : t);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A column's value as a field of another type reads it (`columnKinds`); one that doesn't convert (a word as a
 * number, a date that isn't one) is empty, not NaN or a made-up value: an empty value is left out of sums, charts and
 * sorting the way a missing one is, where NaN would spread through them.
 */
export function columnValue(columnKind: FieldKind, fieldKind: FieldKind, v: FieldValue): FieldValue {
  if (v === null || v === undefined || sameValues(columnKind, fieldKind)) return v;
  switch (fieldKind) {
    case "string":
    case "markdown":
    case "html":
      if (Array.isArray(v)) return v.join(", ");
      return typeof v === "boolean" ? (v ? "true" : "false") : String(v);
    case "number":
      if (typeof v === "number") return Number.isFinite(v) ? v : null;
      if (typeof v === "boolean") return v ? 1 : 0;
      return typeof v === "string" ? textNumber(v) : null;
    case "checkbox": {
      if (typeof v === "boolean") return v;
      if (typeof v === "number") return Number.isNaN(v) ? null : v !== 0;
      const t = typeof v === "string" ? v.trim().toLowerCase() : "";
      return TRUE.has(t) ? true : FALSE.has(t) ? false : null;
    }
    case "date": {
      // A date written as one stays as written; anything else is the day of its moment where it is shown (local).
      if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return v.trim();
      const d = moment(v);
      return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : null;
    }
    case "datetime":
      return moment(v)?.toISOString() ?? null;
    default:
      return null;
  }
}

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

/**
 * A field of a remote collection that the app filters, sorts and groups by itself, the source can't: a column's field
 * shown as another type (the source would compare its own values: "10" before "9"; `columnValue`), or a component
 * field (computed for the rows). A query using one reads every row (`queriesInApp`).
 */
export function queriedInApp(collection: Collection, field: FieldDef): boolean {
  if (!collection.source || isMetaField(field) || field.id === SELF_FIELD) return false;
  return field.column ? !!sourceColumn(collection, field) && isConverted(collection, field) : field.kind === "component";
}

/** The filter operators the source has for a field: those its column supports (none for a field of its own, or one converted). */
function sourceOperators(collection: Collection, field: FieldDef): OperatorSpec[] {
  // The item itself is this one or not (always set: never empty).
  if (field.id === SELF_FIELD) return operatorsFor(valueKind(field)).filter((o) => o.needsValue);
  if (!collection.source || isMetaField(field)) return operatorsFor(valueKind(field));
  const column = sourceColumn(collection, field);
  // Converted values (text as a number, ...) aren't what the source compares: it would compare its own ("10" < "9").
  if (!column || isConverted(collection, field)) return [];
  return column.plain ? operatorsFor(valueKind(field)).filter((o) => PLAIN_OPS.has(o.id)) : operatorsFor(valueKind(field));
}

/** The filter operators of a field: in a remote collection, those its column supports, or all of its type where the app filters (`queriedInApp`). */
export function fieldOperators(collection: Collection, field: FieldDef): OperatorSpec[] {
  return queriedInApp(collection, field) ? operatorsFor(valueKind(field)) : sourceOperators(collection, field);
}

/** Whether items can be filtered by a field. */
export const canFilter = (collection: Collection, field: FieldDef) => fieldOperators(collection, field).length > 0;

/** Whether the source sorts by a field (or the title). */
function sourceSorts(collection: Collection, fieldId: string): boolean {
  if (!collection.source || fieldId === TITLE) return true;
  const field = collection.fields.find((f) => f.id === fieldId);
  const column = field && sourceColumn(collection, field);
  return !!column && !column.plain && !isConverted(collection, field);
}

/** Whether items can be sorted by a field (or the title, created, updated): by the source, or by the app (`queriedInApp`). */
export function canSort(collection: Collection, fieldId: string): boolean {
  const field = collection.fields.find((f) => f.id === fieldId);
  return sourceSorts(collection, fieldId) || (!!field && queriedInApp(collection, field));
}

/** Whether the source groups by a field. */
function sourceGroups(collection: Collection, field: FieldDef): boolean {
  if (!isGroupable(field)) return false;
  if (!collection.source) return true;
  const column = sourceColumn(collection, field);
  return !!column && !column.plain && !isConverted(collection, field);
}

/** Whether items can be grouped by a field: by the source, or by the app (`queriedInApp`). */
export function canGroup(collection: Collection, field: FieldDef): boolean {
  return sourceGroups(collection, field) || (isGroupable(field) && queriedInApp(collection, field));
}

/**
 * Whether a remote block's rows are grouped by the app: its grouping is by a date (or date & time) column's year,
 * month, week or hour. The source groups by the value itself (a day), so the block loads every row, filtered and
 * sorted by the source, and groups them with groupDate, as a native collection's items are.
 */
export function groupsInApp(collection: Collection, query: Pick<ViewQuery, "groupBy" | "groupDate">): boolean {
  if (!collection.source || !query.groupBy || !query.groupDate) return false;
  const field = collection.fields.find((f) => f.id === query.groupBy);
  if (!field || (field.kind !== "date" && field.kind !== "datetime") || !canGroup(collection, field)) return false;
  return query.groupDate === "hour" ? field.kind === "datetime" : query.groupDate !== "day";
}

type QueryParts = Pick<ViewQuery, "filters" | "inherited" | "sort" | "groupBy" | "groupDate">;

/**
 * Whether a remote block's query is worked out by the app: grouped by a date part (`groupsInApp`), or filtered (a rule
 * with its value), sorted or grouped by a field the source can't (`queriedInApp`). The source is then asked for a filter
 * keeping at least the rows the query keeps (`sourceQuery`: such a rule holds for every row), the block loads every row,
 * and the app runs the query over them (`appQuery`, applyQuery) as over a native collection's items.
 */
export function queriesInApp(collection: Collection, query: QueryParts): boolean {
  if (!collection.source) return false;
  if (groupsInApp(collection, query)) return true;
  const byId = new Map(collection.fields.map((f) => [f.id, f]));
  const here = (id: string | null | undefined) => {
    const field = id ? byId.get(id) : undefined;
    return field && queriedInApp(collection, field) ? field : undefined;
  };
  return (
    [...(query.inherited ?? []), ...query.filters].some((rule) => {
      const field = here(rule.fieldId);
      return !!field && !waitsForValue(field, rule);
    }) ||
    query.sort.some((s) => !!here(s.fieldId)) ||
    !!here(query.groupBy)
  );
}

/**
 * The query the app runs over a remote block's rows when it works it out (`queriesInApp`): its rules, sorts and grouping
 * on what can be filtered, sorted and grouped (by the source or here), so a rule the source leaves out (on a field it has
 * no column for) is left out here too.
 */
export function appQuery<Q extends QueryParts>(collection: Collection, query: Q): Q {
  const byId = new Map([...collection.fields, selfField(collection)].map((f) => [f.id, f]));
  const kept = (rules: FilterRule[]) =>
    rules.filter((rule) => {
      const field = byId.get(rule.fieldId);
      if (!field || !(field.column || field.id === SELF_FIELD || queriedInApp(collection, field))) return false;
      return fieldOperators(collection, field).some((o) => o.id === rule.operator || rule.operator === "between");
    });
  const group = query.groupBy ? byId.get(query.groupBy) : undefined;
  return {
    ...query,
    filters: kept(query.filters),
    ...(query.inherited ? { inherited: kept(query.inherited) } : {}),
    sort: query.sort.filter((s) => canSort(collection, s.fieldId)),
    groupBy: group && canGroup(collection, group) ? group.id : null,
  };
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
    const column = sourceColumn(collection, f);
    const v = column ? columnValue(column.kind, readKind(collection, f), row.values[i]) : row.values[i];
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
/** A rule with the field and column it filters, or (a field every row has the same value of) whether it holds for them all. */
type Paired = FilterRule & { field: FieldDef; column: string; always?: boolean };

/**
 * Fields the source has no column for but whose value is the same on every row (a merged collection's part: a field of the merged collection it
 * doesn't map has no value, its Collection column is the part's name): by field id, the field and that value. A rule on one
 * holds for all the rows or for none of them, which `sourceQuery` settles itself.
 */
export type ConstantFields = Map<string, { field: FieldDef; value: FieldValue }>;

export function sourceQuery(
  collection: Collection,
  query: ViewQuery,
  search: string,
  timeZone: string,
  constants?: ConstantFields,
): Omit<SourceQuery, "offset" | "limit" | "counts"> {
  const shape = sourceShape(collection);
  // The item itself is its row's key ("Item is This Row": the page's row).
  const byId = new Map([...collection.fields, { ...selfField(collection), column: shape.key }].map((f) => [f.id, f]));
  // A rule still without its value (just added) doesn't filter yet; one on a column the source can't filter by neither.
  const paired = (rules: FilterRule[]): Paired[] =>
    rules.flatMap((rule) => {
      const constant = constants?.get(rule.fieldId);
      if (constant && !byId.has(rule.fieldId)) {
        if (waitsForValue(constant.field, rule) || !operatorsFor(valueKind(constant.field)).some((o) => o.id === rule.operator || rule.operator === "between")) return [];
        return [{ ...rule, field: constant.field, column: "", always: ruleMatches(constant.field, constant.value, rule, { refLabel: () => "" }) }];
      }
      const field = byId.get(rule.fieldId);
      if (!field || waitsForValue(field, rule)) return [];
      // Worked out by the app (queriesInApp): the source keeps every row as far as this rule goes.
      if (queriedInApp(collection, field)) return [{ ...rule, field, column: "", always: true }];
      if (!field.column) return [];
      if (!sourceOperators(collection, field).some((o) => o.id === rule.operator || rule.operator === "between")) return [];
      return [{ ...rule, field, column: field.column }];
    });
  const tree = filterTree([paired(query.inherited ?? []), paired(query.filters)]);
  const never: SourceCondition = { or: [] };
  const all: SourceCondition = { and: [] };
  const filter: SourceCondition =
    tree === null
      ? { and: [] }
      : mapTree<Paired, SourceFilter>(tree, (rule) => {
          if (rule.always !== undefined) return rule.always ? all : never;
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
    return field?.column && sourceSorts(collection, field.id) ? [{ column: field.column, direction: s.direction }] : [];
  });
  const groupField = query.groupBy ? byId.get(query.groupBy) : undefined;
  // Worked out by the app: each row once, ungrouped (a list column would list a row under each value).
  const here = queriesInApp(collection, query);
  const groupBy = groupField?.column && sourceGroups(collection, groupField) && !here ? groupField.column : null;
  return { ...shape, filter, search: search.trim(), sort, groupBy, groupOrder: here || query.groupOrder === "custom" ? "asc" : (query.groupOrder ?? "asc"), timeZone };
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
  const before = new Map((draft.source?.columns ?? []).map((c) => [c.name, c]));
  const fields = draft.fields.flatMap((f) => {
    if (!f.column) return [f];
    const c = columns.get(f.column);
    if (!c) return [];
    // A column whose type changed gives its field its new one, unless the field was set to read it as another type
    // (text as a number) and still can.
    const was = before.get(f.column);
    const converted = !!was && !sameValues(was.kind, f.kind);
    return [sameValues(c.kind, f.kind) || (converted && columnKinds(c.kind).includes(f.kind)) ? f : { ...f, kind: c.kind }];
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
