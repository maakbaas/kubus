// Reading a merged collection a page at a time: each part answers the merged collection's query in its own way (a native part from the
// items in memory, a remote part from its source, asked with the query rewritten to its columns), and the
// answers are merged: in sort order (a k-way merge: each part is asked for more rows only when its rows are used
// up), group by group (group sizes and the total are summed over the parts). Pure apart from the call that asks a
// source; the hook that holds a block's pages is views/useMergedResult.ts.
//
// Caveat: a remote part comes in its source's order, so where text is sorted the merge relies on the source
// ordering it as the app does ("Customer 9" before "Customer 10", case-insensitive); a source with another
// collation can leave rows slightly out of order in the merged list (docs/features.md "Several collections in one block").

import type { SourceQuery, SourceResult } from "../../../shared/sources";
import { mergedItem, mergedRowItem, partConstants, partProjection, type ResolvedPart } from "./mergedCollection";
import type { Collection, FieldDef, Item } from "./model";
import { applyQuery, compareGroups, groupKeysOf, type ItemGroup, type QueryContext, type QueryResult, type ViewQuery } from "./query";
import { canGroup, groupLabel, sourceQuery, sourceShape } from "./sources";

/** A row of a part: its merged item, and the group it is listed in ("" when not grouped, or in the empty group). */
export interface MergedRow {
  item: Item;
  group: string;
}

/** A group of the merged answer: its size over all the parts. */
export interface MergedGroup {
  key: string;
  label: string;
  count: number;
}

/** What a part knows when asked its first page: how many rows match, how they split into groups, and the rows. */
export interface PartOpening {
  total: number;
  groups: { key: string; label?: string; count: number }[];
  rows: MergedRow[];
  more: boolean;
}

/** One part answering the merged collection's query: rows in the query's order (grouped: group by group, in the part's own group order). */
export interface PartStream {
  /** The first page (with the counts). */
  open(limit: number): Promise<PartOpening>;
  /** The following rows, from the `offset`th. */
  next(offset: number, limit: number): Promise<{ rows: MergedRow[]; more: boolean }>;
}

// --- The parts --------------------------------------------------------------------------------------

/** A native part: its items made merged items, the query run over them in memory (so it answers at once, whatever the page). */
export function nativeStream(merged: Collection, items: Item[], query: ViewQuery, search: string, ctx: QueryContext): PartStream {
  const result = applyQuery(merged, items, query, ctx, search);
  const rows: MergedRow[] = result.groups.flatMap((g) => g.items.map((item) => ({ item, group: g.key })));
  const slice = (offset: number, limit: number) => ({ rows: rows.slice(offset, offset + limit), more: offset + limit < rows.length });
  return {
    open: async (limit) => ({
      total: result.total,
      groups: result.groups.map((g) => ({ key: g.key, label: g.label, count: g.items.length })),
      ...slice(0, limit),
    }),
    next: async (offset, limit) => slice(offset, limit),
  };
}

/** The merged items of a native part, each made once while the item and the mapping stay (items keep their identity, which memoized rows rely on). */
export function nativeItems(merged: Collection, part: ResolvedPart, items: Item[], memo: WeakMap<Item, Item>): Item[] {
  return items.map((item) => {
    let made = memo.get(item);
    if (!made) memo.set(item, (made = mergedItem(merged, part, item)));
    return made;
  });
}

/** What asks a source one page of rows (the sources client's `query`). */
export type AskSource = (source: string, query: SourceQuery) => Promise<SourceResult>;

/**
 * A remote part: the merged collection's query rewritten to the part's columns (`partProjection`) and asked of its source, which
 * filters, sorts and groups. A merged column the part doesn't map has no value there, the Collection column is the part's name:
 * rules on them are settled here (`partConstants`), a group by one is one group.
 */
