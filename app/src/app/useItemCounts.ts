import { useEffect, useState } from "react";
import { useStore } from "./store";
import { useDataChanges } from "./useDataChanges";

/**
 * How many items each collection has, in every space (what an AI field's prompt is asked for):
 * kept current as items come and go. Empty while loading.
 */
export function useItemCounts(): Record<string, number> {
  const { repo } = useStore();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let stale = false;
    repo.countItemsByCollection(null).then((n) => !stale && setCounts(n), (e) => console.error("Counting items failed", e));
    return () => {
      stale = true;
    };
  }, [repo, version]);
  useDataChanges((change) => change.scope === "items" && setVersion((v) => v + 1));
  return counts;
}
