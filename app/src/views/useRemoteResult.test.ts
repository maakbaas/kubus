// @vitest-environment node
// A remote block's paging, in the hook host (test/hooks.ts) against a stand-in sources client.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SOURCE_PAGE, type SourceColumn, type SourceQuery, type SourceResult, type SourceRow } from "../../../shared/sources";
import { blankField, type Collection } from "../domain/model";
import { defaultQuery, type ViewQuery } from "../domain/query";
import { renderHook } from "../test/hooks";

const m = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock("../app/store", () => ({ useStore: () => m.store }));
const { useRemoteResult } = await import("./useRemoteResult");

const columns: SourceColumn[] = [
  { name: "id", type: "integer", kind: "number" },
  { name: "name", type: "text", kind: "string" },
  { name: "done", type: "boolean", kind: "checkbox" },
];
const tasks: Collection = {
  id: "tasks", name: "Task", pluralName: "Tasks", icon: null, description: "", itemViews: [], spaceIds: null, createdAt: "", updatedAt: "",
  source: { name: "CRM", target: { table: { schema: "public", name: "tasks" } }, key: "id", columns },
  fields: [blankField("f-name", "Name", "string", { column: "name" }), blankField("f-done", "Done", "checkbox", { column: "done" })],
};
const row = (n: number, group?: string): SourceRow => ({ key: String(n), values: [`task ${n}`, false], ...(group !== undefined && { group }) });
const rows = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => row(from + i));

/** A sources client whose answers are given by the test, one per call, in order (or at once when a function). */
function sources(answer: (query: SourceQuery, call: number) => SourceResult | Promise<SourceResult>) {
  const calls: SourceQuery[] = [];
  const refreshers = new Set<(id: string | null) => void>();
  return {
    calls,
    query: vi.fn(async (_name: string, query: SourceQuery) => {
      calls.push(query);
      return answer(query, calls.length - 1);
    }),
    remember: vi.fn(),
    onRefresh: (l: (id: string | null) => void) => (refreshers.add(l), () => void refreshers.delete(l)),
    refresh: (id: string | null) => refreshers.forEach((l) => l(id)),
  };
}

interface Props {
  collection?: Collection;
  query?: ViewQuery;
  search?: string;
  enabled?: boolean;
  all?: boolean;
  page?: number;
}
const query0 = defaultQuery();
const hook = (client: ReturnType<typeof sources>, props: Props = {}) => {
  m.store = { sources: client, components: [] };
  return renderHook(
    (p: Props) => useRemoteResult(p.collection ?? tasks, p.query ?? query0, p.search ?? "", p.enabled ?? true, p.all, p.page),
    { props },
  );
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const settle = async (h: { settle(): Promise<void> }, ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
  await h.settle();
};

describe("the first page", () => {
  it("is null for a block that isn't remote (a native collection, or not enabled)", async () => {
    const client = sources(() => ({ rows: [], more: false }));
    const native = { ...tasks, source: undefined } as Collection;
    expect(hook(client, { collection: native }).result.current).toBeNull();
    expect(hook(client, { enabled: false }).result.current).toBeNull();
    await vi.advanceTimersByTimeAsync(10);
    expect(client.query).not.toHaveBeenCalled();
  });

  it("is waited for, then shown as one group of items with the total", async () => {
    const client = sources(() => ({ rows: rows(1, 3), more: false, total: 3 }));
    const h = hook(client);
    expect(h.result.current).toMatchObject({ waiting: true, items: null, more: null, error: undefined });
    expect(h.result.current!.result).toEqual({ groups: [], total: 0 });
    await settle(h);
    const r = h.result.current!;
    expect(r.waiting).toBe(false);
    expect(r.result.total).toBe(3);
    expect(r.result.groups).toHaveLength(1);
    expect(r.result.groups[0].items.map((i) => i.values["f-name"])).toEqual(["task 1", "task 2", "task 3"]);
    expect(r.items).toHaveLength(3);
    expect(r.more).toBeNull();
    expect(client.query).toHaveBeenCalledWith("CRM", expect.objectContaining({ offset: 0, limit: 100, counts: true, search: "", groupBy: null }));
    expect(client.remember).toHaveBeenCalled(); // so an item page opened from the list shows at once
  });

  it("asks for the block's Limit as the page size, never more than a page may be", async () => {
    const client = sources(() => ({ rows: [], more: false }));
    await settle(hook(client, { page: 25 }));
    expect(client.calls[0].limit).toBe(25);
    await settle(hook(client, { page: 5 * MAX_SOURCE_PAGE }));
    expect(client.calls[1].limit).toBe(MAX_SOURCE_PAGE);
  });

  it("shows a failure as the error, with nothing to show more of", async () => {
    const client = sources(() => Promise.reject(new Error("The server answered 502")));
    const h = hook(client);
    await settle(h);
    expect(h.result.current).toMatchObject({ error: "The server answered 502", waiting: false, items: [], more: null });
  });

  it("asks again when the source is refreshed for this collection, not for another", async () => {
    let n = 0;
    const client = sources(() => ({ rows: rows(1, ++n), more: false }));
    const h = hook(client);
    await settle(h);
    expect(h.result.current!.items).toHaveLength(1);
    client.refresh("other");
    await settle(h);
    expect(client.query).toHaveBeenCalledTimes(1);
    client.refresh("tasks");
    expect(h.result.current).toBeTruthy();
    await settle(h);
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(h.result.current!.items).toHaveLength(2);
    client.refresh(null); // everything
    await settle(h);
    expect(client.query).toHaveBeenCalledTimes(3);
  });

  it("keeps the rows of the query before while a changed one is asked, and drops a late answer to the old one", async () => {
    const pending: ((r: SourceResult) => void)[] = [];
    const client = sources((_q, call) => (call === 0 ? { rows: rows(1, 2), more: false } : new Promise((r) => pending.push(r))));
    const h = hook(client);
    await settle(h);
    h.rerender({ search: "a" });
    await settle(h, 300); // typing paused: asked
    expect(client.calls).toHaveLength(2);
    expect(h.result.current).toMatchObject({ waiting: true });
    expect(h.result.current!.items).toHaveLength(2); // nothing flashes away
    h.rerender({ search: "ab" });
    await settle(h, 300);
    expect(client.calls).toHaveLength(3);
    pending[0]({ rows: [row(9)], more: false }); // the answer to "a" arrives late
    await settle(h);
    expect(h.result.current!.waiting).toBe(true);
    expect(h.result.current!.items!.map((i) => i.values["f-name"])).toEqual(["task 1", "task 2"]);
    pending[1]({ rows: [row(7)], more: false });
    await settle(h);
    expect(h.result.current).toMatchObject({ waiting: false });
    expect(h.result.current!.items!.map((i) => i.values["f-name"])).toEqual(["task 7"]);
  });
});

describe("searching", () => {
  it("asks once typing pauses, trimmed, not at every keystroke", async () => {
    const client = sources(() => ({ rows: [], more: false }));
    const h = hook(client);
    await settle(h);
    h.rerender({ search: "d" });
    await settle(h, 200);
    h.rerender({ search: "du" });
    await settle(h, 200);
    expect(client.calls).toHaveLength(1);
    await settle(h, 150);
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1].search).toBe("du");
  });
});

