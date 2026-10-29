// Merged collections: a block that lists several collections (native and remote alike) reads them as one read-only
// collection whose columns are the parts' fields merged by name (`mergeCollections`), plus Collection (which part a row
// came from), Title, Created and Updated. Its rows are the parts' rows seen through that mapping, so one chart can total two
// sources, one table list both. Nothing is stored: the block keeps the collections it lists and the columns merged by hand
// (ViewBlock.collectionIds, .merges); the merged collection is made when the block is shown, and the block fans each query out
// to the parts (views/useBlendResult.ts, domain/blendMerge.ts for the merging). Pure, storage-free.
//
// How the pieces fit:
//  * a column's type is that of the fields merged into it; a part field can be shown by it if `canShow` (the matrix);
//  * a native part's items become merged items in memory (`blendItem`) and the query runs over them as over any
//    collection's; a remote part is asked with the query rewritten to its columns (`partProjection`: the remote collection as
//    the merged columns, `sourceQuery` does the rest);
//  * a column a part has no field for is empty there (its rows match a rule on it only if the rule matches empty),
//    the Collection column has the part's name (a constant per part: `partConstants`).

import { formatDate } from "./fieldKinds";
import { blankField, fieldValue, META_FIELDS, NO_TITLE, pickableFields, type BlendPart, type Collection, type CollectionBlend, type FieldDef, type FieldKind, type FieldValue, type Item } from "./model";
import { rowItem, rowItemId, sourceColumn, type ConstantFields } from "./sources";
import type { SourceShape, SourceRow } from "../../../shared/sources";

/** The types a blend's own fields can have: the ones whose values read the same wherever they come from. */
export const BLEND_KINDS: readonly FieldKind[] = ["string", "markdown", "html", "number", "date", "datetime", "checkbox", "string_list"];

const TEXT: readonly FieldKind[] = ["string", "markdown", "html"];

/**
 * The type a part's field's values read as in a blend, null when they can't be shown in one (references point at the
 * part's own items, images are files, a checklist and a component field have no plain value). An AI field reads as the
 * text, number or Markdown it holds.
 */
export function readKind(field: Pick<FieldDef, "kind" | "output">): FieldKind | null {
  const kind = field.kind === "ai" ? (field.output === "number" ? "number" : field.output === "markdown" ? "markdown" : "string") : field.kind;
  return BLEND_KINDS.includes(kind) ? kind : null;
}

/**
 * Whether a blend field of type `to` can show a part field that reads as `from`: text, Markdown and HTML show each other
 * (the value as it is stored), a date also shows a date & time (its day, in the device's time zone), a date & time only
 * a date & time (a date has no time), the rest only their own type.
 */
export function canShow(to: FieldKind, from: FieldKind | null): boolean {
  if (!from) return false;
  if (TEXT.includes(to)) return TEXT.includes(from);
  if (to === "date") return from === "date" || from === "datetime";
  return to === from;
}

/** A part field's value as the blend's field of type `to` shows it (a date & time becomes its day). */
export function blendValue(from: FieldKind, to: FieldKind, value: FieldValue): FieldValue {
  if (to === "date" && from === "datetime" && typeof value === "string" && value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value.slice(0, 10) : formatDate(d);
  }
  return value;
}

/** A part field's name for pickers: with its type. */
const describe = (f: FieldDef) => `“${f.name}”`;

/** The fields of a part a column could show (those that read as a type of `BLEND_KINDS`; Created and Updated are the merged collection's own): a native part's, a remote part's columns. */
export function partFields(part: Collection): FieldDef[] {
  return part.fields.filter((f) => (part.source ? !!f.column && !!sourceColumn(part, f) : true) && readKind(f) !== null);
}

// --- Resolving a blend ------------------------------------------------------------------------------

/** Something wrong with a blend: its part is gone, a field it maps is gone or can't show it. */
export interface BlendProblem {
  /** The part's collection id (a collection that is gone: its id as stored). */
  part: string;
  /** The blend's field, when the problem is one mapping. */
  field?: string;
  message: string;
}

/** A part with its collection found and its mappings checked. */
export interface ResolvedPart {
  part: BlendPart;
  collection: Collection;
  /** What the Source field says of its rows: the collection's name. */
  label: string;
  /** By the blend's field id: the part's field it shows (only mappings that hold). */
  fields: Map<string, FieldDef>;
}

/** What a blend's fields and mappings look like to the checks (a collection, or a draft of one). */
export interface BlendLike {
  name?: string;
  pluralName?: string;
  fields: Pick<FieldDef, "id" | "name" | "kind">[];
  blend?: CollectionBlend | null;
}

