import { useState } from "react";

type Direction = "asc" | "desc";

/**
 * Header sorting for the plain list tables (Collections, Components, Bookmarks, Spaces), like the
 * items tables': clicking a column sorts by it ascending, again descending; until then the rows
 * keep their own order. `keys` gives each sortable column's value per row. Spread `header(column)`
 * on a Carbon `TableHeader`, run the rows through `sort`.
 */
export function useTableSort<T, C extends string>(keys: Record<C, (row: T) => string | number>) {
  const [current, setCurrent] = useState<{ column: C; direction: Direction } | null>(null);

  const sort = (rows: T[]): T[] => {
    if (!current) return rows;
    const key = keys[current.column];
    const sign = current.direction === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = key(a);
      const y = key(b);
      const order = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
      return sign * order;
    });
  };

  const header = (column: C) => {
    const active = current?.column === column;
    return {
      isSortable: true,
      isSortHeader: active,
      sortDirection: active ? (current.direction === "asc" ? ("ASC" as const) : ("DESC" as const)) : ("NONE" as const),
      onClick: () => setCurrent({ column, direction: active && current.direction === "asc" ? "desc" : "asc" }),
    };
  };

  return { sort, header };
}
