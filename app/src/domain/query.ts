// Filtering, sorting and grouping of items: the "query" part of a view. Storage-free and
// UI-free. Everything kind-specific lives in KIND_RULES, so a new field kind (or operator)
// is added in one place.

import { checklistItems } from "./checklist";
import { formatDate, htmlPlainText } from "./fieldKinds";
import { markdownPlainText } from "./markdownExcerpt";
import { fieldValue, itemLabel, pickableFields, type FieldDef, type FieldKind, type FieldValue, type Item, type Collection } from "./model";

/** Pseudo fields that every item has, usable for sorting (and the default sort). */
export const TITLE = "$title";
export const UPDATED = "$updated";
export const CREATED = "$created";

export type FilterOperator =
  | "contains"
  | "notContains"
  | "is"
  | "isNot"
  | "gt"
  | "lt"
  | "before"
  | "after"
  | "isChecked"
  | "isNotChecked"
  | "isEmpty"
  | "isNotEmpty";

export interface FilterRule {
  id: string;
  fieldId: string;
  operator: FilterOperator;
  /** The comparison value as entered (text, number, yyyy-mm-dd or an item id). */
  value: string;
}

export interface SortRule {
  fieldId: string;
  direction: "asc" | "desc";
}

export interface ViewQuery {
  filters: FilterRule[];
  sort: SortRule[];
  /** Field to group by, or null. */
  groupBy: string | null;
  /** Order of the groups: by their value (A to Z / Z to A), or the largest first. Default "asc". */
  groupOrder?: GroupOrder;
}

export type GroupOrder = "asc" | "desc" | "count";

/** Resolves things the query needs but doesn't own (e.g. labels of referenced items). */
export interface QueryContext {
  /** Label of a referenced item, by the reference field and the item id. */
  refLabel(field: FieldDef, itemId: string): string;
}

export interface ItemGroup {
  key: string;
  label: string;
  items: Item[];
}

export interface QueryResult {
  groups: ItemGroup[];
  /** Items after filtering (an item in several groups counts once). */
  total: number;
}

// --- Per-kind rules ---------------------------------------------------------------------

export interface OperatorSpec {
  id: FilterOperator;
  label: string;
  /** Whether the operator takes a comparison value. */
  needsValue: boolean;
}

interface KindRules {
  operators: OperatorSpec[];
  /** Plain text used for contains / is and as a fallback. */
  text(field: FieldDef, value: FieldValue, ctx: QueryContext): string;
  /** Comparable key for sorting; null sorts last. */
  sortKey(field: FieldDef, value: FieldValue, ctx: QueryContext): string | number | null;
  /** Group keys (an item may fall in several groups, e.g. lists); omit for "not groupable". */
  groupKeys?(field: FieldDef, value: FieldValue, ctx: QueryContext): { key: string; label: string }[];
  /** The value a new item gets to land in the group with this (non-empty) key; omit when none does. */
  groupValue?(key: string): FieldValue;
}

const op = (id: FilterOperator, label: string, needsValue = true): OperatorSpec => ({ id, label, needsValue });
const EMPTY_OPS = [op("isEmpty", "is empty", false), op("isNotEmpty", "is not empty", false)];
const TEXT_OPS = [op("contains", "contains"), op("notContains", "does not contain"), op("is", "is"), op("isNot", "is not"), ...EMPTY_OPS];

const str = (v: FieldValue) => (typeof v === "string" ? v : "");
const list = (v: FieldValue) => (Array.isArray(v) ? v : []);
const single = (key: string, label = key) => [{ key, label }];
/** A date & time's day as the user sees it (local "YYYY-MM-DD"; values are stored in UTC). */
const localDay = (v: FieldValue) => {
  const d = new Date(str(v));
  return Number.isNaN(d.getTime()) ? str(v).slice(0, 10) : formatDate(d);
};
/** The day a date or date & time value falls on, "" for none. */
const dayOf = (field: FieldDef, v: FieldValue) => (!str(v) ? "" : field.kind === "datetime" ? localDay(v) : str(v));