describe("more rows", () => {
  it("'Show more' adds the next page after the rows in, without asking for counts again", async () => {
    let release!: () => void;
    const client = sources((q) => (q.offset === 0 ? { rows: rows(1, 2), more: true, total: 5 } : new Promise((r) => (release = () => r({ rows: rows(3, 4), more: true })))));
    const h = hook(client);
    await settle(h);
    expect(h.result.current!.more).toBeInstanceOf(Function);
    h.result.current!.more!();
    await h.settle();
    expect(h.result.current!.loadingMore).toBe(true);
    release();
    await settle(h);
    expect(client.calls[1]).toMatchObject({ offset: 2, limit: 100, counts: false });
    const r = h.result.current!;
    expect(r.loadingMore).toBe(false);
    expect(r.items!.map((i) => i.values["f-name"])).toEqual(["task 1", "task 2", "task 3", "task 4"]);
    expect(r.result.total).toBe(5);
    expect(r.more).toBeInstanceOf(Function);
  });

  it("the earlier rows keep their items when a page is added", async () => {
    const client = sources((q) => (q.offset === 0 ? { rows: rows(1, 2), more: true } : { rows: rows(3, 3), more: false }));
    const h = hook(client);
    await settle(h);
    const before = h.result.current!.items!;
    h.result.current!.more!();
    await settle(h);
    expect(h.result.current!.items!.slice(0, 2)).toEqual(before);
    expect(h.result.current!.items![0]).toBe(before[0]);
    expect(h.result.current!.more).toBeNull();
  });

  it("raises the total to the rows in when the source counted fewer", async () => {
    const client = sources((q) => (q.offset === 0 ? { rows: rows(1, 2), more: true, total: 2 } : { rows: rows(3, 4), more: false }));
    const h = hook(client);
    await settle(h);
    h.result.current!.more!();
    await settle(h);
    expect(h.result.current!.result.total).toBe(4);
  });

  it("a failing page is the error; the rows in stay", async () => {
    const client = sources((q) => (q.offset === 0 ? { rows: rows(1, 2), more: true } : Promise.reject(new Error("timeout"))));
    const h = hook(client);
    await settle(h);
    h.result.current!.more!();
    await settle(h);
    expect(h.result.current).toMatchObject({ error: "timeout", loadingMore: false });
    expect(h.result.current!.items).toHaveLength(2);
  });

  it("asking for more while a page is on its way does nothing", async () => {
    const client = sources((q) => (q.offset === 0 ? { rows: rows(1, 2), more: true } : new Promise<SourceResult>(() => {})));
    const h = hook(client);
    await settle(h);
    const more = h.result.current!.more!;
    more();
    await h.settle();
    h.result.current!.more!();
    await settle(h);
    expect(client.calls).toHaveLength(2);
    void more;
  });
});

