import type { IncomingMessage, ServerResponse } from "node:http";

// Server-sent events: a signal for connected devices that rows changed ("sync now"). The data
// itself always travels through POST /api/sync, so a missed signal costs nothing (devices also
// sync every 30 s).

const clients = new Set<ServerResponse>();

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

export function broadcast(cursor: number) {
  for (const res of clients) res.write(`data: ${cursor}\n\n`);
}

// Keeps idle connections open through proxies.
setInterval(() => {
  for (const res of clients) res.write(": ping\n\n");
}, 25_000).unref();