export function remoteStream(merged: Collection, part: ResolvedPart, query: ViewQuery, search: string, timeZone: string, ask: AskSource): PartStream {
  const projection = partProjection(merged, part);
  const shape = sourceShape(projection);
  const groupField = query.groupBy ? merged.fields.find((f) => f.id === query.groupBy) : undefined;
  const shown = groupField ? projection.fields.find((f) => f.id === groupField.id) : undefined;
  // Grouped by a column of the source (it counts and orders the groups), or by something every row has alike (a single group).
  const bySource = !!shown && canGroup(projection, shown);
  const needle = search.trim().toLowerCase();
  // The Collection column is searched like the others: a search that matches the part's name matches all its rows.
  const asked = needle && part.label.toLowerCase().includes(needle) ? "" : search;
  const request = sourceQuery(projection, { ...query, groupBy: bySource ? query.groupBy : null }, asked, timeZone, partConstants(merged, part));
  const constant = groupField && !bySource ? constantGroup(merged, part, groupField) : undefined;
  const ofRow = (row: SourceResult["rows"][number]): MergedRow => ({
    item: mergedRowItem(merged, part, projection, shape, row),
    group: bySource ? (row.group ?? "") : (constant?.key ?? ""),
  });
  const page = (offset: number, limit: number, counts: boolean) => ask(part.collection.source!.name, { ...request, offset, limit, counts });
  return {
    open: async (limit) => {
      const r = await page(0, limit, true);
      const total = Math.max(r.total ?? 0, r.rows.length);
      const groups = bySource ? (r.groups ?? []).map((g) => ({ key: g.key, count: g.count })) : [{ key: constant?.key ?? "", label: constant?.label, count: total }];
      return { total, groups, rows: r.rows.map(ofRow), more: r.more };
    },
    next: async (offset, limit) => {
      const r = await page(offset, limit, false);
      return { rows: r.rows.map(ofRow), more: r.more };
    },
  };
}

/**
 * The one group a remote part's rows fall in when grouped by a field it has no column for: where a native item with the same
 * (no) value would (its Source: the part's name; the others: no value, "(empty)" or "Not checked" for a checkbox).
 */
function constantGroup(merged: Collection, part: ResolvedPart, field: FieldDef): { key: string; label: string } {
  const values = field.id === merged.mergedFrom?.collectionField ? { [field.id]: part.label } : {};
  const item: Item = { id: "", collectionId: merged.id, spaceId: "", values, createdAt: "", updatedAt: "" };
  return groupKeysOf(field, item, { refLabel: () => "" })[0] ?? { key: "", label: "(empty)" };
}

// --- Merging ----------------------------------------------------------------------------------------

interface PartState {
  stream: PartStream;
  /** Rows fetched so far. */
  offset: number;
  more: boolean;
  /** Its rows of each group, how many there are (from its first page). */
  counts: Map<string, number>;
  /** Rows fetched and not yet used, by group, in order. */
  queues: Map<string, MergedRow[]>;
  /** Rows fetched, by group. */
  arrived: Map<string, number>;
}

/**
 * The parts' rows merged: group by group in the order the query lists the groups (by value or size, sizes summed over the
 * parts), within a group in the query's sort order. `take(n)` gives the next n rows; a part is asked for more only when the
 * rows it gave are used up, so a few rows of a huge part cost a page.
 */
export class MergedCursor {
  total = 0;
  groups: MergedGroup[] = [];
  private states: PartState[];
  private at = 0;
  private opened = false;

  constructor(
    streams: PartStream[],
    private compare: (a: Item, b: Item) => number,
    private query: Pick<ViewQuery, "groupOrder">,
    private groupField: Pick<FieldDef, "kind"> | undefined,
    private pageSize: number,
  ) {
    this.states = streams.map((stream) => ({ stream, offset: 0, more: false, counts: new Map(), queues: new Map(), arrived: new Map() }));
  }

  /** Whether every row has been given. */
  get done(): boolean {
    return this.opened && this.at >= this.groups.length;
  }

  private add(p: PartState, rows: MergedRow[]) {
    p.offset += rows.length;
    for (const row of rows) {
      const queue = p.queues.get(row.group);
      if (queue) queue.push(row);
      else p.queues.set(row.group, [row]);
      p.arrived.set(row.group, (p.arrived.get(row.group) ?? 0) + 1);
    }
  }

