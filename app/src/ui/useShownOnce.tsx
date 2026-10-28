import { createContext, useContext, useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";

// A message several parts of a page would show alike (every block of a remote collection with "the
// server can't be reached") is shown once per page: by the first part showing it, the others
// keep still. Each tab's page has its own (Workspace); without one every part shows its own.

class ShownOnce {
  private owners = new Map<string, string[]>();
  private listeners = new Set<() => void>();

  claim(message: string, id: string): () => void {
    this.owners.set(message, [...(this.owners.get(message) ?? []), id]);
    this.emit();
    return () => {
      const left = (this.owners.get(message) ?? []).filter((o) => o !== id);
      if (left.length) this.owners.set(message, left);
      else this.owners.delete(message);
      this.emit();
    };
  }
  /** Who shows the message: the first that claimed it. */
  owner = (message: string): string | undefined => this.owners.get(message)?.[0];
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private emit() {
    for (const l of this.listeners) l();
  }
}

const ShownOnceContext = createContext<ShownOnce | null>(null);

export function ShownOnceProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new ShownOnce());
  return <ShownOnceContext.Provider value={store}>{children}</ShownOnceContext.Provider>;
}

/** Whether this part shows `message` (none: false): only the first on the page showing it does. */
export function useShownOnce(message: string | undefined | null): boolean {
  const store = useContext(ShownOnceContext);
  const id = useId();
  useEffect(() => (store && message ? store.claim(message, id) : undefined), [store, message, id]);
  const owner = useSyncExternalStore(store?.subscribe ?? noSubscribe, () => (store && message ? store.owner(message) : undefined));
  if (!message) return false;
  return !store || owner === id;
}

const noSubscribe = () => () => undefined;
