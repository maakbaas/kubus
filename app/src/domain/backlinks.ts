// Links between items, and their backlinks.
//
// What links to what is kept in the synced table `item_links` (docs/data-model.md "Item links"):
// one row per (source item, source field) with the items that field's value points at, kept by
// triggers on field_values from `linkTargets` below and healed after a first download (SyncEngine). The
// "Backlinks" collection (`backlinksCollection`) is a virtual one: the items linking to the item of
// the page it is on, one row per link, read-only like a remote collection. It is offered only in the
// collection picker of item page blocks; every block type shows it like any collection's items.

import { blankField, META_FIELDS, type Collection, type FieldKind, type Item } from "./model";

/** An item a value points at: a native item's id, or a remote row's item id (domain/sources.ts rowItemId). */
export interface LinkTarget {
  item: string;
  collection: string;
}

/** Item links in Markdown / HTML: `#/collections/<collection>/items/<item>` (the app's own routes, domain/links.ts). */
const ITEM_LINK = /(?<![^\s("'<])#\/collections\/([A-Za-z0-9_-]+)\/items\/([A-Za-z0-9_-]+)/g;

/** The kinds whose text can hold links to items. */
const TEXT_KINDS: ReadonlySet<string> = new Set<FieldKind>(["markdown", "html", "ai"]);

/** Every kind whose values can link to items: `linkTargets` gives `[]` for any other (the heal skips them: data/schema.ts). */
export const LINK_KINDS = ["item", "item_list", ...TEXT_KINDS] as const;

/**
 * The items a stored value points at, as the canonical JSON `item_links.targets` holds: an array of
 * `{ item, collection }` sorted by collection then item, each once. Keys are in the order Postgres'
 * jsonb gives them back (shorter first), so a row that went through the server reads the same text.
 * A reference field points at its target collection's item(s); Markdown, HTML and AI text at the
 * items it links to (to a field, view or block of an item too: the item counts, `/items/new` is
 * the new item form). `[]` for any other kind.
 */
export function linkTargets(kind: unknown, targetCollectionId: unknown, text: unknown, ref: unknown, json: unknown): string {
  const found = new Map<string, LinkTarget>();
  const add = (collection: string, item: string) => found.set(`${collection}\u0000${item}`, { item, collection });
  if (kind === "item") {
    if (typeof targetCollectionId === "string" && typeof ref === "string" && ref) add(targetCollectionId, ref);
  } else if (kind === "item_list") {
    if (typeof targetCollectionId === "string" && typeof json === "string") {
      try {
        const ids: unknown = JSON.parse(json);
        if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string" && id) add(targetCollectionId, id);
      } catch {
        // not a list: no links
      }
    }
  } else if (typeof kind === "string" && TEXT_KINDS.has(kind) && typeof text === "string" && text.includes("#/collections/")) {
    for (const m of text.matchAll(ITEM_LINK)) if (m[2] !== "new") add(m[1], m[2]);
  }
  const sorted = [...found.values()].sort((a, b) => (a.collection < b.collection ? -1 : a.collection > b.collection ? 1 : a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
  return JSON.stringify(sorted);
}

/** `item_links.targets` as a list (empty for anything unreadable). */
export function parseTargets(json: string | null): LinkTarget[] {
  try {
    const list: unknown = JSON.parse(json ?? "[]");
    return Array.isArray(list) ? list.filter((t): t is LinkTarget => !!t && typeof t.item === "string" && typeof t.collection === "string") : [];
  } catch {
    return [];
  }
}

// --- The Backlinks collection ---------------------------------------------------------------------

/** The id of the virtual collection a block lists (`ViewBlock.collectionId`). */
export const BACKLINKS_ID = "$backlinks";

const field = (id: string, name: string, kind: FieldKind) => blankField(id, name, kind, { collectionId: BACKLINKS_ID });

/**
 * Items linking to the page's item. Item is a link to the linking item (Markdown, so it reads as one
 * in tables, cards and components), Title its label, Collection the one it is in, Field the field
 * its link is in (the "via"); Created and Updated are the linking item's.
 */
export const backlinksCollection: Collection = {
  id: BACKLINKS_ID,
  name: "Backlink",
  pluralName: "Backlinks",
  icon: "Link",
  description: "The items that link to this one",
  fields: [field("item", "Item", "markdown"), field("title", "Title", "string"), field("collection", "Collection", "string"), field("field", "Field", "string")].map((f, position) => ({ ...f, position })),
  itemViews: [],
  spaceIds: null,
  titleField: "title",
  virtual: "backlinks",
  createdAt: "",
  updatedAt: "",
};

/** The fields a new Backlinks block shows: the title already is the link, so not Item (Title column) again. */
export const BACKLINKS_FIELDS = ["title", "collection", "field", META_FIELDS[1].id];

/** The virtual collections, offered in the collection picker of item page blocks (they are not in the store's list). */
export const VIRTUAL_COLLECTIONS: Collection[] = [backlinksCollection];

/** A collection by id among the stored ones and the virtual ones. */
export const findCollection = (collections: Collection[], id: string | null | undefined): Collection | undefined =>
  collections.find((c) => c.id === id) ?? VIRTUAL_COLLECTIONS.find((c) => c.id === id);

/** One link to the page's item: where it is (read from item_links), joined with its source item. */
export interface Backlink {
  sourceCollectionId: string;
  sourceItemId: string;
  fieldId: string;
  itemCreatedAt: string;
  itemUpdatedAt: string;
}

/** A backlink's item id: the linking item and the field its link is in (one row per link). */
export const backlinkId = (b: Pick<Backlink, "sourceCollectionId" | "sourceItemId" | "fieldId">) => `${b.sourceCollectionId}:${b.sourceItemId}:${b.fieldId}`;

/** The route of the item a backlink row stands for (its linking item). */
export function backlinkPath(id: string): string {
  const [collection, item] = id.split(":");
  return `/collections/${collection}/items/${item}`;
}

/** The route of the item or row a merged collection's row stands for (its id: the part's collection and the part's item, domain/blend.ts). Here, not in blend.ts: the database worker imports this file and must not load the rest. */
export function blendPath(id: string): string {
  const at = id.indexOf(":");
  return `/collections/${id.slice(0, at)}/items/${id.slice(at + 1)}`;
}

/** Where an item opens: its own page, a backlink row the linking item's, a blend's row its part's item or row. */
export const itemPath = (collection: Pick<Collection, "id" | "virtual" | "blend">, item: Pick<Item, "id">): string =>
  collection.virtual === "backlinks" ? backlinkPath(item.id) : collection.blend ? blendPath(item.id) : `/collections/${collection.id}/items/${item.id}`;

const escapeLabel = (text: string) => text.replace(/[\\[\]]/g, "\\$&");

/**
 * The Backlinks collection's items for these links: `labels` are the linking items' labels (null: none, the
 * collection's name stands in for it, as everywhere); a link whose collection or field is gone is left out.
 */
export function backlinkItems(links: Backlink[], collections: Collection[], labels: Map<string, string | null>): Item[] {
  return links.flatMap((b) => {
    const source = collections.find((c) => c.id === b.sourceCollectionId);
    const via = source?.fields.find((f) => f.id === b.fieldId);
    if (!source || !via) return [];
    const title = labels.get(b.sourceItemId) ?? source.name;
    return [
      {
        id: backlinkId(b),
        collectionId: BACKLINKS_ID,
        spaceId: "",
        values: { item: `[${escapeLabel(title)}](#${itemPath(source, { id: b.sourceItemId })})`, title, collection: source.pluralName, field: via.name },
        createdAt: b.itemCreatedAt,
        updatedAt: b.itemUpdatedAt,
      },
    ];
  });
}