const KIND_RULES: Record<FieldKind, KindRules> = {
  string: {
    operators: TEXT_OPS,
    text: (_, v) => str(v),
    sortKey: (_, v) => str(v).toLowerCase() || null,
    groupKeys: (_, v) => single(str(v)),
    groupValue: (key) => key,
  },
  markdown: {
    operators: [op("contains", "contains"), op("notContains", "does not contain"), ...EMPTY_OPS],
    text: (_, v) => (typeof v === "string" ? markdownPlainText(v) : ""),
    sortKey: (_, v) => (typeof v === "string" ? markdownPlainText(v).toLowerCase() : null),
  },
  html: {
    operators: [op("contains", "contains"), op("notContains", "does not contain"), ...EMPTY_OPS],
    text: (_, v) => (typeof v === "string" ? htmlPlainText(v) : ""),
    sortKey: (_, v) => (typeof v === "string" ? htmlPlainText(v).toLowerCase() || null : null),
  },
  number: {
    operators: [op("is", "="), op("isNot", "≠"), op("gt", ">"), op("lt", "<"), ...EMPTY_OPS],
    text: (_, v) => (typeof v === "number" ? String(v) : ""),
    sortKey: (_, v) => (typeof v === "number" ? v : null),
    groupKeys: (_, v) => single(typeof v === "number" ? String(v) : ""),
    groupValue: (key) => Number(key),
  },
  date: {
    operators: [op("is", "is"), op("before", "is before"), op("after", "is after"), ...EMPTY_OPS],
    text: (_, v) => str(v),
    sortKey: (_, v) => str(v) || null,
    groupKeys: (_, v) => single(str(v)),
    groupValue: (key) => key,
  },
  datetime: {
    operators: [op("is", "is on"), op("before", "is before"), op("after", "is after"), ...EMPTY_OPS],
    text: (_, v) => (str(v) ? localDay(v) : ""),
    sortKey: (_, v) => str(v) || null,
    groupKeys: (_, v) => single(str(v) ? localDay(v) : ""),
  },
  checkbox: {
    operators: [op("isChecked", "is checked", false), op("isNotChecked", "is not checked", false)],
    text: (_, v) => (v === true ? "yes" : "no"),
    sortKey: (_, v) => (v === true ? 1 : 0),
    groupKeys: (_, v) => (v === true ? single("yes", "Checked") : single("no", "Not checked")),
    groupValue: (key) => key === "yes",
  },
  image: {
    operators: EMPTY_OPS,
    text: (_, v) => str(v),
    sortKey: (_, v) => (v ? 1 : 0),
  },
  item: {
    operators: [op("is", "is"), op("isNot", "is not"), ...EMPTY_OPS],
    text: (f, v, ctx) => (typeof v === "string" && v ? ctx.refLabel(f, v) : ""),
    sortKey: (f, v, ctx) => (typeof v === "string" && v ? ctx.refLabel(f, v).toLowerCase() : null),
    groupKeys: (f, v, ctx) => (typeof v === "string" && v ? single(v, ctx.refLabel(f, v)) : single("")),
    groupValue: (key) => key,
  },
  string_list: {
    operators: [op("contains", "contains"), op("notContains", "does not contain"), ...EMPTY_OPS],
    text: (_, v) => list(v).join(", "),
    sortKey: (_, v) => list(v).join(", ").toLowerCase() || null,
    groupKeys: (_, v) => (list(v).length ? list(v).map((s) => ({ key: s, label: s })) : single("")),
    groupValue: (key) => [key],
  },
  // Items match by their text; sorted by how far along (share done), empty last.
  checklist: {
    operators: [op("contains", "contains"), op("notContains", "does not contain"), ...EMPTY_OPS],
    text: (_, v) => checklistItems(v).map((i) => i.text).join(", "),
    sortKey: (_, v) => {
      const items = checklistItems(v);
      return items.length ? items.filter((i) => i.done).length / items.length : null;
    },
  },
  item_list: {
    operators: [op("is", "includes"), op("isNot", "does not include"), ...EMPTY_OPS],
    text: (f, v, ctx) => list(v).map((id) => ctx.refLabel(f, id)).join(", "),
    sortKey: (f, v, ctx) => list(v).map((id) => ctx.refLabel(f, id)).join(", ").toLowerCase() || null,
    groupKeys: (f, v, ctx) => (list(v).length ? list(v).map((id) => ({ key: id, label: ctx.refLabel(f, id) })) : single("")),
    groupValue: (key) => [key],
  },
  // Values are the computed results (filled in before the query runs): numbers sort as numbers.
  component: {
    operators: TEXT_OPS,
    text: (_f, v) => (v == null ? "" : String(v)),
    sortKey: (_f, v) => (typeof v === "number" ? v : v == null || v === "" ? null : String(v).toLowerCase()),
    groupKeys: (_f, v) => single(v == null ? "" : String(v)),
  },
};

