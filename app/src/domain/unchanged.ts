// Reloaded lists that keep what didn't change: a list read again from the database (collections, components, …) is made of
// new objects, and much is memoized on their identity (a collection's computed items, its blocks' queries). A reload
// after a change to one of them then left every other one as it was.

/** `next`, with each element whose stored contents equal the previous list's element of its id replaced by that one. */
export function keepUnchanged<T extends { id: string }>(prev: readonly T[], next: T[]): T[] {
  if (prev.length === 0) return next;
  const before = new Map(prev.map((o) => [o.id, o]));
  const kept = next.map((o) => {
    const old = before.get(o.id);
    return old && JSON.stringify(old) === JSON.stringify(o) ? old : o;
  });
  // Nothing changed at all: the previous list itself, so nothing that depends on it runs again.
  return kept.length === prev.length && kept.every((o, i) => o === prev[i]) ? (prev as T[]) : kept;
}
