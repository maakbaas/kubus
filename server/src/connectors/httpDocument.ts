import { createHash } from "node:crypto";
import { SourceError } from "./connector.ts";

// One document read over HTTP(S) for a connector that reads a file rather than a database (a calendar's
// ICS, JSON, CSV: ics.ts, json.ts, csv.ts). One GET, kept about a minute (every page, count and item
// page of a view comes from one read), then asked again with `If-None-Match` / `If-Modified-Since`, so
// an unchanged document isn't sent again. Bounded by the source's time limit and a size limit, and what
// goes wrong (a status code, a web page where JSON was expected) is said in words: the source's problem
// in the settings. Only GETs: like every connector, it never writes.

/** How long a read document is used as it is. */
export const DOCUMENT_TTL_MS = 60_000;
/** The largest document read. */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
/** The most documents kept (the oldest is forgotten first). */
const MAX_KEPT = 32;

export interface HttpDocument {
  /** Where it was read from in the end (after redirects). */
  url: string;
  status: number;
  /** Its Content-Type, lowercased ("" when none). */
  contentType: string;
  headers: Headers;
  bytes: Uint8Array;
  /** Its text (UTF-8, a byte order mark dropped). */
  text: string;
}

export interface DocumentRequest {
  /** Sent with the GET (Authorization, an API key's header); part of what the kept copy is kept by. */
  headers?: Record<string, string>;
  timeoutMs: number;
  /** What it is, for problems: "a calendar", "JSON". */
  what: string;
  /** Whether a Content-Type is one it reads (unchecked when absent; an empty one always passes). */
  accepts?: (contentType: string) => boolean;
  maxBytes?: number;
}

interface Kept {
  doc: HttpDocument;
  at: number;
  etag: string | null;
  lastModified: string | null;
}

const kept = new Map<string, Kept>();
const reading = new Map<string, Promise<HttpDocument>>();

/** Forgets every kept document (tests). */
export function forgetDocuments() {
  kept.clear();
  reading.clear();
}

/**
 * An address typed with or without its scheme, as an http(s) URL: https:// unless it says http://;
 * `webcal://` and `webcals://` (calendar subscriptions) are read over https.
 */
export function documentAddress(typed: string): URL {
  const t = typed.trim();
  if (!t) throw new SourceError("There is no address: set it in Settings → Connections");
  const withScheme = /^webcals?:\/\//i.test(t) ? t.replace(/^webcals?:/i, "https:") : /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new SourceError("The address isn't one (https://example.com/…)");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new SourceError(`The address starts with https://, http:// or webcal:// (not ${u.protocol}//)`);
  return u;
}

/** The next page's address from a `Link: <…>; rel="next"` header, or null. */
export function nextLink(doc: HttpDocument): string | null {
  const link = doc.headers.get("link");
  if (!link) return null;
  for (const part of link.split(/,(?=\s*<)/)) {
    const m = /<([^>]*)>\s*;(.*)$/.exec(part.trim());
    if (m && /(^|;)\s*rel\s*=\s*"?(?:[^";]*\s)?next(?:\s[^";]*)?"?\s*(;|$)/i.test(m[2])) return new URL(m[1], doc.url).toString();
  }
  return null;
}

/** What a status code means for whoever set the source up. */
function statusProblem(status: number, what: string): string {
  if (status === 401 || status === 403) return `The address answers ${status}: it doesn't accept the password (or needs one)`;
  if (status === 404 || status === 410) return `There is no ${what} at the address (${status})`;
  if (status === 429) return "The address answers 429: too many requests, try again later";
  if (status >= 500) return `The address answers ${status}: its server has a problem`;
  return `The address answers ${status}`;
}

const keyOf = (url: string, headers: Record<string, string>) => createHash("sha256").update(JSON.stringify([url, Object.entries(headers).sort()])).digest("hex");

/** The document at `url`: the kept copy while it is fresh, else read (or revalidated). Problems are Errors (the source's), not SourceErrors. */
export function fetchDocument(url: URL | string, request: DocumentRequest, now = Date.now()): Promise<HttpDocument> {
  const address = url.toString();
  const headers = request.headers ?? {};
  const key = keyOf(address, headers);
  const have = kept.get(key);
  if (have && now - have.at < DOCUMENT_TTL_MS) return Promise.resolve(have.doc);
  // Asked for twice at once (a view's page and its counts): read once.
  const pending = reading.get(key);
  if (pending) return pending;
  const read = readDocument(address, request, have).then(
    (doc) => {
      kept.delete(key);
      kept.set(key, { doc, at: now, etag: doc.headers.get("etag"), lastModified: doc.headers.get("last-modified") });
      while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value!);
      return doc;
    },
  ).finally(() => reading.delete(key));
  reading.set(key, read);
  return read;
}

async function readDocument(address: string, request: DocumentRequest, have: Kept | undefined): Promise<HttpDocument> {
  const maxBytes = request.maxBytes ?? MAX_DOCUMENT_BYTES;
  const headers: Record<string, string> = { "User-Agent": "Kubus", ...request.headers };
  if (have?.etag) headers["If-None-Match"] = have.etag;
  if (have?.lastModified) headers["If-Modified-Since"] = have.lastModified;
  const signal = AbortSignal.timeout(request.timeoutMs);
  let res: Response;
  try {
    res = await fetch(address, { method: "GET", headers, signal, redirect: "follow" });
  } catch (e) {
    if (signal.aborted) throw new Error(`The address didn't answer within ${Math.round(request.timeoutMs / 1000)} s`, { cause: e });
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    throw new Error(`Can't reach the address${cause?.code ? ` (${cause.code})` : cause?.message ? `: ${cause.message}` : ""}`, { cause: e });
  }
  if (res.status === 304 && have) {
    await res.body?.cancel();
    return have.doc;
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(statusProblem(res.status, request.what));
  }
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (contentType && request.accepts && !request.accepts(contentType)) {
    await res.body?.cancel();
    const page = /^text\/html|^application\/xhtml/.test(contentType);
    throw new Error(
      page
        ? `The address answers with a web page, not ${request.what}: is it the document's own address (not a page about it, or a login)?`
        : `The address answers with ${contentType.split(";")[0]}, not ${request.what}`,
    );
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw new Error(tooLarge(maxBytes));
  }
  const bytes = await readBounded(res, maxBytes, signal, request.timeoutMs);
  const text = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
  return { url: res.url || address, status: res.status, contentType, headers: res.headers, bytes, text };
}

const tooLarge = (maxBytes: number) => `The document is larger than ${Math.round(maxBytes / 1024 / 1024)} MB, more than a source reads`;

async function readBounded(res: Response, maxBytes: number, signal: AbortSignal, timeoutMs: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(tooLarge(maxBytes));
      }
      chunks.push(value);
    }
  } catch (e) {
    if (signal.aborted) throw new Error(`The address didn't send the document within ${Math.round(timeoutMs / 1000)} s`, { cause: e });
    throw e;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
