// Items as the API shows and takes them: values by field name (computed ones included, read
// only), each checked against its field's kind. Fields can be named by id or name (any case).

import { HttpError } from "../../../shared/router";
import { FILE_ID } from "../../../shared/files";
import { itemString, parseItem } from "../domain/checklist";
import { itemLabel, type Collection, type FieldDef, type FieldValue, type Item } from "../domain/model";

/** An item as the API returns it. */
export interface ApiItem {
  id: string;
  collection: string;
  collectionId: string;
  spaceId: string;
  itemViewId: string | null;
  label: string;
  createdAt: string;
  updatedAt: string;
  values: Record<string, FieldValue>;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A field of `collection` by id or name; 404 when there is none. */
export function fieldOf(collection: Collection, name: string): FieldDef {
  const field = collection.fields.find((f) => f.id === name) ?? collection.fields.find((f) => same(f.name, name));
  if (!field) throw new HttpError(404, `${collection.name} has no field “${name}”`);
  return field;
}

/** An item (with its computed values) for the API. */
export function itemOut(collection: Collection, item: Item): ApiItem {
  const values: Record<string, FieldValue> = {};
  for (const f of collection.fields) values[f.name] = item.values[f.id] ?? null;
  return {
    id: item.id,
    collection: collection.name,
    collectionId: collection.id,
    spaceId: item.spaceId,
    itemViewId: item.itemViewId ?? null,
    label: itemLabel(collection, item),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    values,
  };
}

/** Checks that items exist in a collection (references); the ids it doesn't hold. */
export type ItemsExist = (collectionId: string, ids: string[]) => Promise<string[]>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One value as given, checked against its field's kind and turned into its stored form. */
async function valueIn(collection: Collection, field: FieldDef, raw: unknown, exist: ItemsExist): Promise<FieldValue> {
  const bad = (what: string): never => {
    throw new HttpError(400, `“${field.name}” of ${collection.name} takes ${what}`);
  };
  if (raw === null || raw === undefined) return null;
  switch (field.kind) {
    case "component":
      throw new HttpError(400, `“${field.name}” of ${collection.name} is computed by a component: it can't be written`);
    case "string":
    case "markdown":
    case "html":
      return typeof raw === "string" ? raw : bad("text");
    case "number":
      return typeof raw === "number" && Number.isFinite(raw) ? raw : bad("a number");
    case "checkbox":
      return typeof raw === "boolean" ? raw : bad("true or false");
    case "date":
      return typeof raw === "string" && DATE.test(raw) && !Number.isNaN(Date.parse(raw)) ? raw : bad("a date (YYYY-MM-DD)");
    case "datetime": {
      const t = typeof raw === "string" ? Date.parse(raw) : NaN;
      return Number.isNaN(t) ? bad("a date and time (ISO 8601)") : new Date(t).toISOString();
    }
    case "image":
      return typeof raw === "string" && FILE_ID.test(raw) ? raw : bad("a file id (from POST /api/v1/files)");
    case "ai":
      // Typed over the generated value, as in the app (it is then not made again by itself).
      if (field.aiOutput === "number") return typeof raw === "number" && Number.isFinite(raw) ? raw : bad("a number");
      return typeof raw === "string" ? raw : bad("text");
    case "string_list":
      return Array.isArray(raw) && raw.every((x) => typeof x === "string") ? raw : bad("a list of texts");
    case "checklist": {
      // "[x] text" / "[ ] text" as stored, or { text, done }.
      if (!Array.isArray(raw)) return bad("a list of { text, done } items");
      return raw.map((x) => {
        if (typeof x === "string") return itemString(parseItem(x));
        if (x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string") {
          return itemString({ text: (x as { text: string }).text, done: (x as { done?: unknown }).done === true });
        }
        return bad("a list of { text, done } items");
      });
    }
    case "item":
    case "item_list": {
      const ids = field.kind === "item" ? [raw] : raw;
      if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) return bad(field.kind === "item" ? "an item id" : "a list of item ids");
      const missing = await exist(field.targetCollectionId ?? "", ids as string[]);
      if (missing.length > 0) throw new HttpError(400, `“${field.name}” of ${collection.name}: no such item: ${missing.join(", ")}`);
      return field.kind === "item" ? (raw as string) : (ids as string[]);
    }
  }
}

/** Values as given (by field name or id) as the repository takes them (by field id). */
export async function valuesIn(collection: Collection, input: unknown, exist: ItemsExist): Promise<Record<string, FieldValue>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "`values` must be an object of field names to values");
  const out: Record<string, FieldValue> = {};
  for (const [name, raw] of Object.entries(input)) {
    const field = fieldOf(collection, name);
    out[field.id] = await valueIn(collection, field, raw, exist);
  }
  return out;
}
