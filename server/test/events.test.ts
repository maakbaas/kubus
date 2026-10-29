// @vitest-environment node
// The change signal (src/events.ts): connected devices hear every write's cursor.
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { broadcast, handleEvents, latestCursor } from "../src/events.ts";

/** A connected device: the response it reads, and the request whose close drops it. */
function connect() {
  const req = new EventEmitter();
  const written: string[] = [];
  let head: { status: number; headers: Record<string, string> } | undefined;
  const res = {
    writeHead: (status: number, headers: Record<string, string>) => (head = { status, headers }),
    write: (chunk: string) => (written.push(chunk), true),
  };
  handleEvents(req as IncomingMessage, res as unknown as ServerResponse);
  return { written, head: head!, close: () => req.emit("close") };
}

describe("server-sent events", () => {
  it("opens an unbuffered event stream, and says it is connected", () => {
    const device = connect();
    expect(device.head.status).toBe(200);
    expect(device.head.headers).toMatchObject({ "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" });
    expect(device.head.headers["Cache-Control"]).toContain("no-cache");
    expect(device.written).toEqual([": connected\n\n"]);
    device.close();
  });

  it("signals every connected device with the write's cursor, and none that left", () => {
    const a = connect();
    const b = connect();
    broadcast(7);
    b.close();
    broadcast(9);
    expect(a.written.slice(1)).toEqual(["data: 7\n\n", "data: 9\n\n"]);
    expect(b.written.slice(1)).toEqual(["data: 7\n\n"]);
    a.close();
  });

  it("keeps the highest cursor as the latest, as requests finish out of order, and 0 (a wipe) starts over", () => {
    broadcast(0);
    expect(latestCursor()).toBe(0);
    broadcast(12);
    broadcast(10);
    expect(latestCursor()).toBe(12);
    broadcast(0);
    expect(latestCursor()).toBe(0);
    broadcast(3);
    expect(latestCursor()).toBe(3);
  });

  it("tells devices of a wipe with 0", () => {
    const device = connect();
    broadcast(0);
    expect(device.written.at(-1)).toBe("data: 0\n\n");
    device.close();
  });

  it("pings every connected device every 25 seconds, through proxies that would drop a silent stream", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    try {
      const events = await import("../src/events.ts");
      const req = new EventEmitter();
      const written: string[] = [];
      events.handleEvents(req as IncomingMessage, { writeHead: () => undefined, write: (c: string) => (written.push(c), true) } as unknown as ServerResponse);
      vi.advanceTimersByTime(25_000);
      vi.advanceTimersByTime(25_000);
      expect(written).toEqual([": connected\n\n", ": ping\n\n", ": ping\n\n"]);
      req.emit("close");
      vi.advanceTimersByTime(25_000);
      expect(written).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
