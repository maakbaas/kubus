import type { IncomingMessage, ServerResponse } from "node:http";

// Server-sent events: a signal for connected devices that rows changed ("sync now"). The data
// itself always travels through POST /api/sync, so a missed signal costs nothing (devices also
// sync every 30 s). Each signal carries the cursor of the write, so a device that has it (its own
// push, mostly) doesn't sync for it.

const clients = new Set<ServerResponse>();
/** The cursor of the latest write (0: none since the database was made or wiped). */
let latest = 0;

/** The cursor of the latest write: a device at it (or beyond) has everything. */
export const latestCursor = () => latest;

export function handleEvents(req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // nginx: don't buffer
  });
  res.write(": connected\n\n");
  clients.add(res);
  req.on("close", () => clients.delete(res));
}

/**
 * Rows changed, up to `cursor`; 0 = the database was wiped (also at start, with the cursor of the
 * stored data). Requests finish out of order: the latest write is the highest cursor.
 */
export function broadcast(cursor: number) {
  latest = cursor === 0 ? 0 : Math.max(latest, cursor);
  for (const res of clients) res.write(`data: ${cursor}\n\n`);
}

// Keeps idle connections open through proxies.
setInterval(() => {
  for (const res of clients) res.write(": ping\n\n");
}, 25_000).unref();
