// Kubus as an MCP server (Model Context Protocol, streamable HTTP): an assistant such
// as Claude reads and writes the knowledge base through tools, each a thin translation onto one
// /api/v1 route (answered by the headless device, as for any other caller). Stateless: no session,
// every POST holds one JSON-RPC message (or, in protocol 2025-03-26, a batch) and is answered with
// JSON; the server pushes nothing (GET: 405). Documented in app/src/help/api.md (MCP).

import { HttpError, readJson, type ApiRequest, type ApiResponse } from "../../shared/router.ts";
import type { Access } from "./tokens.ts";
import { MAX_FILE_BYTES } from "../../shared/sync.ts";

export type Api = (req: ApiRequest) => Promise<ApiResponse>;

/** Newest first; the first is offered to a client asking for one we don't know. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
/** Assumed without an MCP-Protocol-Version header (the spec's rule). */
const UNNAMED_VERSION = "2025-03-26";
/** A message, room enough for the largest image upload_image takes (the API's limit) written in base64. */
const MAX_BODY = Math.ceil((MAX_FILE_BYTES * 4) / 3) + 1024 * 1024;

const INSTRUCTIONS = `Kubus is a personal knowledge base. Its data is in collections (such as Books or People), each with typed fields; an item is one entry of a collection (a particular book), its values listed by field name. Spaces keep items apart (default: the default space). Views list a collection's items through filters, sorts and grouping, in blocks.
Start with list_collections to learn the collections and their fields; collections, fields, views and spaces can be named by name or id, in any case. Item and List-of-items fields hold item ids (labels: get_item or search). Component fields are worked out and read-only.
Everything the app does can be done here: spaces, collections and fields, items, views and item views, dashboards, bookmarks, components and images. Before making views, blocks, fields or components, read_reference gives the exact shapes (topic api) and the {{ }} code of components and AI prompts (topic components).`;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type Args = Record<string, unknown>;

