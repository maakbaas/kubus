// Per-device UI preferences (layout, side nav, …) in localStorage, best effort: storage can be
// unavailable or full, and then a preference just isn't remembered.

/** A stored preference (JSON), or `fallback` when absent or unreadable. */
export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/** Stores a preference (JSON); `undefined` removes it. */
export function writePref(key: string, value: unknown): void {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* not remembered */
  }
}