  /** Asks every part for its first page (together): the total, the groups and their order are known after it. */
  async open(): Promise<void> {
    const openings = await Promise.all(this.states.map((p) => p.stream.open(this.pageSize)));
    const groups = new Map<string, MergedGroup>();
    openings.forEach((o, i) => {
      const p = this.states[i];
      this.total += o.total;
      p.more = o.more && o.rows.length > 0;
      for (const g of o.groups) {
        p.counts.set(g.key, (p.counts.get(g.key) ?? 0) + g.count);
        const had = groups.get(g.key);
        if (had) had.count += g.count;
        else groups.set(g.key, { key: g.key, label: g.label ?? groupLabel(this.groupField as FieldDef | undefined, g.key), count: g.count });
      }
      this.add(p, o.rows);
    });
    const order = this.query.groupOrder ?? "asc";
    const isDate = this.groupField?.kind === "date" || this.groupField?.kind === "datetime";
    this.groups = [...groups.values()].sort((a, b) => compareGroups(a, b, order, isDate));
    this.opened = true;
    this.advance();
  }

  /** Makes sure the part has its next row of the group at hand, asking for another page if it ran out. */
  private async fill(p: PartState, key: string): Promise<void> {
    while ((p.queues.get(key)?.length ?? 0) === 0 && p.more && (p.arrived.get(key) ?? 0) < (p.counts.get(key) ?? 0)) {
      const page = await p.stream.next(p.offset, this.pageSize);
      p.more = page.more && page.rows.length > 0;
      this.add(p, page.rows);
    }
  }

  /** Whether every row of the group has been given: nothing is left in the queues and no part has more of it to fetch. */
  private used(key: string): boolean {
    return this.states.every((p) => (p.queues.get(key)?.length ?? 0) === 0 && (!p.more || (p.arrived.get(key) ?? 0) >= (p.counts.get(key) ?? 0)));
  }

  /** Steps over the groups that are used up (asking nothing), so `done` is right as soon as the last row is given. */
  private advance(): void {
    while (this.at < this.groups.length && this.used(this.groups[this.at].key)) this.at++;
  }

  /** The next `n` rows (fewer at the end). */
  async take(n: number): Promise<MergedRow[]> {
    if (!this.opened) await this.open();
    const out: MergedRow[] = [];
    while (out.length < n && this.at < this.groups.length) {
      const key = this.groups[this.at].key;
      // Each part with rows of the group has its next one at hand (asked for only now that it is needed).
      await Promise.all(this.states.map((p) => this.fill(p, key)));
      let best: PartState | undefined;
      for (const p of this.states) {
        const head = p.queues.get(key)?.[0];
        if (head && (!best || this.compare(head.item, best.queues.get(key)![0].item) < 0)) best = p;
      }
      if (!best) {
        this.at++;
        this.advance();
        continue;
      }
      out.push(best.queues.get(key)!.shift()!);
    }
    this.advance();
    return out;
  }
}

// --- The block's result -----------------------------------------------------------------------------

/**
 * The rows given so far as a block's result: grouped in the groups' order (a group shows once rows of it are in; its
 * items are copies, what the block got before stays as it was), else one group; `total` is the matching rows over all the parts.
 */
export function mergedQueryResult(rows: MergedRow[], groups: MergedGroup[], total: number, grouped: boolean): { result: QueryResult; items: Item[] } {
  const seen = new Set<Item>();
  const items: Item[] = [];
  for (const { item } of rows) {
    if (!seen.has(item)) {
      seen.add(item);
      items.push(item);
    }
  }
  if (!grouped) return { result: { groups: [{ key: "", label: "", items: rows.map((r) => r.item) }], total }, items };
  const byGroup = new Map<string, Item[]>();
  for (const { item, group } of rows) {
    const list = byGroup.get(group);
    if (list) list.push(item);
    else byGroup.set(group, [item]);
  }
  const shown: ItemGroup[] = groups.filter((g) => byGroup.has(g.key)).map((g) => ({ key: g.key, label: g.label, items: byGroup.get(g.key)! }));
  return { result: { groups: shown, total }, items };
}
