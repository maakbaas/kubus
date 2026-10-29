import { useMemo, useRef } from "react";

/**
 * Reloads of a list that the page also changes ahead of storing (a view's blocks arranged: shown at once, then stored and
 * read back). A reload asked while such a change was not stored yet, or answered after a later change or a later reload was
 * asked, may read the list as it was a moment ago (a block's options flipping back for a moment): it is dropped. The
 * change's own reload, asked once it is stored, brings the list.
 */
export function useFreshLoads() {
  const asked = useRef(0);
  const changes = useRef(0);
  const unstored = useRef(0);
  return useMemo(
    () => ({
      /** Stores a change already shown (`store`); reload after it. */
      async storing<T>(store: () => Promise<T>): Promise<T> {
        changes.current++;
        unstored.current++;
        try {
          return await store();
        } finally {
          unstored.current--;
        }
      },
      /** Call when a reload is asked: the function it returns tells, when the reload is back, whether to use it. */
      ticket(): () => boolean {
        const a = ++asked.current;
        const c = changes.current;
        const settled = unstored.current === 0;
        return () => settled && a === asked.current && c === changes.current;
      },
    }),
    [],
  );
}
