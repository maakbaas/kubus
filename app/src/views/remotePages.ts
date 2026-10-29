import type { SourceResult, SourceRow } from "../../../shared/sources";
import type { Collection } from "../domain/model";
import { groupItems, type ItemGroup, type QueryResult, type ViewQuery } from "../domain/query";
import { groupLabel, type BuiltRows } from "../domain/sources";

// The pure part of a remote block's paging (useRemoteResult): what the rows held are, and how a page,
// a failure or the items built from them change what the block shows.

export interface Loaded {
  /** The request these rows answer. */
  key: string;
  /** Which first page these rows start with: pages added after it keep it (their rows are only added). */
  batch: number;
  rows: SourceRow[];
  total: number;
  groups: SourceResult["groups"];
  more: boolean;
  error?: string;
}

/** What a page of the source gives (the first page also what the whole answer is about). */
export type Page = Omit<Loaded, "key" | "batch">;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The first page as it is held: a total under the rows in (a source that couldn't count them all) counts at least those; a failure holds its message. */
export function firstPage(answer: Promise<SourceResult>): Promise<Page> {
  return answer.then(
    (r) => ({ rows: r.rows, total: Math.max(r.total ?? 0, r.rows.length), groups: r.groups, more: r.more }),
    (e) => ({ rows: [], total: 0, groups: [], more: false, error: messageOf(e) }),
  );
}

/** The rows held with the next page added (null stays null: the query changed meanwhile). */
export function withNextPage(l: Loaded | null, r: SourceResult): Loaded | null {
  return l && { ...l, rows: [...l.rows, ...r.rows], total: Math.max(l.total, l.rows.length + r.rows.length), more: r.more };
}

/** The rows held with the failure of the next page noted; they stay. */
export function withPageError(l: Loaded | null, e: unknown): Loaded | null {
  return l && { ...l, error: messageOf(e) };
}

const NO_REFS = { refLabel: () => "" };

/** The block's result from the items built: grouped in the source's order (or, by a date part, here) (a group shows once rows of it are in), else one group. Copies: what the block got before stays as it was. */
export function remoteQueryResult(
  built: BuiltRows,
  loaded: Pick<Loaded, "groups" | "total">,
  collection: Collection,
  groupBy: string | null | undefined,
  grouped: boolean,
  /** Grouped here (groupsInApp): by this query's date part, of the rows in so far. */
  inApp?: ViewQuery,
) {
  const groupField = groupBy ? collection.fields.find((f) => f.id === groupBy) : undefined;
  const groups: ItemGroup[] = inApp
    ? groupItems(collection, built.computed, inApp, NO_REFS)
    : grouped
    ? loaded.groups!.filter((g) => built.byGroup.has(g.key)).map((g) => ({ key: g.key, label: groupLabel(groupField, g.key), items: built.byGroup.get(g.key)!.slice() }))
    : [{ key: "", label: "", items: built.computed.slice() }];
  return { result: { groups, total: loaded.total } satisfies QueryResult, items: built.all.slice() };
}