/** Whether a result is grouped (several groups, or one that isn't the whole list). */
export const isGrouped = (result: QueryResult) => result.groups.length > 1 || result.groups[0]?.key !== "";

/** Filter operators offered for a field kind. */
export const operatorsFor = (kind: FieldKind) => KIND_RULES[kind].operators;

/**
 * The values a new item needs to land in a group (the grouped-by field set to the group's
 * value); empty for the "(empty)" group or a field whose groups can't be targeted (date & time).
 */
export function groupPreset(collection: Collection, query: ViewQuery, groupKey: string): Record<string, FieldValue> {
  const field = query.groupBy ? collection.fields.find((f) => f.id === query.groupBy) : undefined;
  const toValue = field && KIND_RULES[field.kind].groupValue;
  return field && toValue && groupKey !== "" ? { [field.id]: toValue(groupKey) } : {};
}

/** Whether items can be grouped by fields of this kind. */
export const isGroupable = (kind: FieldKind) => !!KIND_RULES[kind].groupKeys;

/** Fields usable for sorting, including the pseudo fields. */
export function sortableFields(collection: Collection): { id: string; name: string }[] {
  return [
    { id: TITLE, name: "Title" },
    ...collection.fields.map((f) => ({ id: f.id, name: f.name })),
    { id: UPDATED, name: "Last updated" },
    { id: CREATED, name: "Created" },
  ];
}

/** Every item list starts here: no filters, sorted by title, not grouped. */
export function defaultQuery(): ViewQuery {
  return { filters: [], sort: [{ fieldId: TITLE, direction: "asc" }], groupBy: null };
}

// --- Evaluation -----------------------------------------------------------------------

/** No value: null, empty text or an empty list (an unchecked box is a value). */
export function isEmptyValue(v: FieldValue | undefined) {
  return v == null || v === "" || (Array.isArray(v) && v.length === 0);
}

function matches(field: FieldDef, value: FieldValue, rule: FilterRule, ctx: QueryContext): boolean {
  const arg = rule.value.trim();
  // The value as text, only computed by the operators that compare text.
  let cached: string | undefined;
  const text = () => (cached ??= KIND_RULES[field.kind].text(field, value, ctx).toLowerCase());
  switch (rule.operator) {
    case "isEmpty":
      return isEmptyValue(value);
    case "isNotEmpty":
      return !isEmptyValue(value);
    case "isChecked":
      return value === true;
    case "isNotChecked":
      return value !== true;
    case "contains":
      return text().includes(arg.toLowerCase());
    case "notContains":
      return !text().includes(arg.toLowerCase());
    case "is":
    case "isNot": {
      let equal: boolean;
      if (field.kind === "number") equal = typeof value === "number" && value === Number(arg);
      else if (field.kind === "item") equal = value === arg;
      else if (field.kind === "item_list") equal = list(value).includes(arg);
      else if (field.kind === "datetime") equal = dayOf(field, value) === arg;
      else equal = text() === arg.toLowerCase();
      return rule.operator === "is" ? equal : !equal;
    }
    case "gt":
      return typeof value === "number" && value > Number(arg);
    case "lt":
      return typeof value === "number" && value < Number(arg);
    case "before":
      return !!dayOf(field, value) && dayOf(field, value) < arg;
    case "after":
      return !!dayOf(field, value) && dayOf(field, value) > arg;
  }
}

