import { useEffect, useRef } from "react";
import type { DataChange } from "../data/repository";
import { useStore } from "./store";

/**
 * Calls `onChange` for every committed data change (from any pane, and later from sync), so a
 * view can refresh what it shows. Filter on the change's scope / ids inside the callback.
 */
export function useDataChanges(onChange: (change: DataChange) => void) {
  const { repo } = useStore();
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => repo.subscribe((change) => latest.current(change)), [repo]);
}
