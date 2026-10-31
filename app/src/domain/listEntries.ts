// A list field's entries as a collection: a block can list them, filter, sort and group them like any items
// ("Books › Todo" grouped by Done). Virtual (`Collection.virtual: "list"`, `listOf`): made from the list field when
// the block is shown, never stored, read-only through `isReadOnly` (a checklist's Done is the one thing ticked in it:
// views/useItemActions.ts writes the entry back into its item's value).
//
// Rows, one per entry of every item of the collection (in the shown space):
//   checklist         <Book> (the item it is in), <Todo> (the entry's text), Done, Position
//   list of strings   <Book>, <Tags> (the entry), Position
//   list of numbers   <Book>, <Scores> (the entry, a number), Position
//   list of items     <Book>, Position, and the entry's own item's fields (its title, its values: group by its Status)
// <Book> is a reference to the item the entry is in, so an item page's block of it starts filtered to the page's item
// ("Book is this item") and a block can be grouped by it. Ids are `<item>~<index>` (a list of items: `~<entry's item>`
// after them); an entry opens its item's page at the field (a list of items: the entry's own item).
//
// Loaded by the database worker with domain/backlinks.ts: nothing here may touch the DOM.

import { checklistItems, itemString } from "./checklist";
import { numberList } from "./numberList";
import { blankField, type Collection, type FieldDef, type FieldValue, type Item, type ListSource } from "./model";

/** The id prefix of a list field's entries collection (`ViewBlock.collectionId`: `$list:<field id>`). */
export const LIST_PREFIX = "$list:";
export const listCollectionId = (fieldId: string) => `${LIST_PREFIX}${fieldId}`;
export const isListCollectionId = (id: string | null | undefined): id is string => !!id && id.startsWith(LIST_PREFIX);

/** The field kinds whose entries can be listed. */
export const LIST_KINDS: readonly ListSource["kind"][] = ["checklist", "string_list", "number_list", "item_list"];
const isListKind = (kind: string): kind is ListSource["kind"] => (LIST_KINDS as readonly string[]).includes(kind);

// The entries collection's own fields (a list of items adds its items' fields to them). Not `$…`: those are meta fields.
export const LIST_ITEM = "list-item";
export const LIST_VALUE = "list-value";
export const LIST_DONE = "list-done";
export const LIST_POSITION = "list-position";

/** Whether a field's entries can be listed: a list kind of a native collection (a list of items: of native items too). */
export function hasListEntries(owner: Collection, field: FieldDef, collections: Collection[]): boolean {
  if (!isListKind(field.kind) || owner.source || owner.virtual || owner.mergedFrom) return false;
  if (field.kind !== "item_list") return true;
  const target = collections.find((c) => c.id === field.targetCollectionId);
  return !!target && !target.source;
}

const made = new WeakMap<Collection, Map<string, { target: Collection | undefined; list: Collection }>>();

/**
 * The entries collection of a list field (the same object while the collection, field and a list of items' target are
 * unchanged: blocks memoize on it); undefined when the field isn't one whose entries can be listed.
 */
export function listCollection(owner: Collection, field: FieldDef, collections: Collection[]): Collection | undefined {
  if (!hasListEntries(owner, field, collections)) return undefined;
  const target = field.kind === "item_list" ? collections.find((c) => c.id === field.targetCollectionId) : undefined;
  const held = made.get(owner)?.get(field.id);
  if (held && held.target === target) return held.list;
  const id = listCollectionId(field.id);
  const own = (fid: string, name: string, kind: FieldDef["kind"], rest: Partial<FieldDef> = {}) => blankField(fid, name, kind, { collectionId: id, ...rest });
  const item = own(LIST_ITEM, owner.name, "item", { targetCollectionId: owner.id });
  const position = own(LIST_POSITION, "Position", "number");
  const fields: FieldDef[] =
    field.kind === "checklist"
      ? [item, own(LIST_VALUE, field.name, "string"), own(LIST_DONE, "Done", "checkbox", { toggleIcon: field.toggleIcon, strikeThrough: field.strikeThrough }), position]
      : field.kind === "item_list"
        ? [item, position, ...(target?.fields ?? []).map((f) => ({ ...f, collectionId: id }))]
        : [item, own(LIST_VALUE, field.name, field.kind === "number_list" ? "number" : "string"), position];
  const list: Collection = {
    id,
    name: `${owner.name} › ${field.name}`,
    pluralName: `${owner.pluralName} › ${field.name}`,
    icon: field.kind === "item_list" ? (target?.icon ?? owner.icon) : owner.icon,
    description: `The entries of ${owner.pluralName}' ${field.name}`,
    fields: fields.map((f, i) => ({ ...f, position: i })),
    itemViews: [],
    spaceIds: owner.spaceIds,
    titleField: field.kind === "item_list" ? (target?.titleField ?? null) : LIST_VALUE,
    virtual: "list",
    listOf: { collectionId: owner.id, fieldId: field.id, kind: field.kind as ListSource["kind"], targetCollectionId: target?.id ?? null },
    createdAt: owner.createdAt,
    updatedAt: owner.updatedAt,
  };
  const forOwner = made.get(owner) ?? new Map();
  forOwner.set(field.id, { target, list });
  made.set(owner, forOwner);
  return list;
}

