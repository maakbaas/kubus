// Storage-agnostic domain model. Nothing in here knows about SQLite or Tauri.
//
// Terminology (UI and code alike): a Collection defines fields (e.g. Books), an Item is one of its
// entries (a particular book), a Space is a separate environment (e.g. Work, Private) whose items
// (and collection views) are kept apart while collections and components are shared (domain/spaces.ts).

import type { ComponentOutput } from "./components";
import type { ItemView } from "./fieldLayout";
import type { FilterRule } from "./query";
import type { SourceColumn, SourceTarget } from "../../../shared/sources";
import { formatDateTime } from "./fieldKinds";

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
  | "number_list"
  | "checklist"
  | "item_list"
  | "component"
  | "ai";

/**
 * string → string, markdown → GitHub Flavored Markdown source, html → HTML source (shown in a
 * sandboxed frame, like a component's HTML output), number → number,
 * date → "YYYY-MM-DD", datetime → ISO 8601 UTC string, checkbox → boolean,
 * image → file id (see Repository.putFile), item → id of the referenced item,
 * string_list → string[], number_list → number[], checklist → string[] of "[x] text" / "[ ] text" items
 * (domain/checklist.ts), item_list → item ids (string[])
 */
export type FieldValue = string | number | boolean | string[] | number[] | null;

/** A list value's entries as text (a list of numbers' too); [] for anything else. */
export const stringList = (value: FieldValue | undefined): string[] => (Array.isArray(value) ? value.map(String) : []);

/** Kinds that reference items of `FieldDef.targetCollectionId`. */
export const isReferenceKind = (kind: FieldKind) => kind === "item" || kind === "item_list";

export function valuesEqual(a: FieldValue | undefined, b: FieldValue | undefined): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return (a ?? null) === (b ?? null);
}

/** What an AI field's value is: plain text, a number or Markdown (the generated reply is made to fit). */
export type AiOutput = "string" | "number" | "markdown";

