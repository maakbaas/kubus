// One router for the server's HTTP endpoints: the devices' (/api/sync, /api/files, …, in
// server/src) and the public API (/api/v1, in the headless device). A route is a method, a path
// pattern with {name} placeholders and a handler from request to response, independent of
// node:http, so the headless bundle and tests use it as is. No imports and erasable syntax only,
// so Node runs it directly (as shared/sync.ts).

export interface ApiRequest {
  method: string;
  /** The path without the query, e.g. /api/v1/items/abc */
  path: string;
  query: URLSearchParams;
  /** Lower-case header names. */
  headers: Record<string, string | undefined>;
  /** The body (read on demand, refused beyond `limit` bytes). */
  body(limit: number): Promise<Uint8Array>;
}

export interface ApiResponse {
  status: number;
  /** Sent as JSON, unless `bytes` is given. */
  json?: unknown;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
}

export type RouteHandler = (req: ApiRequest, params: Record<string, string>) => Promise<ApiResponse>;

interface Route {
  method: string;
  pattern: RegExp;
  names: string[];
  handler: RouteHandler;
}

/** An error with its HTTP status, turned into `{ error }` by `Router.handle`. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const json = (status: number, body: unknown): ApiResponse => ({ status, json: body });

/** A request's body as JSON (undefined when it is empty); 400 when it isn't JSON, 413 beyond `limit` bytes. */
export async function readJson(req: ApiRequest, limit: number): Promise<unknown> {
  const bytes = await req.body(limit);
  if (bytes.byteLength === 0) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "The body isn't valid JSON");
  }
}

export class Router {
  private routes: Route[] = [];

  /** `path` like /api/v1/items/{id}; a placeholder matches one path segment. */
  add(method: string, path: string, handler: RouteHandler): this {
    const names: string[] = [];
    const source = path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{(\w+)\}/g, (_, name: string) => {
      names.push(name);
      return "([^/]+)";
    });
    this.routes.push({ method, pattern: new RegExp(`^${source}$`), names, handler });
    return this;
  }

  /** Whether some route has this path (with any method). */
  has(path: string): boolean {
    return this.routes.some((r) => r.pattern.test(path));
  }

  /**
   * Runs the matching route: 404 when no route has the path, 405 when none has it with this
   * method. A thrown HttpError answers with its status, anything else with 500.
   */
  async handle(req: ApiRequest): Promise<ApiResponse> {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.pattern.exec(req.path);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== req.method && !(req.method === "HEAD" && route.method === "GET")) continue;
      const params = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(m[i + 1])]));
      try {
        return await route.handler(req, params);
      } catch (e) {
        if (e instanceof HttpError) return json(e.status, { error: e.message });
        throw e;
      }
    }
    return pathMatched ? json(405, { error: "Method not allowed" }) : json(404, { error: "Not found" });
  }
}
