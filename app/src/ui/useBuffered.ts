import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A value edited in a place that stores every change right away (a block's settings): what is typed
 * shows at once, and is stored after a pause in typing (`delay` ms), when the editor goes away, or on
 * `flush`. Storing a keystroke at a time would reset the input to an older value while each save
 * comes back, losing what was typed in between. A change from elsewhere shows unless an edit is waiting.
 */
export function useBuffered<T>(value: T, commit: (value: T) => void, delay = 400): [T, (value: T) => void, () => void] {
  const [draft, setDraft] = useState(value);
  const pending = useRef<{ value: T } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => {
    if (!pending.current) setDraft(value);
  }, [value]);
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const p = pending.current;
    pending.current = null;
    if (p) commitRef.current(p.value);
  }, []);
  const update = useCallback(
    (next: T) => {
      setDraft(next);
      pending.current = { value: next };
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, delay);
    },
    [delay, flush],
  );
  useEffect(() => flush, [flush]);
  return [draft, update, flush];
}