/** The entries collection a block names (`$list:<field id>`), found among the collections' fields; undefined when it is gone. */
export function findListCollection(collections: Collection[], id: string): Collection | undefined {
  const fieldId = id.slice(LIST_PREFIX.length);
  for (const owner of collections) {
    const field = owner.fields.find((f) => f.id === fieldId);
    if (field) return listCollection(owner, field, collections);
  }
  return undefined;
}

/** The entries collections of these collections' list fields, in their order. */
export const listCollections = (collections: Collection[]): Collection[] =>
  collections.flatMap((owner) => owner.fields.flatMap((f) => listCollection(owner, f, collections) ?? []));

/** An entry row's id. */
export const entryId = (itemId: string, index: number, entryItem?: string) => `${itemId}~${index}${entryItem ? `~${entryItem}` : ""}`;

/** What an entry row's id names: its item, its place in the list, and a list of items' entry. */
export function parseEntryId(id: string): { itemId: string; index: number; entryItem: string | null } {
  const [itemId, index, entryItem] = id.split("~");
  return { itemId: itemId ?? "", index: Number(index ?? 0), entryItem: entryItem ?? null };
}

/** The route an entry row opens: its item's page at the field, or (a list of items) the entry's own item. */
export function entryPath(list: Pick<Collection, "listOf">, id: string): string {
  const source = list.listOf!;
  const { itemId, entryItem } = parseEntryId(id);
  return entryItem && source.targetCollectionId
    ? `/collections/${source.targetCollectionId}/items/${entryItem}`
    : `/collections/${source.collectionId}/items/${itemId}?field=${encodeURIComponent(source.fieldId)}`;
}

/**
 * Keeps entry rows' identity while what they are made from is unchanged (memoized rows render once): per item, its
 * rows, made again when the item (or, in a list of items, an entry's item) is another object.
 */
export type EntryMemo = WeakMap<Item, { targets: (Item | undefined)[]; rows: Item[] }>;

/**
 * The entry rows of a list collection: one per entry of every item, in the items' order and each list's. A list of items'
 * rows carry the entry's item's values (`targets`: its items, computed as shown; an entry whose item is gone is left out).
 */
export function entryItems(list: Collection, items: Item[], targets: Map<string, Item> | null, memo?: EntryMemo): Item[] {
  const source = list.listOf;
  if (!source) return [];
  return items.flatMap((owner) => {
    const value: FieldValue | undefined = owner.values[source.fieldId];
    const entries = Array.isArray(value) ? value : [];
    const linked = source.kind === "item_list" ? entries.map((e) => (typeof e === "string" ? targets?.get(e) : undefined)) : [];
    const held = memo?.get(owner);
    if (held && held.targets.length === linked.length && held.targets.every((t, i) => t === linked[i])) return held.rows;
    const base = { collectionId: list.id, spaceId: owner.spaceId };
    let rows: Item[];
    if (source.kind === "checklist") {
      rows = checklistItems(entries).map((e, i) => ({
        ...base, id: entryId(owner.id, i), createdAt: owner.createdAt, updatedAt: owner.updatedAt,
        values: { [LIST_ITEM]: owner.id, [LIST_VALUE]: e.text, [LIST_DONE]: e.done, [LIST_POSITION]: i + 1 },
      }));
    } else if (source.kind === "item_list") {
      rows = linked.flatMap((t, i) =>
        t ? [{ ...base, id: entryId(owner.id, i, t.id), createdAt: t.createdAt, updatedAt: t.updatedAt, values: { ...t.values, [LIST_ITEM]: owner.id, [LIST_POSITION]: i + 1 } }] : [],
      );
    } else {
      const values: (string | number)[] = source.kind === "number_list" ? numberList(entries) : entries.map(String);
      rows = values.map((v, i) => ({
        ...base, id: entryId(owner.id, i), createdAt: owner.createdAt, updatedAt: owner.updatedAt,
        values: { [LIST_ITEM]: owner.id, [LIST_VALUE]: v, [LIST_POSITION]: i + 1 },
      }));
    }
    memo?.set(owner, { targets: linked, rows });
    return rows;
  });
}

/**
 * A checklist value with one entry ticked or unticked (the entry at `index`, or, when the list changed meanwhile, the
 * first with the same text); null when the entry is no longer there.
 */
export function withEntryDone(value: FieldValue | undefined, index: number, text: string, done: boolean): string[] | null {
  const entries = checklistItems(value);
  const at = entries[index]?.text === text ? index : entries.findIndex((e) => e.text === text);
  if (at < 0) return null;
  return entries.map((e, i) => itemString(i === at ? { ...e, done } : e));
}