interface Tool {
  name: string;
  title: string;
  description: string;
  properties: Record<string, unknown>;
  required?: string[];
  /** Whether it changes data (then it isn't offered to a token that only reads). */
  writes: boolean;
  destructive?: boolean;
  /** Makes something new each time it is called (not idempotent): a create. */
  creates?: boolean;
  /** Its answer is a file's bytes, given to the model as an image. */
  image?: boolean;
  /** The /api/v1 request it makes: a JSON body, or raw bytes of a content type (an image). */
  request(args: Args): { method: string; path: string; query?: Record<string, string | undefined>; body?: unknown; bytes?: Uint8Array; contentType?: string };
  /** The property a list answer is put under in structuredContent (which is an object). */
  listKey?: string;
}

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", minimum: 0, description });
const space = str("A space, by name or id (default: the default space)");
const collection = str("A collection, by name, plural name or id");
const values = { type: "object", description: "Values by field name (or id); see the value of each field type in list_collections' fields", additionalProperties: true };
const rules = (description: string, item: Record<string, unknown>) => ({ type: "array", description, items: { type: "object", ...item } });
const filters = rules(
  "Filter rules, read in order: { fieldId (a field's name or id), operator, value, join? }. Operators by field type: text contains, notContains; number is, isNot, gt, lt; date is, before, after, between (yyyy-mm-dd..yyyy-mm-dd or yyyy-mm-ddTHH:MM..yyyy-mm-ddTHH:MM, or hour/day/week/month/year with an offset such as month-1, or a range up to now such as hour-23..hour+0); checkbox isChecked, isNotChecked; item is, isNot (an item id); list of items is, isNot; every type isEmpty, isNotEmpty. join: and (default) or or.",
  { properties: { fieldId: { type: "string" }, operator: { type: "string" }, value: { type: "string" }, join: { enum: ["and", "or"] } }, required: ["fieldId", "operator"] },
);
const sort = rules("Sort rules: { fieldId, direction } (asc or desc)", { properties: { fieldId: { type: "string" }, direction: { enum: ["asc", "desc"] } }, required: ["fieldId"] });
const json = (v: unknown) => (v === undefined ? undefined : JSON.stringify(v));
/** An image as upload_image takes it: base64, or a data: URL (whose type it gives). */
function decodeImage(data: string): { bytes: Uint8Array; type: string | null } {
  const url = /^data:([^;,]+)?(;base64)?,/i.exec(data.trim());
  const text = url ? data.trim().slice(url[0].length) : data;
  return { bytes: new Uint8Array(Buffer.from(text.replace(/\s+/g, ""), "base64")), type: url?.[1]?.toLowerCase() ?? null };
}
const num = (v: unknown) => (v === undefined ? undefined : String(v));
const seg = (v: unknown) => encodeURIComponent(String(v));
/** The arguments given, of these keys: a request body that changes only what was asked for. */
const pick = (a: Args, keys: string[]) => Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
const bool = (description: string) => ({ type: "boolean", description });
const list = (description: string) => ({ type: "array", description, items: { type: "object", additionalProperties: true } });
const names = (description: string) => ({ type: "array", description, items: { type: "string" } });
const spaces = { type: ["array", "null"], items: { type: "string" }, description: "The spaces it is shown in (names or ids); null for every space" };
const view = str("A view, by name or id");
const dashboard = str("A dashboard, by name or id");
const component = str("A component, by name or id");
const fieldArg = str("A field, by name or id");
const viewSpace = str("The view's space (default: any; give it when views of several spaces share the name)");
/** What a view (of a collection or a dashboard) is made of: see read_reference for blocks, filters and their fields. */
const VIEW_KEYS = ["name", "filters", "blocks", "editable", "filterBar", "fullWidth"];
const viewProperties = {
  name: str("Its name"),
  filters: list("The view's filter: rules { fieldId, operator, value, join? }, as list_items takes"),
  blocks: list("Its blocks, in order: { kind (table, cards, chart, map, component, markdown, linked), title?, filters?, sort?, groupBy?, layout?, collectionId?, collectionIds? (dashboards), options?, beside?, width?, rowFit?, rowHeight? }; read_reference (api) gives every key and each kind's options"),
  editable: bool("Values can be edited in place"),
  filterBar: bool("Show the filter bar"),
  fullWidth: { type: ["boolean", "null"], description: "Use the page's whole width (null: the default)" },
};
/** What describes a field (add_field, update_field). */
const FIELD_KEYS = ["name", "kind", "targetCollection", "component", "code", "output", "frameRatio", "choiceFilter", "toggleIcon", "strikeThrough"];
const fieldProperties = {
  name: str("Its name"),
  kind: str("Its type: string, markdown, html, number, date, datetime, checkbox, image, item, string_list, number_list, checklist, item_list, component or ai (fixed once made)"),
  targetCollection: str("item and item_list: the collection they point to (fixed once made)"),
  component: str("component and ai: a shared component (by name or id), instead of code of its own"),
  code: str("component: its own {{ }} code; ai: its prompt (read_reference components)"),
  output: str("component: markdown, string, number, html or image; ai: string, number or markdown"),
  frameRatio: str("An HTML component's frame ratio, such as 4/3"),
  choiceFilter: list("item and item_list: rules limiting the items offered"),
  toggleIcon: str("checkbox and checklist: an icon instead of the box"),
  strikeThrough: bool("checkbox: strike the item through when checked; checklist: a checked entry"),
};
const COMPONENT_KEYS = ["name", "code", "output", "ai", "description", "frameRatio"];
const componentProperties = {
  name: str("Its name"),
  code: str("Its {{ }} code, or with ai its prompt (read_reference components)"),
  output: str("markdown (default), string, number, html or image"),
  ai: bool("A prompt for AI fields rather than code"),
  description: str("What it is for"),
  frameRatio: str("HTML output: its frame's ratio, such as 4/3"),
};

