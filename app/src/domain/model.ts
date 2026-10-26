// Storage-agnostic domain model. Nothing in here knows about SQLite or Tauri.
//
// Terminology (UI and code alike): a Collection defines fields (e.g. Books), an Item is one of its
// entries (a particular book), a Space is a separate environment (e.g. Work, Private) whose items
// (and collection views) are kept apart while collections and components are shared (domain/spaces.ts).

import type { ItemView } from "./fieldLayout";
import type { FilterRule } from "./query";

export type FieldKind =
  | "string"
  | "markdown"
  | "html"
  | "number"
  | "date"
  | "datetime"
  | "checkbox"
  | "image"
  | "item"
  | "string_list"
  | "checklist"
  | "item_list"
  | "component"
  | "ai";

/**
 * string → string, markdown → GitHub Flavored Markdown source, html → HTML source (shown in a
 * sandboxed frame, like a component's HTML output), number → number,
 * date → "YYYY-MM-DD", datetime → ISO 8601 UTC string, checkbox → boolean,
 * image → file id (see Repository.putFile), item → id of the referenced item,
 * string_list → string[], checklist → string[] of "[x] text" / "[ ] text" items (domain/checklist.ts),
 * item_list → item ids (string[])
 */
export type FieldValue = string | number | boolean | string[] | null;

/** Kinds that reference items of `FieldDef.targetCollectionId`. */
export const isReferenceKind = (kind: FieldKind) => kind === "item" || kind === "item_list";

export function valuesEqual(a: FieldValue | undefined, b: FieldValue | undefined): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return (a ?? null) === (b ?? null);
}

/** What an AI field's value is: plain text, a number or Markdown (the generated reply is made to fit). */
export type AiOutput = "string" | "number" | "markdown";

/** What feeds a component field's variable: a field of the item, or a fixed text / number. */
export type ComponentArg = { field: string } | { value: string };

export interface FieldDef {
  id: string;
  collectionId: string;
  name: string;
  kind: FieldKind;
  /** For reference kinds: the collection whose items can be referenced. */
  targetCollectionId: string | null;
  /** For component fields: the component whose result is shown (computed, never stored). */
  componentId: string | null;
  /** For component fields: what feeds each of the component's variables (a field, or a fixed value). */
  componentArgs: Record<string, ComponentArg>;
  /** For reference kinds: filters over the target's items limiting what can be chosen ([] = any). */
  choiceFilter: FilterRule[];
  /** For checkbox and checklist fields: an icon (outlined off, filled on) shown instead of the box; null = the box. */
  toggleIcon: string | null;
  /** For checkbox and checklist fields: a checked one's text is struck through. */
  strikeThrough: boolean;
  /** For AI fields: the prompt (Markdown with {{ }} sections over $item), see domain/ai.ts. */
  aiPrompt: string | null;
  /** For AI fields: what the generated value is. */
  aiOutput: AiOutput | null;
  position: number;
}