/** A sources client whose pages are answered by the test, in the order asked: `answerNext` gives the oldest waiting one its rows. */
function paged(total: number, perPage: number) {
  const waiting: ((r: SourceResult) => void)[] = [];
  const failures: ((e: Error) => void)[] = [];
  const client = sources(
    () =>
      new Promise<SourceResult>((resolve, reject) => {
        waiting.push(resolve);
        failures.push(reject);
      }),
  );
  return {
    client,
    /** Answers the oldest unanswered request with the next page of `total` rows. */
    async answerNext(h: { settle(): Promise<void> }) {
      const query = client.calls[client.calls.length - waiting.length];
      waiting.shift()!({ rows: rows(query.offset + 1, Math.min(query.offset + perPage, total)), more: query.offset + perPage < total, total });
      failures.shift();
      await h.settle();
    },
    async failNext(h: { settle(): Promise<void> }, message: string) {
      waiting.shift();
      failures.shift()!(new Error(message));
      await h.settle();
    },
  };
}

describe("every row", () => {
  it("loads the pages one after the other in big pages, shows how far it is, and ends with all rows", async () => {
    const p = paged(6, 2);
    const h = hook(p.client, { all: true });
    await settle(h);
    expect(p.client.calls[0].limit).toBe(MAX_SOURCE_PAGE);
    await p.answerNext(h);
    expect(h.result.current!.progress).toMatchObject({ loaded: 2, total: 6 });
    expect(h.result.current!.more).toBeNull(); // loading them all: nothing to ask for
    expect(p.client.calls).toHaveLength(2); // the next page was asked as soon as this one was in
    expect(p.client.calls[1]).toMatchObject({ offset: 2, counts: false });
    await p.answerNext(h);
    await p.answerNext(h);
    await settle(h, 1100);
    expect(p.client.calls.map((c) => c.offset)).toEqual([0, 2, 4]);
    const r = h.result.current!;
    expect(r.items).toHaveLength(6);
    expect(r.progress).toBeNull();
    expect(r.more).toBeNull();
  });

  it("the person can stop it; the pages in stay, and 'Load all rows' goes on", async () => {
    const p = paged(10, 2);
    const h = hook(p.client, { all: true });
    await settle(h);
    await p.answerNext(h);
    expect(p.client.calls).toHaveLength(2);
    h.result.current!.progress!.cancel();
    await p.answerNext(h); // the page on its way still arrives...
    await settle(h, 1100);
    expect(p.client.calls).toHaveLength(2); // ...but no further one is asked
    expect(h.result.current!.progress).toBeNull();
    expect(h.result.current!.items).toHaveLength(4);
    expect(h.result.current!.more).toBeInstanceOf(Function);
    h.result.current!.more!(); // "Load all rows"
    await h.settle();
    expect(p.client.calls).toHaveLength(3);
    await p.answerNext(h);
    expect(h.result.current!.progress).toMatchObject({ loaded: 6, total: 10 });
  });

  it("stop() ends the loading too", async () => {
    const p = paged(10, 2);
    const h = hook(p.client, { all: true });
    await settle(h);
    await p.answerNext(h);
    h.result.current!.stop();
    await p.answerNext(h);
    await settle(h, 1100);
    expect(p.client.calls).toHaveLength(2);
  });

  it("stops by itself when a page fails", async () => {
    const p = paged(10, 2);
    const h = hook(p.client, { all: true });
    await settle(h);
    await p.answerNext(h);
    await p.failNext(h, "gone");
    await settle(h, 1100);
    expect(p.client.calls).toHaveLength(2);
    expect(h.result.current).toMatchObject({ error: "gone", progress: null });
    expect(h.result.current!.items).toHaveLength(2);
  });

  it("while rows come in, the block is given them at most once a second", async () => {
    const p = paged(4, 1);
    const h = hook(p.client, { all: true });
    await settle(h);
    await p.answerNext(h);
    expect(h.result.current!.items).toHaveLength(1);
    await p.answerNext(h);
    expect(h.result.current!.items).toHaveLength(1); // held back
    await settle(h, 1100);
    expect(h.result.current!.items).toHaveLength(2);
    await p.answerNext(h);
    await p.answerNext(h);
    await settle(h, 1100);
    expect(h.result.current!.items).toHaveLength(4);
    expect(h.result.current!.progress).toBeNull();
  });
});

describe("grouping", () => {
  it("lists groups in the source's order, with the rows of each, labelled", async () => {
    const client = sources(() => ({
      rows: [row(1, "yes"), row(2, "no"), row(3, "yes")],
      more: false,
      total: 3,
      groups: [{ key: "no", count: 1 }, { key: "yes", count: 2 }],
    }));
    const h = hook(client, { query: { ...query0, groupBy: "f-done" } });
    await settle(h);
    expect(client.calls[0].groupBy).toBe("done");
    expect(h.result.current!.result.groups.map((g) => [g.key, g.label, g.items.length])).toEqual([["no", "Not checked", 1], ["yes", "Checked", 2]]);
    expect(h.result.current!.items).toHaveLength(3);
  });
});
