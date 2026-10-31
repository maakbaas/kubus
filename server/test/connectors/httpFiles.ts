// A real HTTP server (port 0) serving real files from a directory, for the connectors that read a document
// over HTTP (csv, json, ics). Besides plain files it does what servers do to documents: content types by
// extension, ETag / Last-Modified and 304, a chunked body, gzip, redirects (and to another origin), a slow
// answer, a body cut off half way, a wrong Content-Length, a password in a header, a query parameter or the
// path, `Link: rel="next"` pages. Every request is kept in `seen`.
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { gzipSync } from "node:zlib";

const TYPES: Record<string, string> = {
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json",
  ".ndjson": "application/x-ndjson",
  ".ics": "text/calendar; charset=utf-8",
  ".txt": "text/plain",
  ".html": "text/html",
};

export interface Served {
  server: Server;
  base: string;
  seen: IncomingMessage[];
  close: () => Promise<void>;
}

/** The password the protected routes want. */
export const PASSWORD = "s3cret";

/** Serves `dir` (a file at /name), and the special routes below. */
export async function serve(dir: string, options: { other?: string } = {}): Promise<Served> {
  const seen: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    seen.push(req);
    handle(dir, options.other ?? "", req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    base: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function file(dir: string, name: string): { path: string; type: string; size: number; mtime: Date } | null {
  const path = join(dir, normalize(name).replace(/^(\.\.[/\\])+/, ""));
  try {
    const s = statSync(path);
    return s.isFile() ? { path, type: TYPES[extname(path)] ?? "application/octet-stream", size: s.size, mtime: s.mtime } : null;
  } catch {
    return null;
  }
}

function handle(dir: string, other: string, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const path = decodeURIComponent(url.pathname);
  const bearer = req.headers.authorization === `Bearer ${PASSWORD}`;
  const deny = () => res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("no");

  // Protected: the password as Bearer, in a header, in a query parameter, or in the path.
  if (path.startsWith("/bearer/")) return bearer ? send(dir, path.slice("/bearer".length), req, res) : deny();
  if (path.startsWith("/header/")) return req.headers["x-api-key"] === PASSWORD ? send(dir, path.slice("/header".length), req, res) : deny();
  if (path.startsWith("/param/")) return url.searchParams.get("key") === PASSWORD ? send(dir, path.slice("/param".length), req, res) : deny();
  if (path.startsWith(`/secret/${PASSWORD}/`)) return send(dir, path.slice(`/secret/${PASSWORD}`.length), req, res);
  // Redirects: one hop, a chain, a loop, to another origin.
  if (path.startsWith("/redirect/")) return res.writeHead(Number(url.searchParams.get("status") ?? 302), { Location: path.slice("/redirect".length) }).end();
  if (path === "/chain/a") return res.writeHead(301, { Location: "/chain/b" }).end();
  if (path === "/chain/b") return res.writeHead(307, { Location: "/people.csv" }).end();
  if (path === "/loop") return res.writeHead(302, { Location: "/loop" }).end();
  if (path.startsWith("/away/")) return res.writeHead(302, { Location: `${other}${path.slice("/away".length)}` }).end();
  // Slow: the first byte late, or a body that stops.
  if (path.startsWith("/slow/")) return void setTimeout(() => send(dir, path.slice("/slow".length), req, res), Number(url.searchParams.get("ms") ?? 500));
  if (path.startsWith("/stall/")) {
    const f = file(dir, path.slice("/stall".length));
    if (!f) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": f.type });
    res.write(readFileSync(f.path).subarray(0, 10));
    return; // never ends
  }
  // Cut off: the connection closes half way through the body, and a Content-Length that is more than comes.
  if (path.startsWith("/cut/")) {
    const f = file(dir, path.slice("/cut".length));
    if (!f) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": f.type, "Content-Length": f.size });
    res.write(readFileSync(f.path).subarray(0, Math.floor(f.size / 2)));
    return void setTimeout(() => res.destroy(), 20);
  }
  // Status codes.
  const status = /^\/status\/(\d+)$/.exec(path);
  if (status) return res.writeHead(Number(status[1]), { "Content-Type": "text/plain" }).end("status");
  // Pages of a list: /pages/people.json?page=n links to the next, from files people-1.json …
  const page = /^\/pages\/([a-z]+)-(\d+)\.(json|csv)$/.exec(path);
  if (page) {
    const next = Number(page[2]) + 1;
    if (file(dir, `${page[1]}-${next}.${page[3]}`)) res.setHeader("Link", `<${req.headers.host ? `http://${req.headers.host}` : ""}/pages/${page[1]}-${next}.${page[3]}>; rel="next"`);
    return send(dir, `/${page[1]}-${page[2]}.${page[3]}`, req, res);
  }
  // A web page where a document was asked for.
  if (path === "/login") return res.writeHead(200, { "Content-Type": "text/html" }).end("<html><body>Please sign in</body></html>");
  // The content type forced: /as/<type>/<file> (type with _ for /).
  const as = /^\/as\/([^/]+)(\/.*)$/.exec(path);
  if (as) return send(dir, as[2], req, res, as[1].replace("_", "/"));
  if (path.startsWith("/gzip/")) return send(dir, path.slice("/gzip".length), req, res, undefined, true);
  if (path.startsWith("/nolength/")) return send(dir, path.slice("/nolength".length), req, res, undefined, false, true);
  send(dir, path, req, res);
}

/** A file: its type from its extension, an ETag and Last-Modified, 304 when the client has it. */
function send(dir: string, name: string, req: IncomingMessage, res: ServerResponse, type?: string, gzip = false, chunked = false) {
  const f = file(dir, name);
  if (!f) return void res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  const etag = `"${f.size}-${f.mtime.getTime()}"`;
  if (req.headers["if-none-match"] === etag) return void res.writeHead(304, { ETag: etag }).end();
  const headers: Record<string, string | number> = { "Content-Type": type ?? f.type, ETag: etag, "Last-Modified": f.mtime.toUTCString() };
  if (gzip) {
    const body = gzipSync(readFileSync(f.path));
    return void res.writeHead(200, { ...headers, "Content-Encoding": "gzip", "Content-Length": body.length }).end(body);
  }
  if (chunked) {
    res.writeHead(200, headers);
    return void createReadStream(f.path, { highWaterMark: 16_384 }).pipe(res);
  }
  // The bytes read now, with their own length: a stream opened later could read a file rewritten meanwhile (a test
  // changing it), longer than the length said, and the rest would be taken for the next response on the connection.
  const body = readFileSync(f.path);
  res.writeHead(200, { ...headers, "Content-Length": body.length }).end(body);
}
