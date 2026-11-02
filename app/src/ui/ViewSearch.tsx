import { useEffect, useState } from "react";
import { IconButton, Search } from "@carbon/react";
import { Search as SearchIcon } from "@carbon/icons-react";

/** How long typing pauses before a view's blocks search for it (each search goes over every item). */
const SEARCH_DELAY_MS = 150;

/** A view's (collection view's, dashboard tab's) search: what is typed, what the blocks search for, and whether its bar is open. */
export interface ViewSearchState {
  search: string;
  setSearch(search: string): void;
  /** What the blocks search for: the typed text once typing pauses, an emptied box at once. */
  searched: string;
  open: boolean;
  setOpen(open: boolean): void;
}

export function useViewSearch(): ViewSearchState {
  const [search, setSearch] = useState("");
  const [searched, setSearched] = useState("");
  useEffect(() => {
    if (!search) return setSearched("");
    const timer = window.setTimeout(() => setSearched(search), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [search]);
  const [open, setOpen] = useState(false);
  return { search, setSearch, searched, open, setOpen };
}

/** The views bar's search button: opens the search bar below it, or closes it (emptied). Blue while a search is in effect. */
export function ViewSearchButton({ state, name }: { state: ViewSearchState; name: string }) {
  return (
    <IconButton
      autoAlign
      kind="ghost"
      size="sm"
      align="bottom"
      label={state.open ? "Close search" : `Search ${name}`}
      isSelected={state.open}
      data-active={state.search ? true : undefined}
      aria-expanded={state.open}
      onClick={() => {
        if (state.open) state.setSearch("");
        state.setOpen(!state.open);
      }}
    >
      <SearchIcon />
    </IconButton>
  );
}

/** The search bar below the views bar, while open; it closes when left empty (or with Escape on an empty box). */
export function ViewSearchBar({ state, name, id }: { state: ViewSearchState; name: string; id: string }) {
  if (!state.open) return null;
  return (
    <div className="items-search">
      <Search
        id={id}
        size="sm"
        autoFocus
        labelText={`Search ${name}`}
        placeholder={`Search ${name}`}
        value={state.search}
        onChange={(e) => state.setSearch(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && !state.search && state.setOpen(false)}
        onBlur={() => !state.search && state.setOpen(false)}
      />
    </div>
  );
}