export interface Collection {
  id: string;
  /** Singular, e.g. "Author" (one item). */
  name: string;
  /** Plural, e.g. "Authors" (lists, navigation). */
  pluralName: string;
  /** Carbon icon name (an @carbon/icons-react export), or null for the default icon. */
  icon: string | null;
  description: string;
  fields: FieldDef[];
  /** Item page layouts (the starred one is used unless an item is pinned to another). */
  itemViews: ItemView[];
  /** The spaces it is shown in; null = every space. */
  spaceIds: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface Item {
  id: string;
  collectionId: string;
  /** The space it belongs to (and is shown in). */
  spaceId: string;
  /** Keyed by field id. Missing key = no value. */
  values: Record<string, FieldValue>;
  /** The item view this item is pinned to, instead of its collection's default. */
  itemViewId?: string | null;
  /** Values rendered from their own {{ }} sections (withComputed): the typed source, for editing. */
  sources?: Record<string, FieldValue>;
  /** AI fields: a fingerprint of the prompt each stored value was generated from (domain/ai.ts), by field id. */
  aiInputs?: Record<string, string>;
  /** AI fields: the values the user typed over (never made again by themselves), by field id. */
  aiEdited?: Record<string, true>;
  /** AI fields: when each stored value was generated (ISO), by field id. */
  aiGeneratedAt?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/** A field as edited and saved: the field without what the repository fills in (its collection, its place). */
export type FieldDraft = Omit<FieldDef, "collectionId" | "position">;

/** Whole-collection edit: the repository diffs `fields` against what is stored. */
export interface CollectionDraft {
  id: string;
  name: string;
  pluralName: string;
  icon: string | null;
  description: string;
  spaceIds: string[] | null;
  /** Order in the array is the field order. Ids are client-generated. */
  fields: FieldDraft[];
}

/** A collection as a draft for saving, its fields as they are. */
export const collectionDraft = ({ id, name, pluralName, icon, description, spaceIds, fields }: Collection): CollectionDraft => ({
  id,
  name,
  pluralName,
  icon,
  description,
  spaceIds,
  fields: fields.map(({ collectionId: _collectionId, position: _position, ...field }) => field),
});

/** A component field's stored variable mapping (JSON): field ids (older form) or ComponentArgs. */
export function parseComponentArgs(json: string | null): Record<string, ComponentArg> {
  if (!json) return {};
  try {
    const out: Record<string, ComponentArg> = {};
    for (const [k, v] of Object.entries(JSON.parse(json) as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = { field: v };
      else if (v && typeof v === "object" && "field" in v && typeof v.field === "string") out[k] = { field: v.field };
      else if (v && typeof v === "object" && "value" in v && typeof v.value === "string") out[k] = { value: v.value };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * A name for a copy, numbered like new views: "Name" becomes "Name 2" (then "Name 3", …, the
 * first one not taken); copying "Name 2" continues that series rather than making "Name 2 2".
 */
export function nextName(name: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  const base = name.replace(/ \d+$/, "");
  let n = 2;
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** The first free name among "New", "New 2", "New 3", …: for a view added with "+". */
export function newName(taken: Iterable<string>): string {
  const names = new Set(taken);
  let name = "New";
  for (let n = 2; names.has(name); n++) name = `New ${n}`;
  return name;
}

/** "1 Author", "3 Authors". */
export const countLabel = (collection: Collection, n: number) => `${n} ${n === 1 ? collection.name : collection.pluralName}`;

/** Naive English plural, only used to prefill the plural name field. */
export function suggestPlural(singular: string): string {
  const s = singular.trim();
  if (!s) return "";
  if (/[^aeiou]y$/i.test(s)) return `${s.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(s)) return `${s}es`;
  return `${s}s`;
}

export const newId = (): string => crypto.randomUUID();
// Timestamps are what sync merges by (newest wins). They never go back below a stamp that was
// seen, e.g. one received from a device whose clock runs ahead (a cheap stand-in for a hybrid
// logical clock), and every stamp of a session is later than the one before.
let lastStamp = 0;
export const now = (): string => new Date((lastStamp = Math.max(Date.now(), lastStamp + 1))).toISOString();
/** Records a timestamp received from elsewhere, so later local stamps are newer than it. */
export const observeStamp = (iso: string) => {
  const t = Date.parse(iso);
  if (t > lastStamp) lastStamp = t;
};

const metaField = (id: string, name: string): FieldDef => ({
  id, collectionId: "", name, kind: "datetime", targetCollectionId: null, componentId: null, componentArgs: {}, choiceFilter: [], toggleIcon: null, strikeThrough: false, aiPrompt: null, aiOutput: null, position: 0,
});
/**
 * Created and updated: every item has them (ids are the query's pseudo fields). They aren't
 * stored as fields, but can be picked like one (columns, card and page fields, filters, grouping);
 * read-only, their value comes from the item itself.
 */
export const META_FIELDS: FieldDef[] = [metaField("$created", "Created"), metaField("$updated", "Updated")];
export const isMetaField = (f: { id: string }) => f.id.startsWith("$");
/** The collection's fields plus created / updated: what pickers offer. */
export const pickableFields = (collection: Collection): FieldDef[] => [...collection.fields, ...META_FIELDS];
/** A field's value on an item (created / updated included). */
export function fieldValue(item: Item, field: FieldDef): FieldValue {
  if (field.id === "$created") return item.createdAt;
  if (field.id === "$updated") return item.updatedAt;
  return item.values[field.id] ?? null;
}

/** The field as its value is edited: an AI field is edited as text, a number or Markdown, by its output. */
export function editableField(field: FieldDef): FieldDef {
  if (field.kind !== "ai") return field;
  return { ...field, kind: field.aiOutput === "number" ? "number" : field.aiOutput === "markdown" ? "markdown" : "string" };
}

/** The field that provides an item's label: its first non-empty string field. */
export function labelField(collection: Collection, item: Item): FieldDef | undefined {
  return collection.fields.find((f) => {
    const v = item.values[f.id];
    return f.kind === "string" && typeof v === "string" && v.trim() !== "";
  });
}

/** The label of an item without a label field value. */
export const untitledLabel = (collection: Collection): string => collection.name;

/** Human label for an item, e.g. in reference pickers and headings. */
export function itemLabel(collection: Collection, item: Item): string {
  const field = labelField(collection, item);
  return field ? String(item.values[field.id]) : untitledLabel(collection);
}

/** An item's label as stored (see Repository.listLabels): null when it has no label field value. */
export interface ItemLabel {
  id: string;
  label: string | null;
  /** Labels are read across spaces (a reference may point into another one); pickers offer their own space's. */
  spaceId: string;
}