/**
 * The parts of a blend that can be read, and what is wrong with the rest: a part whose collection is gone (or is a blend:
 * a blend is never made of blends), a mapping to a field that was removed or can't show the blend field's type. A part with a
 * wrong mapping still counts, that field read as none.
 */
export function resolveBlend(blend: BlendLike, collections: Collection[]): { parts: ResolvedPart[]; problems: BlendProblem[] } {
  const parts: ResolvedPart[] = [];
  const problems: BlendProblem[] = [];
  const fields = blend.fields.filter((f) => f.id !== blend.blend?.sourceField);
  for (const part of blend.blend?.parts ?? []) {
    const collection = collections.find((c) => c.id === part.collectionId);
    if (!collection) {
      problems.push({ part: part.collectionId, message: "A collection this blend is made of was deleted." });
      continue;
    }
    if (collection.blend) {
      problems.push({ part: part.collectionId, message: `${collection.pluralName} is a blend: a blend is made of collections, not of blends.` });
      continue;
    }
    const readable = new Map(partFields(collection).map((f) => [f.id, f]));
    const all = new Map(pickableFields(collection).map((f) => [f.id, f]));
    const mapped = new Map<string, FieldDef>();
    for (const f of fields) {
      const id = part.map[f.id];
      if (!id) continue;
      const theirs = readable.get(id);
      if (!theirs) {
        const there = all.get(id);
        problems.push({
          part: collection.id,
          field: f.id,
          message: there
            ? `“${f.name}” can't show ${describe(there)} of ${collection.pluralName}: fields of that type can't be in a blend.`
            : `“${f.name}” showed a field of ${collection.pluralName} that was removed.`,
        });
      } else if (!canShow(f.kind, readKind(theirs))) {
        problems.push({ part: collection.id, field: f.id, message: `“${f.name}” (${f.kind}) can't show ${describe(theirs)} of ${collection.pluralName} (${readKind(theirs)}).` });
      } else {
        mapped.set(f.id, theirs);
      }
    }
    parts.push({ part, collection, label: collection.pluralName, fields: mapped });
  }
  return { parts, problems };
}

/** Whether a blend has a remote part: its rows are then asked of the server a page at a time, and a date can't be grouped by month. */
export const hasRemotePart = (blend: Pick<Collection, "blend">, collections: Collection[]): boolean =>
  !!blend.blend?.parts.some((p) => !!collections.find((c) => c.id === p.collectionId)?.source);

// --- Rows ------------------------------------------------------------------------------------------

/** A blend row's id: the part's collection and the part's item (a remote part's row item id, domain/sources.ts rowItemId). */
export const blendItemId = (collectionId: string, itemId: string) => `${collectionId}:${itemId}`;

export { blendPath } from "./backlinks";

/** The values of a part's item or row as the blend's fields show them, plus the Source. */
function mappedValues(blend: Collection, part: ResolvedPart, read: (field: FieldDef) => FieldValue): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {};
  for (const f of blend.fields) {
    if (f.id === blend.blend?.sourceField) {
      values[f.id] = part.label;
      continue;
    }
    const theirs = part.fields.get(f.id);
    if (!theirs) continue;
    const v = blendValue(readKind(theirs)!, f.kind, read(theirs));
    if (v !== null && v !== undefined) values[f.id] = v;
  }
  return values;
}

