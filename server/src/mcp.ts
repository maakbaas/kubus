// Kubus as an MCP server (Model Context Protocol, streamable HTTP): an assistant such
// as Claude reads and writes the knowledge base through tools, each a thin translation onto one
// /api/v1 route (answered by the headless device, as for any other caller). Stateless: no session,
// every POST holds one JSON-RPC message (or, in protocol 2025-03-26, a batch) and is answered with
// JSON; the server pushes nothing (GET: 405). Documented in app/src/help/api.md (MCP).

import { HttpError, readJson, type ApiRequest, type ApiResponse } from "../../shared/router.ts";
import type { Access } from "./tokens.ts";

export type Api = (req: ApiRequest) => Promise<ApiResponse>;

/** Newest first; the first is offered to a client asking for one we don't know. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
/** Assumed without an MCP-Protocol-Version header (the spec's rule). */
const UNNAMED_VERSION = "2025-03-26";
const MAX_BODY = 5 * 1024 * 1024;

const INSTRUCTIONS = `Kubus is a personal knowledge base. Its data is in collections (such as Books or People), each with typed fields; an item is one entry of a collection (a particular book), its values listed by field name. Spaces keep items apart (default: the default space). Views list a collection's items through filters, sorts and grouping, in blocks.
Start with list_collections to learn the collections and their fields; collections, fields, views and spaces can be named by name or id, in any case. Item and List-of-items fields hold item ids (labels: get_item or search). Component fields are worked out and read-only.`;

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
  /** The /api/v1 request it makes. */
  request(args: Args): { method: string; path: string; query?: Record<string, string | undefined>; body?: unknown };
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
const num = (v: unknown) => (v === undefined ? undefined : String(v));
const seg = (v: unknown) => encodeURIComponent(String(v));

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
];

const toolsFor = (access: Access) => TOOLS.filter((t) => access !== "read" || !t.writes);

const listed = (t: Tool) => ({
  name: t.name,
  title: t.title,
  description: t.description,
  inputSchema: { type: "object", properties: t.properties, ...(t.required && { required: t.required }), additionalProperties: false },
  annotations: { title: t.title, readOnlyHint: !t.writes, ...(t.writes && { destructiveHint: !!t.destructive, idempotentHint: t.name !== "create_item" }), openWorldHint: false },
});

type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
type Reply = { jsonrpc: "2.0"; id?: unknown; result?: unknown; error?: { code: number; message: string } };

const failure = (id: unknown, code: number, message: string): Reply => ({ jsonrpc: "2.0", ...(id !== undefined && { id }), error: { code, message } });
const answer = (status: number, body?: unknown, headers: Record<string, string> = {}): ApiResponse => ({ status, json: body, headers });

/** A tool's result: the answer as JSON text (and structured), or the API's refusal as an error the model can act on. */
async function callTool(tool: Tool, args: Args, api: Api): Promise<unknown> {
  const missing = (tool.required ?? []).filter((k) => args[k] === undefined || args[k] === null || args[k] === "");
  if (missing.length > 0) return { content: [{ type: "text", text: `Missing: ${missing.join(", ")}` }], isError: true };
  const { method, path, query, body } = tool.request(args);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) params.set(k, v);
  const bytes = new TextEncoder().encode(body === undefined ? "" : JSON.stringify(body));
  let response: ApiResponse;
  try {
    response = await api({
      method,
      path,
      query: params,
      headers: { "content-type": "application/json" },
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