export const TOOLS: Tool[] = [
  {
    name: "search",
    title: "Search",
    description: "Searches the items of every collection, as the app's search does. Answers the items found, best first.",
    properties: { q: str("What to look for"), space, limit: int("At most this many (default 50, up to 500)") },
    required: ["q"],
    writes: false,
    listKey: "items",
    request: (a) => ({ method: "GET", path: "/api/v1/search", query: { q: String(a.q), space: a.space as string, limit: num(a.limit) } }),
  },
  {
    name: "list_spaces",
    title: "List spaces",
    description: "The spaces, which keep items apart while sharing collections.",
    properties: {},
    writes: false,
    listKey: "spaces",
    request: () => ({ method: "GET", path: "/api/v1/spaces" }),
  },
  {
    name: "list_collections",
    title: "List collections",
    description: "Every collection with its fields (name and field type), item views and number of items.",
    properties: { space: str("Count the items of this space only") },
    writes: false,
    listKey: "collections",
    request: (a) => ({ method: "GET", path: "/api/v1/collections", query: { space: a.space as string } }),
  },
  {
    name: "get_collection",
    title: "Get a collection",
    description: "One collection: its fields and item views.",
    properties: { collection },
    required: ["collection"],
    writes: false,
    request: (a) => ({ method: "GET", path: `/api/v1/collections/${seg(a.collection)}` }),
  },
  {
    name: "list_items",
    title: "List items",
    description: "A collection's items, most recently changed first unless sorted, optionally filtered: { items, total, limit, offset }.",
    properties: { collection, space, filters, sort, limit: int("At most this many (default 100, up to 1000)"), offset: int("Skip this many") },
    required: ["collection"],
    writes: false,
    request: (a) => ({
      method: "GET",
      path: `/api/v1/collections/${seg(a.collection)}/items`,
      query: { space: a.space as string, filters: json(a.filters), sort: json(a.sort), limit: num(a.limit), offset: num(a.offset) },
    }),
  },
  {
    name: "get_item",
    title: "Get an item",
    description: "One item by id, with all its values.",
    properties: { id: str("The item's id") },
    required: ["id"],
    writes: false,
    request: (a) => ({ method: "GET", path: `/api/v1/items/${seg(a.id)}` }),
  },
  {
    name: "list_views",
    title: "List views",
    description: "A collection's saved views (in a space): their filters and blocks.",
    properties: { collection, space },
    required: ["collection"],
    writes: false,
    listKey: "views",
    request: (a) => ({ method: "GET", path: `/api/v1/collections/${seg(a.collection)}/views`, query: { space: a.space as string } }),
  },
  {
    name: "view_items",
    title: "A view's items",
    description: "The items a saved view shows in one of its blocks (default its first), with the view's and the block's filter, sort and grouping: { items } or, grouped, { groups: [{ key, label, total, items }] }, with total, limit and offset.",
    properties: {
      collection,
      view: str("The view, by name or id"),
      block: str("One of its blocks, by title or id (default: the first)"),
      space: str("The view's space (default: any)"),
      limit: int("At most this many (default 100, up to 1000)"),
      offset: int("Skip this many"),
    },
    required: ["collection", "view"],
    writes: false,
    request: (a) => ({
      method: "GET",
      path: `/api/v1/collections/${seg(a.collection)}/views/${seg(a.view)}/items`,
      query: { block: a.block as string, space: a.space as string, limit: num(a.limit), offset: num(a.offset) },
    }),
  },
  {
    name: "create_item",
    title: "Create an item",
    description: "Adds an item to a collection; answers the new item.",
    properties: { collection, values, space },
    required: ["collection", "values"],
    writes: true,
    destructive: false,
    creates: true,
    request: (a) => ({ method: "POST", path: `/api/v1/collections/${seg(a.collection)}/items`, body: { values: a.values, space: a.space } }),
  },
  {
    name: "update_item",
    title: "Update an item",
    description: "Changes the values given (others stay as they are; null empties one); answers the item.",
    properties: { id: str("The item's id"), values },
    required: ["id", "values"],
    writes: true,
    destructive: true,
    request: (a) => ({ method: "PATCH", path: `/api/v1/items/${seg(a.id)}`, body: { values: a.values } }),
  },
  {
    name: "delete_item",
    title: "Delete an item",
    description: "Deletes an item.",
    properties: { id: str("The item's id") },
    required: ["id"],
    writes: true,
    destructive: true,
    request: (a) => ({ method: "DELETE", path: `/api/v1/items/${seg(a.id)}` }),
  },
  {
    name: "read_reference",
    title: "Read the reference",
    description:
      "The API's reference (topic api): every value, view, block and its options, filter operator, dashboard and bookmark shape these tools take; or (topic components) the {{ }} code of components and AI prompts. Read it before making views, blocks, fields or components.",
    properties: { topic: { type: "string", enum: ["api", "components"], description: "api (default) or components" } },
    writes: false,
    request: (a) => ({ method: "GET", path: "/api/v1/reference", query: { topic: a.topic as string } }),
  },
  {
    name: "get_image",
    title: "Get an image",
    description: "An image stored in Kubus by its id (an Image field's value, or the id in files/<id>), to look at.",
    properties: { id: str("The file's id (its SHA-256)") },
    required: ["id"],
    writes: false,
    image: true,
    request: (a) => ({ method: "GET", path: `/api/v1/files/${seg(String(a.id).replace(/^files\//, ""))}` }),
  },
  // Spaces
  {
    name: "create_space",
    title: "Create a space",
    description: "Adds a space (items are kept apart per space; collections are shared).",
    properties: { name: str("Its name"), icon: str("A Carbon icon name") },
    required: ["name"],
    writes: true,
    creates: true,
    request: (a) => ({ method: "POST", path: "/api/v1/spaces", body: pick(a, ["name", "icon"]) }),
  },
  {
    name: "update_space",
    title: "Update a space",
    description: "Renames a space or changes its icon.",
    properties: { space: str("The space, by name or id"), name: str("Its new name"), icon: str("A Carbon icon name") },
    required: ["space"],
    writes: true,
    request: (a) => ({ method: "PATCH", path: `/api/v1/spaces/${seg(a.space)}`, body: pick(a, ["name", "icon"]) }),
  },
  {
    name: "delete_space",
    title: "Delete a space",
    description: "Deletes a space with its items, views and bookmarks (the default space can't be deleted).",
    properties: { space: str("The space, by name or id") },
    required: ["space"],
    writes: true,
    destructive: true,
    request: (a) => ({ method: "DELETE", path: `/api/v1/spaces/${seg(a.space)}` }),
  },
  // Collections and fields
  {
    name: "create_collection",
    title: "Create a collection",
    description: "Makes a collection with its fields and an \"All\" view in the space; answers it. Fields as add_field takes them.",
    properties: {
      name: str("Its singular name, such as Book"),
      pluralName: str("Its plural name (default: made from the name)"),
      icon: str("A Carbon icon name"),
      description: str("What it holds"),
      spaces,
      space: str("The space its first view is made in (default: the default space)"),
      fields: list("Its fields: { name, kind, … } as add_field takes them"),
    },
    required: ["name", "fields"],
    writes: true,
    creates: true,
    request: (a) => ({ method: "POST", path: "/api/v1/collections", body: pick(a, ["name", "pluralName", "icon", "description", "spaces", "space", "fields"]) }),
  },
  {
    name: "update_collection",
    title: "Update a collection",
    description: "Changes a collection's settings (only those given).",
    properties: {
      collection,
      name: str("Its singular name"),
      pluralName: str("Its plural name"),
      icon: str("A Carbon icon name"),
      description: str("What it holds"),
      spaces,
      titleField: { type: ["string", "null"], description: "The text, number or date field its items are called by (name or id); \"none\" for no title; null for the first text field with a value" },
      hiddenInNav: bool("Left out of the side nav"),
    },
    required: ["collection"],
    writes: true,
    request: (a) => ({ method: "PATCH", path: `/api/v1/collections/${seg(a.collection)}`, body: pick(a, ["name", "pluralName", "icon", "description", "spaces", "titleField", "hiddenInNav"]) }),
  },
  {
    name: "delete_collection",
    title: "Delete a collection",
    description: "Deletes a collection with its items, views and bookmarks.",
    properties: { collection },
    required: ["collection"],
    writes: true,
    destructive: true,
    request: (a) => ({ method: "DELETE", path: `/api/v1/collections/${seg(a.collection)}` }),
  },
  {
    name: "add_field",
    title: "Add a field",
    description: "Adds a field to a collection; answers the collection.",
    properties: { collection, ...fieldProperties },
    required: ["collection", "name", "kind"],
    writes: true,
    creates: true,
    request: (a) => ({ method: "POST", path: `/api/v1/collections/${seg(a.collection)}/fields`, body: pick(a, FIELD_KEYS) }),
  },
  {
    name: "update_field",
    title: "Update a field",
    description: "Changes a field (only what is given; its kind and target can't change).",
    properties: { collection, field: fieldArg, ...fieldProperties },
    required: ["collection", "field"],
    writes: true,
    request: (a) => ({ method: "PATCH", path: `/api/v1/collections/${seg(a.collection)}/fields/${seg(a.field)}`, body: pick(a, FIELD_KEYS) }),
  },
  {
    name: "delete_field",
    title: "Delete a field",
    description: "Removes a field and its values (a collection keeps at least one field).",
    properties: { collection, field: fieldArg },
    required: ["collection", "field"],
    writes: true,
    destructive: true,
    request: (a) => ({ method: "DELETE", path: `/api/v1/collections/${seg(a.collection)}/fields/${seg(a.field)}` }),
  },
  {
    name: "order_fields",
    title: "Order fields",
    description: "Puts a collection's fields in this order; fields left out keep theirs, after these.",
    properties: { collection, fields: names("The fields, by name or id, in their new order") },
    required: ["collection", "fields"],
    writes: true,
    request: (a) => ({ method: "PUT", path: `/api/v1/collections/${seg(a.collection)}/fields/order`, body: a.fields }),
  },
  // Items beyond their values
  {
    name: "move_item",
    title: "Move an item",
    description: "Moves an item to another space (its collection must be shown there).",
    properties: { id: str("The item's id"), space: str("The space, by name or id") },
    required: ["id", "space"],
    writes: true,
    request: (a) => ({ method: "POST", path: `/api/v1/items/${seg(a.id)}/move`, body: { space: a.space } }),
  },
  {
    name: "set_ai_value",
    title: "Set an AI field's value",
    description: "Writes an AI field's generated value, for its prompt as it reads now (as if generated).",
    properties: { id: str("The item's id"), field: fieldArg, value: { type: ["string", "number", "null"], description: "The value: text, or a number for a number prompt" } },
    required: ["id", "field"],
    writes: true,
    request: (a) => ({ method: "PUT", path: `/api/v1/items/${seg(a.id)}/ai/${seg(a.field)}`, body: { value: a.value ?? null } }),
  },
  {
    name: "accept_ai_value",
    title: "Keep a typed AI value",
    description: "Keeps a value someone typed over an AI field, so it isn't generated again.",
    properties: { id: str("The item's id"), field: fieldArg },
    required: ["id", "field"],
    writes: true,
    request: (a) => ({ method: "POST", path: `/api/v1/items/${seg(a.id)}/ai/${seg(a.field)}/accept` }),
  },
  // Collection views and item views
  {
    name: "create_view",
    title: "Create a view",
    description: "Adds a view to a collection in a space: its filter and blocks; answers it.",
    properties: { collection, space, ...viewProperties },
    required: ["collection", "name"],
    writes: true,
    creates: true,
    request: (a) => ({ method: "POST", path: `/api/v1/collections/${seg(a.collection)}/views`, body: pick(a, ["space", ...VIEW_KEYS]) }),
  },
  {
    name: "update_view",
    title: "Update a view",
    description: "Changes a collection view (only what is given; blocks given replace its blocks).",
    properties: { collection, view, space: viewSpace, ...viewProperties },
    required: ["collection", "view"],
    writes: true,
    request: (a) => ({ method: "PATCH", path: `/api/v1/collections/${seg(a.collection)}/views/${seg(a.view)}`, query: { space: a.space as string }, body: pick(a, VIEW_KEYS) }),
  },
  {
    name: "delete_view",
    title: "Delete a view",
    description: "Deletes a collection view.",
    properties: { collection, view, space: viewSpace },
    required: ["collection", "view"],
    writes: true,
    destructive: true,
    request: (a) => ({ method: "DELETE", path: `/api/v1/collections/${seg(a.collection)}/views/${seg(a.view)}`, query: { space: a.space as string } }),
  },
  {
    name: "set_default_view",
    title: "Set the default view",
    description: "Stars a collection's view as the one it opens with in a space (view null: none).",
    properties: { collection, view: { type: ["string", "null"], description: "The view, by name or id; null for none" }, space },
    required: ["collection"],
    writes: true,
    request: (a) => ({ method: "PUT", path: `/api/v1/collections/${seg(a.collection)}/default-view`, body: { space: a.space, view: a.view ?? null } }),
  },
  {
    name: "list_item_views",
    title: "List item views",
    description: "A collection's item views: how its item pages are laid out (fields and blocks).",
    properties: { collection },
    required: ["collection"],
    writes: false,
    listKey: "itemViews",
    request: (a) => ({ method: "GET", path: `/api/v1/collections/${seg(a.collection)}/item-views` }),
  },
  {
    name: "set_item_views",
    title: "Set item views",
    description: "Replaces a collection's item views with these: { name, isDefault?, fullWidth?, layout } each (layout: fields, editable, hiddenLabels, hideEmpty, blocks, filters; read_reference).",
    properties: { collection, itemViews: list("The item views, in order") },
    required: ["collection", "itemViews"],
    writes: true,
    destructive: true,
    request: (a) => ({ method: "PUT", path: `/api/v1/collections/${seg(a.collection)}/item-views`, body: a.itemViews }),
  },
  // Dashboards
  {
    name: "list_dashboards",
    title: "List dashboards",
    description: "The dashboards (in a space: those shown there): pages of blocks of any collections.",
    properties: { space },
    writes: false,
    listKey: "dashboards",
    request: (a) => ({ method: "GET", path: "/api/v1/dashboards", query: { space: a.space as string } }),
  },
  {
    name: "get_dashboard",
    title: "Get a dashboard",
    description: "One dashboard.",
    properties: { dashboard },
    required: ["dashboard"],
    writes: false,
    request: (a) => ({ method: "GET", path: `/api/v1/dashboards/${seg(a.dashboard)}` }),
  },
  {
    name: "create_dashboard",
    title: "Create a dashboard",
    description: "Makes a dashboard with a first view \"Dashboard\" in the space (shown only there unless spaces is given).",
    properties: { name: str("Its name"), icon: str("A Carbon icon name"), description: str("What it shows"), space, spaces },
    required: ["name"],
    writes: true,
    creates: true,
    request: (a) => ({ method: "POST", path: "/api/v1/dashboards", body: pick(a, ["name", "icon", "description", "space", "spaces"]) }),
  },
  {
    name: "update_dashboard",
    title: "Update a dashboard",
    description: "Changes a dashboard's name, icon, description or spaces.",
    properties: { dashboard, name: str("Its name"), icon: str("A Carbon icon name"), description: str("What it shows"), spaces },
    required: ["dashboard"],
    writes: true,
    request: (a) => ({ method: "PATCH", path: `/api/v1/dashboards/${seg(a.dashboard)}`, body: pick(a, ["name", "icon", "description", "spaces"]) }),
  },
  {
    name: "delete_dashboard",
    title: "Delete a dashboard",
    description: "Deletes a dashboard with its views and their bookmarks.",
    properties: { dashboard },
    required: ["dashboard"],
    writes: true,
    destructive: true,
    request: (a) => ({ method: "DELETE", path: `/api/v1/dashboards/${seg(a.dashboard)}` }),
  },
  {
    name: "list_dashboard_views",
    title: "List a dashboard's views",
    description: "A dashboard's views in a space, with their filters and blocks.",
    properties: { dashboard, space },
    required: ["dashboard"],
    writes: false,
    listKey: "views",
    request: (a) => ({ method: "GET", path: `/api/v1/dashboards/${seg(a.dashboard)}/views`, query: { space: a.space as string } }),
  },
  {
    name: "dashboard_view_items",
    title: "A dashboard view's items",
    description: "The items one block of a dashboard view shows, as view_items does for a collection view.",
    properties: { dashboard, view, block: str("One of its blocks, by title or id (default: the first)"), space: viewSpace, limit: int("At most this many (default 100, up to 1000)"), offset: int("Skip this many") },
    required: ["dashboard", "view"],
    writes: false,
    request: (a) => ({
      method: "GET",
      path: `/api/v1/dashboards/${seg(a.dashboard)}/views/${seg(a.view)}/items`,
      query: { block: a.block as string, space: a.space as string, limit: num(a.limit), offset: num(a.offset) },
    }),
  },
  {
    name: "create_dashboard_view",
    title: "Create a dashboard view",
    description: "Adds a view to a dashboard in a space it is shown in; its blocks name their collections (collectionId, or collectionIds read as one).",
    properties: { dashboard, space, ...viewProperties },
    required: ["dashboard", "name"],
    writes: true,
    creates: true,
    request: (a) => ({ method: "POST", path: `/api/v1/dashboards/${seg(a.dashboard)}/views`, body: pick(a, ["space", ...VIEW_KEYS]) }),
  },
  {
    name: "update_dashboard_view",
    title: "Update a dashboard view",
    description: "Changes a dashboard's view (only what is given; blocks given replace its blocks).",
    properties: { dashboard, view, space: viewSpace, ...viewProperties },
    required: ["dashboard", "view"],
    writes: true,
    request: (a) => ({ method: "PATCH", path: `/api/v1/dashboards/${seg(a.dashboard)}/views/${seg(a.view)}`, query: { space: a.space as string }, body: pick(a, VIEW_KEYS) }),
  },
  {
    name: "delete_dashboard_view",
    title: "Delete a dashboard view",
    description: "Deletes a dashboard's view.",
    properties: { dashboard, view, space: viewSpace },
    required: ["dashboard", "view"],
    writes: true,
    destructive: true,
    request: (a) => ({ method: "DELETE", path: `/api/v1/dashboards/${seg(a.dashboard)}/views/${seg(a.view)}`, query: { space: a.space as string } }),
  },
  {
    name: "set_default_dashboard_view",
    title: "Set a dashboard's default view",
    description: "Stars a dashboard's view in a space (view null: none).",
    properties: { dashboard, view: { type: ["string", "null"], description: "The view, by name or id; null for none" }, space },
    required: ["dashboard"],
    writes: true,
    request: (a) => ({ method: "PUT", path: `/api/v1/dashboards/${seg(a.dashboard)}/default-view`, body: { space: a.space, view: a.view ?? null } }),
  },
  // Bookmarks
  {
    name: "list_bookmarks",
    title: "List bookmarks",
    description: "The bookmarks of a space: { id, link, label, position }.",
    properties: { space },
    writes: false,
    listKey: "bookmarks",
    request: (a) => ({ method: "GET", path: "/api/v1/bookmarks", query: { space: a.space as string } }),
  },
  {
    name: "add_bookmark",
    title: "Add a bookmark",
    description: "Bookmarks a page by its link, by name (book/dune, book/dune/details#author, books/reading-list, dashboards/health/daily) or stored (#/collections/…).",
    properties: { link: str("The page's link"), label: str("Its label (default: the page's name)"), space },
    required: ["link"],
    writes: true,
    creates: true,
    request: (a) => ({ method: "POST", path: "/api/v1/bookmarks", body: pick(a, ["link", "label", "space"]) }),
  },
  {
    name: "rename_bookmark",
    title: "Rename a bookmark",
    description: "Changes a bookmark's label.",
    properties: { id: str("The bookmark's id"), label: str("Its new label"), space },
    required: ["id", "label"],
    writes: true,
    request: (a) => ({ method: "PATCH", path: `/api/v1/bookmarks/${seg(a.id)}`, query: { space: a.space as string }, body: { label: a.label } }),
  },
  {
    name: "delete_bookmark",
    title: "Delete a bookmark",
    description: "Removes a bookmark.",
    properties: { id: str("The bookmark's id"), space },
    required: ["id"],
    writes: true,
    destructive: true,
    request: (a) => ({ method: "DELETE", path: `/api/v1/bookmarks/${seg(a.id)}`, query: { space: a.space as string } }),
  },
  // Components
  {
    name: "list_components",
    title: "List components",
    description: "The shared components, with their code.",
    properties: {},
    writes: false,
    listKey: "components",
    request: () => ({ method: "GET", path: "/api/v1/components" }),
  },
  {
    name: "get_component",
    title: "Get a component",
    description: "One shared component, with its code.",
    properties: { component },
    required: ["component"],
    writes: false,
    request: (a) => ({ method: "GET", path: `/api/v1/components/${seg(a.component)}` }),
  },
  {
    name: "create_component",
    title: "Create a component",
    description: "Adds a shared component (or, with ai, a prompt for AI fields); read_reference components for its code.",
    properties: componentProperties,
    required: ["name", "code"],
    writes: true,
    creates: true,
    request: (a) => ({ method: "POST", path: "/api/v1/components", body: pick(a, COMPONENT_KEYS) }),
  },
  {
    name: "update_component",
    title: "Update a component",
    description: "Changes a shared component (only what is given): everywhere it is used.",
    properties: { component, ...componentProperties },
    required: ["component"],
    writes: true,
    request: (a) => ({ method: "PATCH", path: `/api/v1/components/${seg(a.component)}`, body: pick(a, COMPONENT_KEYS) }),
  },
  {
    name: "delete_component",
    title: "Delete a component",
    description: "Deletes a shared component; with withFields the fields that use it go too (else it is refused while in use).",
    properties: { component, withFields: bool("Also delete the fields that use it") },
    required: ["component"],
    writes: true,
    destructive: true,
    request: (a) => ({ method: "DELETE", path: `/api/v1/components/${seg(a.component)}`, query: { withFields: a.withFields ? "true" : undefined } }),
  },
  {
    name: "upload_image",
    title: "Upload an image",
    description:
      "Stores an image and answers its id and src. Put the id in an Image field (create_item or update_item values), or the src in Markdown as ![description](src). The bytes base64-encoded in data (a data: URL works too); mimeType image/png, image/jpeg, image/gif, image/webp, image/svg+xml or image/avif (from a data: URL when left out). The same bytes give the same id.",
    properties: { data: str("The image's bytes, base64-encoded, or a data: URL"), mimeType: str("The image's type, such as image/png (from a data: URL when left out)") },
    required: ["data"],
    writes: true,
    request: (a) => {
      const { bytes, type } = decodeImage(String(a.data));
      return { method: "POST", path: "/api/v1/files", bytes, contentType: typeof a.mimeType === "string" && a.mimeType ? a.mimeType : (type ?? "") };
    },
  },
];