/** A native part's item as a blend item. */
export function blendItem(blend: Collection, part: ResolvedPart, item: Item): Item {
  return {
    id: blendItemId(part.collection.id, item.id),
    collectionId: blend.id,
    spaceId: item.spaceId,
    values: mappedValues(blend, part, (f) => fieldValue(item, f)),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/**
 * A remote part as a collection of the blend's fields: each blend field it maps is a field showing the column of the
 * part's field (so `sourceQuery` and `rowItem` work in the blend's terms), the rest are left out. Titles follow the blend's.
 */
export function partProjection(blend: Collection, part: ResolvedPart): Collection {
  const fields = blend.fields.flatMap((f, position) => {
    const theirs = part.fields.get(f.id);
    return theirs?.column ? [blankField(f.id, f.name, f.kind, { collectionId: blend.id, column: theirs.column, position })] : [];
  });
  const title = blend.titleField;
  return {
    ...part.collection,
    id: blend.id,
    name: blend.name,
    pluralName: blend.pluralName,
    fields,
    blend: null,
    titleField: title === NO_TITLE || !title || fields.some((f) => f.id === title) ? (title ?? null) : NO_TITLE,
  };
}

/**
 * The fields a remote part's rows have the same value of: the Source (the part's name) and the blend's fields it doesn't map
 * (no value). Rules, grouping and sorting on them are settled without asking the source.
 */
export function partConstants(blend: Collection, part: ResolvedPart): ConstantFields {
  const constants: ConstantFields = new Map();
  for (const f of blend.fields) {
    if (f.id === blend.blend?.sourceField) constants.set(f.id, { field: f, value: part.label });
    else if (!part.fields.get(f.id)?.column) constants.set(f.id, { field: f, value: null });
  }
  // Rows of a source have no Created or Updated.
  for (const f of META_FIELDS) constants.set(f.id, { field: f, value: null });
  return constants;
}

/** A remote part's row as a blend item (`projection` is `partProjection`, `shape` its `sourceShape`). */
export function blendRowItem(blend: Collection, part: ResolvedPart, projection: Collection, shape: SourceShape, row: SourceRow): Item {
  const item = rowItem(projection, shape, row);
  const values: Record<string, FieldValue> = {};
  for (const f of blend.fields) {
    if (f.id === blend.blend?.sourceField) {
      values[f.id] = part.label;
      continue;
    }
    const theirs = part.fields.get(f.id);
    const v = theirs && item.values[f.id] !== undefined ? blendValue(readKind(theirs)!, f.kind, item.values[f.id]) : null;
    if (v !== null) values[f.id] = v;
  }
  return { id: blendItemId(part.collection.id, rowItemId(row.key)), collectionId: blend.id, spaceId: "", values, createdAt: "", updatedAt: "" };
}

// --- Merging collections ----------------------------------------------------------------------------

/** The id of the Collection column, and the start of every merged column's id (stable: blocks keep them in their layout, filters and sort). */
export const SOURCE_COLUMN = "merged:collection";
const COLUMN = "merged:";

/** Whether a field id is a merged column's. */
export const isMergedColumn = (id: string) => id.startsWith(COLUMN);

/** Columns merged by hand: differently named fields of the listed collections shown as one column (ViewBlock.merges). */
export interface ColumnMerge {
  id: string;
  /** The column's name. */
  name: string;
  /** The fields it shows: `<collection id>/<field id>`, at most one per collection. */
  fields: string[];
}

export const mergeRef = (collectionId: string, fieldId: string) => `${collectionId}/${fieldId}`;

/** Fields that read as a wider type come first, so a column takes the type the others can be shown as. */
const WIDTH: Partial<Record<FieldKind, number>> = { string: 0, date: 0 };

/** The kind a column of these fields has: the first (widest) one the others can all be shown as; null when there is none. */
function columnKind(kinds: FieldKind[]): FieldKind | null {
  return [...kinds].sort((a, b) => (WIDTH[a] ?? 1) - (WIDTH[b] ?? 1)).find((k) => kinds.every((o) => canShow(k, o))) ?? null;
}

/**
 * The collection a block listing several collections reads: its columns are the collections' fields merged by name (case
 * aside) where their types are compatible (`canShow`), and by hand (`merges`); a field only one has is a column of its own,
 * shown empty for the others; two fields of one name that can't be shown alike are separate columns, the later ones named
 * with their collection ("Total (Shop sales)"). Fields that can't be in one (references, images, checklists, component fields)
 * are left out. Always there: Collection (the part a row is from), Title, Created and Updated. A collection that is gone, or a
 * merge that lost a field, is a problem; the rest is merged.
 */
export function mergeCollections(ids: string[], collections: Collection[], merges: ColumnMerge[] = []): { collection: Collection; problems: BlendProblem[] } {
  const problems: BlendProblem[] = [];
  const parts: Collection[] = [];
  for (const id of [...new Set(ids)]) {
    const found = collections.find((c) => c.id === id);
    if (found && !found.blend) parts.push(found);
    else problems.push({ part: id, message: "A collection this block listed was deleted." });
  }
  const mergedId = `merged-${parts.map((c) => c.id).join("+")}`;
  interface Column { id: string; name: string; kinds: Map<string, { field: FieldDef; kind: FieldKind }> }
  const columns: Column[] = [];
  const byHand: Column[] = [];
  const taken = new Set<string>();
  const readable = (c: Collection) => new Map(partFields(c).map((f) => [f.id, f]));
  // By hand first.
  for (const m of merges) {
    const members = new Map<string, { field: FieldDef; kind: FieldKind }>();
    for (const ref of m.fields) {
      const at = ref.indexOf("/");
      const owner = parts.find((c) => c.id === ref.slice(0, at));
      if (!owner) continue; // its collection is gone or no longer listed: reported above or chosen away
      const field = readable(owner).get(ref.slice(at + 1));
      if (!field) problems.push({ part: owner.id, message: `The merged column “${m.name}” lost a field of ${owner.pluralName}.` });
      else if (!members.has(owner.id)) members.set(owner.id, { field, kind: readKind(field)! });
    }
    const kind = columnKind([...members.values()].map((x) => x.kind));
    if (members.size > 0 && !kind) problems.push({ part: "", message: `The merged column “${m.name}” has fields that can't be shown alike.` });
    if (members.size === 0 || !kind) continue;
    for (const [cid, x] of members) taken.add(mergeRef(cid, x.field.id));
    byHand.push({ id: `${COLUMN}${m.id}`, name: m.name, kinds: members });
  }
  // Then by name.
  const byName = new Map<string, { name: string; list: { owner: Collection; field: FieldDef; kind: FieldKind }[] }>();
  for (const owner of parts) {
    for (const field of partFields(owner)) {
      if (taken.has(mergeRef(owner.id, field.id))) continue;
      const key = field.name.trim().toLowerCase();
      const group = byName.get(key) ?? { name: field.name.trim(), list: [] };
      group.list.push({ owner, field, kind: readKind(field)! });
      byName.set(key, group);
    }
  }
  for (const [key, group] of byName) {
    const own: { column: Column; kind: FieldKind }[] = [];
    // Wider types first, so `string` takes Markdown and `date` a date & time.
    for (const m of [...group.list].sort((a, b) => (WIDTH[a.kind] ?? 1) - (WIDTH[b.kind] ?? 1))) {
      const into = own.find((c) => !c.column.kinds.has(m.owner.id) && canShow(c.kind, m.kind));
      if (into) into.column.kinds.set(m.owner.id, { field: m.field, kind: m.kind });
      else {
        const n = own.length;
        own.push({ kind: m.kind, column: { id: `${COLUMN}name:${key}${n ? `#${n}` : ""}`, name: n ? `${group.name} (${m.owner.pluralName})` : group.name, kinds: new Map([[m.owner.id, { field: m.field, kind: m.kind }]]) } });
      }
    }
    columns.push(...own.map((c) => c.column));
  }
  // After the others, the columns merged by hand; Collection last: the title is the first text field (a table's first column), and that is a collection's own text, not its name.
  columns.push(...byHand);
  const fields: FieldDef[] = [
    ...columns.map((c) => blankField(c.id, c.name, columnKind([...c.kinds.values()].map((x) => x.kind))!, { collectionId: mergedId })),
    blankField(SOURCE_COLUMN, "Collection", "string", { collectionId: mergedId }),
  ].map((f, position) => ({ ...f, position }));
  const collection: Collection = {
    id: mergedId,
    name: "Item",
    pluralName: parts.map((c) => c.pluralName).join(" + ") || "Items",
    icon: "Merge",
    description: "",
    fields,
    itemViews: [],
    spaceIds: null,
    titleField: null,
    blend: {
      sourceField: SOURCE_COLUMN,
      parts: parts.map((c) => ({ collectionId: c.id, map: Object.fromEntries(columns.flatMap((col) => (col.kinds.has(c.id) ? [[col.id, col.kinds.get(c.id)!.field.id]] : []))) })),
      problems,
    },
    createdAt: "",
    updatedAt: "",
  };
  return { collection, problems };
}

/** Fields of the listed collections that can be merged by hand into `column`'s partner: those of another collection that can be shown alike. */
export function mergeCandidates(field: FieldDef, owner: string, collections: Collection[]): { owner: Collection; field: FieldDef }[] {
  const kind = readKind(field);
  return collections.filter((c) => c.id !== owner).flatMap((c) => partFields(c).filter((f) => canShow(kind!, readKind(f)) || canShow(readKind(f)!, kind)).map((f) => ({ owner: c, field: f })));
}

/**
 * A view's (or page's) filter, written over the fields of the collection the view is of, for the merged collection a block reads:
 * each rule goes to the column that shows that field (Created, Updated and the item itself stay); a rule on a field no column
 * shows is left out. So the view's filter, its date period included, reaches a block that lists several collections.
 */
export function translateRules<R extends { fieldId: string }>(rules: R[], merged: Collection, home: Collection): R[] {
  const own = merged.blend?.parts.find((p) => p.collectionId === home.id);
  return rules.flatMap((rule) => {
    if (rule.fieldId.startsWith("$") || isMergedColumn(rule.fieldId)) return [rule];
    const column = own && Object.entries(own.map).find(([, field]) => field === rule.fieldId)?.[0];
    return column ? [{ ...rule, fieldId: column }] : [];
  });
}
