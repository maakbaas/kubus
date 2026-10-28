import type { SourceConfig } from "./connector.ts";
import type { HttpDocument } from "./httpDocument.ts";
import { HttpTableConnector } from "./httpTable.ts";

// JSON over HTTP (kind "json"): one document (and its next pages) whose rows are at "Rows at", a
// JSON Pointer (RFC 6901: /data/items, ~1 for "/", ~0 for "~"; empty: the top level), or NDJSON
// (one row per line, told by its content type or by its lines: "Rows at" is then not used). A row
// is an object, its objects flattened one level ("address.city"; deeper ones JSON text); a value
// that isn't an object is a row with one column, `value`. An object where the rows were expected
// is one row, unless it holds lists of objects: then it's a problem naming them (the rows are likely there).
// Read and queried by httpTable.ts.

const ACCEPTS = /^(application\/(json|x-ndjson|ndjson|jsonl|x-jsonl|json-seq)|application\/[^;]*\+json|text\/plain|text\/json)\b/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A JSON Pointer's tokens ("" or "/": none; a missing leading "/" is added). */
export function pointerTokens(pointer: string): string[] {
  const p = pointer.trim().replace(/^#/, "");
  if (p === "" || p === "/") return [];
  return (p.startsWith("/") ? p : `/${p}`)
    .slice(1)
    .split("/")
    .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** A JSON Pointer as written ("/a/b"), its tokens escaped again. */
const pointerOf = (tokens: string[]) => (tokens.length ? tokens.map((t) => `/${t.replace(/~/g, "~0").replace(/\//g, "~1")}`).join("") : "/");

/** The value at a pointer, or a problem saying where it stops. */
export function atPointer(doc: unknown, pointer: string): unknown {
  const tokens = pointerTokens(pointer);
  let at: unknown = doc;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const found = Array.isArray(at) ? (/^(0|[1-9]\d*)$/.test(t) ? at[Number(t)] : undefined) : isObject(at) && Object.hasOwn(at, t) ? at[t] : undefined;
    if (found === undefined) throw new Error(`There is nothing at “${pointerOf(tokens.slice(0, i + 1))}” in the document (Rows at)`);
    at = found;
  }
  return at;
}

/** A record with its objects flattened one level: { address: { city } } → { "address.city" }. */
export function flatten(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (isObject(v)) for (const [k2, v2] of Object.entries(v)) out[`${k}.${k2}`] ??= v2;
    else out[k] ??= v;
  }
  return out;
}

/** The lists of objects in an object, as pointers (its own and its objects'), for a problem's hint. */
function listsIn(value: Record<string, unknown>, at: string[], depth = 0): string[] {
  return Object.entries(value).flatMap(([k, v]) =>
    Array.isArray(v) && v.some(isObject) ? [pointerOf([...at, k])] : isObject(v) && depth < 2 ? listsIn(v, [...at, k], depth + 1) : [],
  );
}

/** The lines of NDJSON, each parsed, or null when a line isn't JSON. */
function lines(text: string): unknown[] | null {
  const out: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      return null;
    }
  }
  return out;
}

/** A document's rows: NDJSON's lines, else the value at `pointer`. */
export function jsonRecords(text: string, contentType: string, pointer: string): Record<string, unknown>[] {
  return jsonValues(text, contentType, pointer).map((v) => (isObject(v) ? flatten(v) : { value: v }));
}

function jsonValues(text: string, contentType: string, pointer: string): unknown[] {
  if (/ndjson|jsonl|json-seq/.test(contentType)) {
    const parsed = lines(text.replace(/\x1e/g, ""));
    if (!parsed) throw new Error("The document isn't NDJSON (a line isn't JSON)");
    return parsed;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    const parsed = text.trim().includes("\n") ? lines(text) : null;
    if (!parsed) throw new Error(text.trim() ? "The document isn't JSON" : "The document is empty");
    return parsed;
  }
  const at = atPointer(doc, pointer);
  const where = pointerOf(pointerTokens(pointer));
  if (Array.isArray(at)) return at;
  if (!isObject(at)) throw new Error(`“${where}” is ${at === null ? "null" : `a ${typeof at}`}, not a list of rows (Rows at)`);
  const lists = listsIn(at, pointerTokens(pointer));
  if (lists.length) throw new Error(`“${where}” is an object, not a list of rows: set Rows at to one of its lists (${lists.slice(0, 5).join(", ")})`);
  return [at];
}

/** The table's name: the pointer's last token, else "rows". */
export function jsonTableName(pointer: string): string {
  const last = pointerTokens(pointer).at(-1)?.trim();
  return last && !/^\d+$/.test(last) ? last : "rows";
}

export class JsonConnector extends HttpTableConnector {
  constructor(config: SourceConfig) {
    const pointer = config.fields.rows ?? "";
    super(config, {
      kind: "json",
      what: "JSON",
      accepts: (t) => ACCEPTS.test(t),
      table: jsonTableName(pointer),
      records: (doc: HttpDocument) => ({ records: jsonRecords(doc.text, doc.contentType, pointer) }),
    });
  }
}