export interface FieldDef {
  id: string;
  collectionId: string;
  name: string;
  kind: FieldKind;
  /** For reference kinds: the collection whose items can be referenced. */
  targetCollectionId: string | null;
  /**
   * For component and AI fields: the shared component it shows (a component field's result is
   * computed, never stored; an AI field's is generated and stored). null when it has its own
   * (local) component: `code`.
   */
  componentId: string | null;
  /** For component and AI fields: its own (local) component's code, written in place; null = the shared `componentId`. */
  code: string | null;
  /**
   * For component and AI fields: its own component's output. An AI field always has one (text, a
   * number or Markdown, also with a shared component): what its stored values are, fixed once saved.
   */
  output: ComponentOutput | null;
  /** For its own component with HTML output that fills its box: that box's shape ("4/3"); null = 16:9. */
  frameRatio: string | null;
  /** For reference kinds: filters over the target's items limiting what can be chosen ([] = any). */
  choiceFilter: FilterRule[];
  /** For checkbox and checklist fields: an icon (outlined off, filled on) shown instead of the box; null = the box. */
  toggleIcon: string | null;
  /** For checkbox and checklist fields: a checked one's text is struck through. */
  strikeThrough: boolean;
  position: number;
  /**
   * In a remote collection (`Collection.source`): the source column whose values it shows; null
   * (or absent) for a field of its own there (a component field), and in every native collection.
   */
  column?: string | null;
  /** Set by editableField only: an AI field edited as the text, number or Markdown it holds (it keeps its AI icon). */
  editedAi?: true;
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
  /**
   * Where its items come from when they aren't stored here: a table or query of one of the server's
   * sources, read-only (domain/sources.ts). null (or absent) = its own items (a native collection).
   */
  source?: CollectionSource | null;
  /**
   * A collection that stores nothing: its items are made from elsewhere and only shown: Backlinks on item pages
   * (domain/backlinks.ts), a list field's entries (domain/listEntries.ts). Not in the store's list of collections.
   * null (or absent) = an ordinary one.
   */
  virtual?: "backlinks" | "list" | null;
  /** A list field's entries as a collection (domain/listEntries.ts, `virtual: "list"`): the field it is made from. Runtime only. */
  listOf?: ListSource | null;
  /**
   * A merged collection: what a block listing several collections reads (domain/mergedCollection.ts `mergeCollections`), made when the
   * block is shown, never stored. Its fields (columns) are mapped to a field of each part. null (or absent) = an ordinary one.
   */
  mergedFrom?: MergedFrom | null;
  /** The field its items' titles are (a field id: text, a number or a date, TITLE_KINDS), NO_TITLE for none; null (or absent) = the first text field with a value. */
  titleField?: string | null;
  /** Left out of the side nav's Collections / Remotes (its page and everything else unchanged); absent = shown there. */
  hiddenInNav?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What a list field's entries collection is made from (domain/listEntries.ts). */
export interface ListSource {
  /** The collection holding the list field. */
  collectionId: string;
  fieldId: string;
  kind: "checklist" | "string_list" | "number_list" | "item_list";
  /** A list of items: the collection its entries are items of. */
  targetCollectionId: string | null;
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
  /** AI fields: a fingerprint of the prompt each stored value was generated from (domain/ai.ts), by field id. */
  aiInputs?: Record<string, string>;
  /** AI fields: the values the user typed over (never made again by themselves), by field id. */
  aiEdited?: Record<string, true>;
  /** AI fields: when each stored value was generated (ISO), by field id. */
  aiGeneratedAt?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/** A remote collection's source: what it reads, through the Kubus server (shared/sources.ts). */
export interface CollectionSource {
  /** The server's name for the source, e.g. "CRM". */
  name: string;
  /** One of its tables, or a query in its language. */
  target: SourceTarget;
  /** The column that tells its rows apart (assumed unique): an item's id is made from it. */
  key: string;
  /** Its columns as last read from the source (their types and what they can do). */
  columns: SourceColumn[];
  /** Columns hidden in the collection's settings: they have no field and aren't given one again when the columns are read. */
  hiddenColumns?: string[];
  /** A time series' time column (SourceDescription.time): a new view of it starts with a date period on it. */
  time?: string;
}

/** One part of a merged collection: a collection, and the field of it each column shows. */
export interface MergedPart {
  /** The collection (native or remote) whose items (rows) are the part's. A collection is a part once. */
  collectionId: string;
  /** By the column's id: the id of the part's field it shows; null (or absent) = none (the part's rows have no value there). */
  map: Record<string, string | null>;
}

/** Something wrong with the collections a block lists: one is gone, a column merged by hand lost a field or can't show its fields alike. */
export interface MergeProblem {
  /** The collection's id ("" for a problem of a hand-merged column as a whole). */
  part: string;
  message: string;
}

/** What a merged collection is made of. */
export interface MergedFrom {
  parts: MergedPart[];
  /** The id of its built-in Collection column: a text field that names the part a row came from. */
  collectionField: string;
  /** What was wrong when it was made (a collection that is gone): shown by the block. */
  problems?: MergeProblem[];
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
  source?: CollectionSource | null;
  titleField?: string | null;
  hiddenInNav?: boolean;
  /** Order in the array is the field order. Ids are client-generated. */
  fields: FieldDraft[];
}

/** A collection as a draft for saving, its fields as they are. */
export const collectionDraft = ({ id, name, pluralName, icon, description, spaceIds, source, titleField, hiddenInNav, fields }: Collection): CollectionDraft => ({
  id,
  name,
  pluralName,
  icon,
  description,
  spaceIds,
  source: source ?? null,
  titleField: titleField ?? null,
  hiddenInNav: !!hiddenInNav,
  fields: fields.map(({ collectionId: _collectionId, position: _position, ...field }) => field),
});

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

/** The singular a plural most likely has (English): "Categories" → "Category", "Boxes" → "Box", "Authors" → "Author". */
export function suggestSingular(plural: string): string {
  const s = plural.trim();
  if (/[^aeiou]ies$/i.test(s)) return `${s.slice(0, -3)}y`;
  if (/(ss|x|z|ch|sh)es$/i.test(s)) return s.slice(0, -2);
  if (/[^s]s$/i.test(s)) return s.slice(0, -1);
  return s;
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

/** A field with nothing but its id, name and kind set (the rest empty): for drafts, tests and stand-ins. */
export const blankField = (id: string, name: string, kind: FieldKind, rest: Partial<FieldDef> = {}): FieldDef => ({
  id, collectionId: "", name, kind, targetCollectionId: null, componentId: null, code: null, output: null, frameRatio: null,
  choiceFilter: [], toggleIcon: null, strikeThrough: false, position: 0, column: null, ...rest,
});
const metaField = (id: string, name: string): FieldDef => blankField(id, name, "datetime");
/**
 * Created and updated: every item has them (ids are the query's pseudo fields). They aren't
 * stored as fields, but can be picked like one (columns, card and page fields, filters, grouping);
 * read-only, their value comes from the item itself.
 */
export const META_FIELDS: FieldDef[] = [metaField("$created", "Created"), metaField("$updated", "Updated")];
export const isMetaField = (f: { id: string }) => f.id.startsWith("$");
/**
 * The item itself, for filters only ("Item is This Book" on an item page: a block of just the page's
 * item, e.g. a gauge of one of its values). A reference to its own collection, valued with the item's
 * id; never a column, card or page field.
 */
export const SELF_FIELD = "$id";
export const selfField = (collection: Collection): FieldDef =>
  blankField(SELF_FIELD, "Item", "item", { collectionId: collection.id, targetCollectionId: collection.id });
/** The collection's fields plus created / updated (which a remote collection's rows don't have): what pickers offer. */
export const pickableFields = (collection: Pick<Collection, "source" | "fields">): FieldDef[] => (collection.source ? collection.fields : [...collection.fields, ...META_FIELDS]);
/** A field's value on an item (created / updated included). */
export function fieldValue(item: Item, field: FieldDef): FieldValue {
  if (field.id === "$created") return item.createdAt;
  if (field.id === "$updated") return item.updatedAt;
  if (field.id === SELF_FIELD) return item.id;
  return item.values[field.id] ?? null;
}

/** The field as its value is edited: an AI field is edited as text, a number or Markdown, by its output. */
export function editableField(field: FieldDef): FieldDef {
  if (field.kind !== "ai") return field;
  return { ...field, editedAi: true, kind: field.output === "number" ? "number" : field.output === "markdown" ? "markdown" : "string" };
}

/** `titleField` of a collection whose items have no title (they are called by the collection's name). */
export const NO_TITLE = "none";

/** What a chosen title field can be: a field whose value reads as one line (automatic titles are text fields only). */
export const TITLE_KINDS: readonly FieldKind[] = ["string", "number", "date", "datetime"];
export const canBeTitle = (f: Pick<FieldDef, "kind">) => TITLE_KINDS.includes(f.kind);

/**
 * The fields an item's title can come from, in order: the collection's title field, none (NO_TITLE),
 * else (not set, or its field gone) every text field: the first with a value is the title.
 */
export function titleFields<F extends Pick<FieldDef, "id" | "kind">>(collection: { titleField?: string | null; fields: F[]; mergedFrom?: Pick<MergedFrom, "collectionField"> | null }): F[] {
  if (collection.titleField === NO_TITLE) return [];
  const chosen = collection.fields.find((f) => f.id === collection.titleField && canBeTitle(f));
  // A merged collection's Collection column names the part a row came from, it doesn't call the row (unless chosen as the title).
  return chosen ? [chosen] : collection.fields.filter((f) => f.kind === "string" && f.id !== collection.mergedFrom?.collectionField);
}

/** A title field's value as the title ("" for none): text as it is, a number, a date as shown. */
export function titleText(field: Pick<FieldDef, "kind">, value: FieldValue | undefined): string {
  if (field.kind === "number") return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  if (typeof value !== "string" || value.trim() === "") return "";
  return field.kind === "datetime" ? formatDateTime(value) : value;
}

/** The field that provides an item's label: the first of its title fields with a value (titleFields). */
export function labelField(collection: Collection, item: Item): FieldDef | undefined {
  return titleFields(collection).find((f) => titleText(f, item.values[f.id]) !== "");
}

/** The title field edited as the title (on an item page): a text one; a number or date title is edited among the fields. */
export function editedTitleField(collection: Collection, item: Item): FieldDef | undefined {
  const field = labelField(collection, item);
  return field?.kind === "string" ? field : undefined;
}

/**
 * Whether an item is struck through where it is listed (its title on cards, in table rows): one of
 * its checkbox fields with "Strike through the item when checked" is checked.
 */
export const isStruckThrough = (collection: Collection, item: Item): boolean =>
  collection.fields.some((f) => f.kind === "checkbox" && f.strikeThrough && item.values[f.id] === true);

/** The label of an item without a label field value. */
export const untitledLabel = (collection: Collection): string => collection.name;

/** Human label for an item, e.g. in reference pickers and headings. */
export function itemLabel(collection: Collection, item: Item): string {
  const field = labelField(collection, item);
  return field ? titleText(field, item.values[field.id]) : untitledLabel(collection);
}

/** An item's label as stored (see Repository.listLabels): null when it has no label field value. */
export interface ItemLabel {
  id: string;
  label: string | null;
  /** Labels are read across spaces (a reference may point into another one); pickers offer their own space's. */
  spaceId: string;
}