const toolsFor = (access: Access) => TOOLS.filter((t) => access !== "read" || !t.writes);

const listed = (t: Tool) => ({
  name: t.name,
  title: t.title,
  description: t.description,
  inputSchema: { type: "object", properties: t.properties, ...(t.required && { required: t.required }), additionalProperties: false },
  annotations: { title: t.title, readOnlyHint: !t.writes, ...(t.writes && { destructiveHint: !!t.destructive, idempotentHint: !t.creates }), openWorldHint: false },
});

type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
type Reply = { jsonrpc: "2.0"; id?: unknown; result?: unknown; error?: { code: number; message: string } };

const failure = (id: unknown, code: number, message: string): Reply => ({ jsonrpc: "2.0", ...(id !== undefined && { id }), error: { code, message } });
const answer = (status: number, body?: unknown, headers: Record<string, string> = {}): ApiResponse => ({ status, json: body, headers });

/** A tool's result: the answer as JSON text (and structured), or the API's refusal as an error the model can act on. */
async function callTool(tool: Tool, args: Args, api: Api): Promise<unknown> {
  const missing = (tool.required ?? []).filter((k) => args[k] === undefined || args[k] === null || args[k] === "");
  if (missing.length > 0) return { content: [{ type: "text", text: `Missing: ${missing.join(", ")}` }], isError: true };
  const { method, path, query, body, bytes: raw, contentType } = tool.request(args);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) params.set(k, v);
  const bytes = raw ?? new TextEncoder().encode(body === undefined ? "" : JSON.stringify(body));
  let response: ApiResponse;
  try {
    response = await api({
      method,
      path,
      query: params,
      headers: { "content-type": contentType ?? "application/json" },
      body: async (limit) => {
        if (bytes.byteLength > limit) throw new HttpError(413, "Request too large");
        return bytes;
      },
    });
  } catch (e) {
    response = { status: e instanceof HttpError ? e.status : 500, json: { error: e instanceof Error ? e.message : String(e) } };
  }
  if (response.status >= 400) {
    const error = (response.json as { error?: unknown } | undefined)?.error;
    return { content: [{ type: "text", text: `${typeof error === "string" ? error : "Failed"} (HTTP ${response.status})` }], isError: true };
  }
  // A file: the image itself, which the model can look at.
  if (tool.image && response.bytes) {
    const mimeType = Object.entries(response.headers ?? {}).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "application/octet-stream";
    return { content: [{ type: "image", data: Buffer.from(response.bytes).toString("base64"), mimeType }] };
  }
  const data = response.json ?? { ok: true };
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: Array.isArray(data) ? { [tool.listKey ?? "items"]: data } : data,
  };
}