function sortKey(collection: Collection, item: Item, field: FieldDef | string | undefined, ctx: QueryContext): string | number | null {
  if (field === TITLE) return itemLabel(collection, item).toLowerCase();
  if (field === UPDATED) return item.updatedAt;
  if (field === CREATED) return item.createdAt;
  return typeof field === "object" ? KIND_RULES[field.kind].sortKey(field, item.values[field.id] ?? null, ctx) : null;
}

function compareKeys(a: string | number | null, b: string | number | null): number {
  if (a === b) return 0;
  if (a === null) return 1; // empty values last, whatever the direction
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/**
 * Whether an item passes every filter, as a test for many items: rules are paired with their
 * fields once (rules on fields that no longer exist are ignored).
 */
export function filterOf(collection: Collection, filters: FilterRule[], ctx: QueryContext): (item: Item) => boolean {
  const byId = new Map(pickableFields(collection).map((f) => [f.id, f]));
  const rules = filters.flatMap((rule) => {
    const field = byId.get(rule.fieldId);
    return field ? [{ rule, field }] : [];
  });
  return (item) => rules.every(({ rule, field }) => matches(field, fieldValue(item, field), rule, ctx));
}

/** Applies a query (plus an optional free-text search) to a collection's items. */
export function applyQuery(
  collection: Collection,
  items: Item[],
  query: ViewQuery,
  ctx: QueryContext,
  search = "",
): QueryResult {
  const fieldsById = new Map(pickableFields(collection).map((f) => [f.id, f]));
  const needle = search.trim().toLowerCase();

  const passes = filterOf(collection, query.filters, ctx);
  const filtered = items.filter((item) => {
    if (!passes(item)) return false;
    if (!needle) return true;
    return collection.fields.some((f) => KIND_RULES[f.kind].text(f, item.values[f.id] ?? null, ctx).toLowerCase().includes(needle));
  });

  // Keys are computed once per item, not in every comparison.
  const sortBy = query.sort.map((rule) => ({
    field: rule.fieldId.startsWith("$") ? rule.fieldId : fieldsById.get(rule.fieldId),
    desc: rule.direction === "desc",
  }));
  const keyed = filtered.map((item) => ({ item, keys: sortBy.map((s) => sortKey(collection, item, s.field, ctx)) }));
  keyed.sort((a, b) => {
    for (let i = 0; i < sortBy.length; i++) {
      const ka = a.keys[i];
      const kb = b.keys[i];
      // Empty values stay last in both directions.
      const c = ka === null || kb === null ? compareKeys(ka, kb) : compareKeys(ka, kb) * (sortBy[i].desc ? -1 : 1);
      if (c !== 0) return c;
    }
    return 0;
  });
  const sorted = keyed.map((k) => k.item);

  const groupField = query.groupBy ? fieldsById.get(query.groupBy) : undefined;
  const groupKeys = groupField && KIND_RULES[groupField.kind].groupKeys;
  if (!groupField || !groupKeys) return { groups: [{ key: "", label: "", items: sorted }], total: sorted.length };

  const groups = new Map<string, ItemGroup>();
  for (const item of sorted) {
    for (const { key, label } of groupKeys(groupField, fieldValue(item, groupField), ctx)) {
      const group = groups.get(key) ?? { key, label: label || "(empty)", items: [] };
      group.items.push(item);
      groups.set(key, group);
    }
  }
  // Groups by value (either direction) or size, the "(empty)" group always last.
  const order = query.groupOrder ?? "asc";
  const ordered = [...groups.values()].sort((a, b) => {
    if (a.key === "" || b.key === "") return a.key === "" ? 1 : -1;
    if (order === "count" && a.items.length !== b.items.length) return b.items.length - a.items.length;
    return compareKeys(a.label, b.label) * (order === "desc" ? -1 : 1);
  });
  return { groups: ordered, total: sorted.length };
}
