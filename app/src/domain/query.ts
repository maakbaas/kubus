// Filtering, sorting and grouping of items: the "query" part of a view. Storage-free and
// UI-free. Everything kind-specific lives in KIND_RULES, so a new field kind (or operator)
// is added in one place.

import { dollarNames, ERROR_PREFIX, fieldLookup, render, splitWarnings, type RefLabel } from "./components";
import { checklistItems } from "./checklist";
import { resolveRange } from "./datePeriod";
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
  | "between"
  | "isChecked"
  | "isNotChecked"
  | "isEmpty"
  | "isNotEmpty";

export interface FilterRule {
  id: string;
  fieldId: string;
  operator: FilterOperator;
  /** The comparison value as entered (text, number, yyyy-mm-dd, yyyy-mm-dd..yyyy-mm-dd or an item id). */
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
    // "is" takes true or false, so a value from the page's item can choose.
    operators: [op("isChecked", "is checked", false), op("isNotChecked", "is not checked", false), op("is", "is")],
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
  // Generated text, Markdown or a number (the field says which): compared as text, or as a number
  // by > and < (numbers sort as numbers).
  ai: {
    operators: [...TEXT_OPS.slice(0, 4), op("gt", ">"), op("lt", "<"), ...EMPTY_OPS],
    text: (_f, v) => (typeof v === "string" ? markdownPlainText(v) : v == null ? "" : String(v)),
    sortKey: (_f, v) => (typeof v === "number" ? v : typeof v === "string" && v ? markdownPlainText(v).toLowerCase() : null),
    groupKeys: (_f, v) => single(v == null ? "" : String(v)),
  },
};

/** Whether a result is grouped (several groups, or one that isn't the whole list). */
export const isGrouped = (result: QueryResult) => result.groups.length > 1 || result.groups[0]?.key !== "";

/**
 * Filter operators offered for a field kind. Not "between" (dates: a day, week, month, year or
 * range, both days included), which only the filter's date period sets (domain/datePeriod.ts).
 */
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

/**
 * Filter values taken from the page's item, for blocks on item pages ("Author is this item"):
 * the item itself, or one of its fields' values: what a reference field points to ("Genre is this
 * item's Genre") or a value to compare with ("Year > this item's Year"). Shown by name, never as code.
 */
export const PAGE_ITEM = "$item";
export const pageItemField = (fieldId: string) => `${PAGE_ITEM}.${fieldId}`;

/** Whether a filter value is taken from the page's item. */
export const isPageValue = (value: string) => value === PAGE_ITEM || value.startsWith(`${PAGE_ITEM}.`);

/** Filters with page-item values filled in from the page's item (no page: they match nothing). */
export function resolvePageValues(filters: FilterRule[], page: Item | null): FilterRule[] {
  if (!filters.some((r) => isPageValue(r.value))) return filters;
  return filters.map((r) => {
    if (r.value === PAGE_ITEM) return { ...r, value: page?.id ?? "" };
    if (!isPageValue(r.value)) return r;
    const v = page?.values[r.value.slice(PAGE_ITEM.length + 1)];
    return { ...r, value: typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : "" };
  });
}

/** Whether a filter value holds {{ }} code (raw text, worked out when the filter runs: resolveFilterValues). */
export const hasSections = (value: string) => /\{\{[\s\S]*?\}\}/.test(value);

/** The page a block is on, for its filter values: its item, as $item in {{ }} code. */
export interface FilterPage {
  collection: Collection;
  item: Item;
  refLabel: RefLabel;
}

/**
 * A filter value's {{ }} sections worked out, as if the result had been typed: `{{ 1 == 1 }}`
 * gives "true", `{{ new Date().toISOString().slice(0, 10) }}` today. They read $now, and on an
 * item page that page's item as $item; not a block's names. A failing section, or one reading
 * what isn't there, gives "⚠ message" (ERROR_PREFIX), which matches nothing.
 */
export function filterCodeValue(value: string, page: FilterPage | null): string {
  if (!hasSections(value)) return value;
  const names = dollarNames(value);
  const unknown = names.find((n) => n !== "now" && n !== "item");
  if (unknown) return `${ERROR_PREFIX}$${unknown} isn't available in a filter: only $now, and $item on an item page`;
  if (names.includes("item") && !page) return `${ERROR_PREFIX}$item is the page's item: only in a block on an item page`;
  const result = render({ code: value, output: "string" }, page?.item, page ? fieldLookup(page.collection, page.item, page.refLabel) : undefined);
  const text = result == null ? "" : String(result);
  const warning = splitWarnings(text);
  return warning.length > 1 ? ERROR_PREFIX + warning[1] : text.trim();
}

/** Filters with page-item values and {{ }} code worked out for the page (none: a collection view). */
export function resolveFilterValues(filters: FilterRule[], page: FilterPage | null): FilterRule[] {
  const resolved = resolvePageValues(filters, page?.item ?? null);
  if (!resolved.some((r) => hasSections(r.value))) return resolved;
  return resolved.map((r) => (hasSections(r.value) ? { ...r, value: filterCodeValue(r.value, page) } : r));
}

/**
 * Why a rule's value (as typed, or as its code works out) can't be compared, or undefined: a
 * checkbox takes true or false, a number a number, a date yyyy-mm-dd. Shown at the input; such a
 * rule matches nothing (never silently the wrong items).
 */
export function filterValueProblem(field: FieldDef, operator: FilterOperator, value: string): string | undefined {
  if (value.startsWith(ERROR_PREFIX)) return value.slice(ERROR_PREFIX.length);
  const v = value.trim();
  if (v === "" || isPageValue(v)) return undefined;
  if (operator === "between") return (field.kind === "date" || field.kind === "datetime") && resolveRange(v) ? undefined : "A period is yyyy-mm-dd..yyyy-mm-dd, or day, week, month or year +/- a number";
  const compares = operator === "is" || operator === "isNot" || operator === "gt" || operator === "lt" || operator === "before" || operator === "after";
  if (!compares) return undefined;
  if (field.kind === "checkbox" && !/^(true|false)$/i.test(v)) return "A checkbox is true or false";
  if (field.kind === "number" && !Number.isFinite(Number(v))) return "Not a number";
  if ((field.kind === "date" || field.kind === "datetime") && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return "A date is yyyy-mm-dd";
  return undefined;
}

/**
 * The values a new item needs to pass the reference rules of a filter ("Author is X" sets X), so
 * an item added to a filtered list shows up in it.
 */
export function filterPreset(collection: Collection, filters: FilterRule[]): Record<string, FieldValue> {
  const preset: Record<string, FieldValue> = {};
  for (const rule of filters) {
    const field = collection.fields.find((f) => f.id === rule.fieldId);
    if (!field || rule.operator !== "is" || !rule.value || rule.value.startsWith(PAGE_ITEM)) continue;
    if (field.kind === "item") preset[field.id] = rule.value;
    if (field.kind === "item_list") preset[field.id] = [...((preset[field.id] as string[] | undefined) ?? []), rule.value];
  }
  return preset;
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
  // A value that can't be compared (failing code, "maybe" for a checkbox) matches nothing.
  if (filterValueProblem(field, rule.operator, arg)) return false;
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
      else if (field.kind === "checkbox") equal = (value === true) === (arg.toLowerCase() === "true");
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
    case "between": {
      const day = dayOf(field, value);
      const period = resolveRange(arg);
      return !!day && !!period && day >= period.start && day <= period.end;
    }
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
  // {{ }} code not worked out yet (a reference field's choice filter: no page) is worked out here.
  const rules = resolveFilterValues(filters, null).flatMap((rule) => {
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
