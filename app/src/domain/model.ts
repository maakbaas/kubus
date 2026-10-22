// Storage-agnostic domain model. Nothing in here knows about SQLite or Tauri.
//
// Terminology: in the UI an ObjectType is called a "type" (e.g. Book) and an
// ObjectInstance an "object" (a particular book).

import type { ObjectView } from "./fieldLayout";
import type { FilterRule } from "./query";

export type FieldKind =
  | "string"
  | "markdown"
  | "number"
  | "date"
  | "datetime"
  | "checkbox"
  | "image"
  | "object"
  | "string_list"
  | "checklist"
  | "object_list"
  | "template";

/**
 * string → string, markdown → GitHub Flavored Markdown source, number → number,
 * date → "YYYY-MM-DD", datetime → ISO 8601 UTC string, checkbox → boolean,
 * image → file id (see Repository.putFile), object → id of the referenced object,
 * string_list → string[], checklist → string[] of "[x] text" / "[ ] text" items (domain/checklist.ts),
 * object_list → object ids (string[])
 */
export type FieldValue = string | number | boolean | string[] | null;

/** Kinds that reference objects of `FieldDef.targetTypeId`. */
export const isReferenceKind = (kind: FieldKind) => kind === "object" || kind === "object_list";

export function valuesEqual(a: FieldValue | undefined, b: FieldValue | undefined): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return (a ?? null) === (b ?? null);
}

/** What feeds a template field's variable: a field of the object, or a fixed text / number. */
export type TemplateArg = { field: string } | { value: string };

export interface FieldDef {
  id: string;
  typeId: string;
  name: string;
  kind: FieldKind;
  /** For reference kinds: the type whose objects can be referenced. */
  targetTypeId: string | null;
  /** For template fields: the template whose result is shown (computed, never stored). */
  templateId: string | null;
  /** For template fields: what feeds each of the template's variables (a field, or a fixed value). */
  templateArgs: Record<string, TemplateArg>;
  /** For reference kinds: filters over the target's objects limiting what can be chosen ([] = any). */
  choiceFilter: FilterRule[];
  /** For checkbox and checklist fields: an icon (outlined off, filled on) shown instead of the box; null = the box. */
  toggleIcon: string | null;
  position: number;
}

export interface ObjectType {
  id: string;
  /** Singular, e.g. "Author" (one object). */
  name: string;
  /** Plural, e.g. "Authors" (lists, navigation). */
  pluralName: string;
  /** Carbon icon name (an @carbon/icons-react export), or null for the default icon. */
  icon: string | null;
  description: string;
  fields: FieldDef[];
  /** Object page layouts (the starred one is used unless an object is pinned to another). */
  objectViews: ObjectView[];
  createdAt: string;
  updatedAt: string;
}

export interface ObjectInstance {
  id: string;
  typeId: string;
  /** Keyed by field id. Missing key = no value. */
  values: Record<string, FieldValue>;
  /** The object view this object is pinned to, instead of its type's default. */
  objectViewId?: string | null;
  /** Values rendered from their own {{ }} sections (withComputed): the typed source, for editing. */
  sources?: Record<string, FieldValue>;
  createdAt: string;
  updatedAt: string;
}

/** A field as edited and saved: the field without what the repository fills in (its type, its place). */
export type FieldDraft = Omit<FieldDef, "typeId" | "position">;

/** Whole-type edit: the repository diffs `fields` against what is stored. */
export interface ObjectTypeDraft {
  id: string;
  name: string;
  pluralName: string;
  icon: string | null;
  description: string;
  /** Order in the array is the field order. Ids are client-generated. */
  fields: FieldDraft[];
}

/** An object as a draft for saving, its fields as they are. */
export const typeDraft = ({ id, name, pluralName, icon, description, fields }: ObjectType): ObjectTypeDraft => ({
  id,
  name,
  pluralName,
  icon,
  description,
  fields: fields.map(({ typeId: _typeId, position: _position, ...field }) => field),
});

/** A template field's stored variable mapping (JSON): field ids (older form) or TemplateArgs. */
export function parseTemplateArgs(json: string | null): Record<string, TemplateArg> {
  if (!json) return {};
  try {
    const out: Record<string, TemplateArg> = {};
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
export const countLabel = (type: ObjectType, n: number) => `${n} ${n === 1 ? type.name : type.pluralName}`;

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
  id, typeId: "", name, kind: "datetime", targetTypeId: null, templateId: null, templateArgs: {}, choiceFilter: [], toggleIcon: null, position: 0,
});
/**
 * Created and updated: every object has them (ids are the query's pseudo fields). They aren't
 * stored as fields, but can be picked like one (columns, card and page fields, filters, grouping);
 * read-only, their value comes from the object itself.
 */
export const META_FIELDS: FieldDef[] = [metaField("$created", "Created"), metaField("$updated", "Updated")];
export const isMetaField = (f: { id: string }) => f.id.startsWith("$");
/** The type's fields plus created / updated: what pickers offer. */
export const pickableFields = (type: ObjectType): FieldDef[] => [...type.fields, ...META_FIELDS];
/** A field's value on an object (created / updated included). */
export function fieldValue(object: ObjectInstance, field: FieldDef): FieldValue {
  if (field.id === "$created") return object.createdAt;
  if (field.id === "$updated") return object.updatedAt;
  return object.values[field.id] ?? null;
}

/** The field that provides an object's label: its first non-empty string field. */
export function labelField(type: ObjectType, object: ObjectInstance): FieldDef | undefined {
  return type.fields.find((f) => {
    const v = object.values[f.id];
    return f.kind === "string" && typeof v === "string" && v.trim() !== "";
  });
}

/** The label of an object without a label field value. */
export const untitledLabel = (type: ObjectType): string => type.name;

/** Human label for an object, e.g. in reference pickers and headings. */
export function objectLabel(type: ObjectType, object: ObjectInstance): string {
  const field = labelField(type, object);
  return field ? String(object.values[field.id]) : untitledLabel(type);
}

/** An object's label as stored (see Repository.listLabels): null when it has no label field value. */
export interface ObjectLabel {
  id: string;
  label: string | null;
}