/** One JSON-RPC message: its reply, or null for a notification or a response (nothing to answer). */
async function handleMessage(message: Message, access: Access, api: Api): Promise<Reply | null> {
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
    return failure(null, INVALID_REQUEST, "Not a JSON-RPC 2.0 message");
  }
  const { id, method } = message;
  if (method === undefined && id !== undefined && ("result" in message || "error" in message)) return null; // we send no requests
  if (typeof method !== "string") return failure(id ?? null, INVALID_REQUEST, "`method` must be text");
  if (id === undefined) return null; // a notification: initialized, cancelled, …
  if (typeof id !== "string" && typeof id !== "number") return failure(null, INVALID_REQUEST, "`id` must be text or a number");
  const params = (message.params && typeof message.params === "object" ? message.params : {}) as Args;
  const ok = (result: unknown): Reply => ({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize": {
      const asked = params.protocolVersion;
      return ok({
        protocolVersion: typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "kubus", title: "Kubus", version: "0.1.0" },
        instructions: INSTRUCTIONS + (access === "read" ? "\nThis token only reads: there are no tools that change data." : ""),
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: toolsFor(access).map(listed) });
    case "tools/call": {
      const name = params.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return failure(id, INVALID_PARAMS, `Unknown tool: ${String(name)}`);
      if (!toolsFor(access).includes(tool)) return failure(id, INVALID_PARAMS, `${tool.name} changes data, and this token only reads`);
      const args = params.arguments ?? {};
      if (typeof args !== "object" || Array.isArray(args)) return failure(id, INVALID_PARAMS, "`arguments` must be an object");
      return ok(await callTool(tool, args as Args, api));
    }
    default:
      return failure(id, METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}

/**
 * A browser's request from another site is refused (DNS rebinding); one from the server's own
 * origin (also behind a proxy that names it in X-Forwarded-Host), or not from a browser, is fine.
 */
function originAllowed(req: ApiRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  return [req.headers.host, ...(req.headers["x-forwarded-host"] ?? "").split(",").map((h) => h.trim())].includes(host);
}

/** Answers a request to the MCP endpoint, as `access` allows, through `api` (the /api/v1 handler). */
export async function handleMcp(req: ApiRequest, access: Access, api: Api): Promise<ApiResponse> {
  if (!originAllowed(req)) return answer(403, failure(undefined, INVALID_REQUEST, "Requests from other sites are refused"));
  if (req.method !== "POST") return answer(405, failure(undefined, INVALID_REQUEST, "POST a JSON-RPC message; this server sends no events"), { Allow: "POST" });
  let body: unknown;
  try {
    body = await readJson(req, MAX_BODY);
  } catch (e) {
    if (e instanceof HttpError && e.status === 413) return answer(413, failure(undefined, INVALID_REQUEST, e.message));
    return answer(400, failure(undefined, PARSE_ERROR, "The body isn't valid JSON"));
  }
  if (body === undefined) return answer(400, failure(undefined, INVALID_REQUEST, "Send a JSON-RPC message"));
  // The version agreed on in initialize (the client names it on every request after that).
  const version = req.headers["mcp-protocol-version"];
  const initializing = !Array.isArray(body) && (body as Message)?.method === "initialize";
  if (version !== undefined && !initializing && !PROTOCOL_VERSIONS.includes(version)) {
    return answer(400, failure(undefined, INVALID_REQUEST, `Unsupported MCP-Protocol-Version ${version}: ${PROTOCOL_VERSIONS.join(", ")}`));
  }
  if (Array.isArray(body)) {
    // Batches were part of 2025-03-26 only.
    if ((version ?? UNNAMED_VERSION) !== UNNAMED_VERSION) return answer(400, failure(undefined, INVALID_REQUEST, "Send one JSON-RPC message per request"));
    if (body.length === 0) return answer(400, failure(null, INVALID_REQUEST, "An empty batch"));
    const replies: Reply[] = [];
    for (const message of body) {
      if ((message as Message)?.method === "initialize") replies.push(failure((message as Message).id ?? null, INVALID_REQUEST, "initialize can't be batched"));
      else {
        const reply = await handleMessage(message as Message, access, api);
        if (reply) replies.push(reply);
      }
    }
    return replies.length > 0 ? answer(200, replies) : { status: 202 };
  }
  const reply = await handleMessage(body as Message, access, api);
  return reply ? answer(200, reply) : { status: 202 };
}
