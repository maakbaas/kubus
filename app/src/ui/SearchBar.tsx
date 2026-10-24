import { useEffect, useRef } from "react";
import { Search } from "@carbon/react";

/**
 * The global search: a full-width bar across the top of the page, opened from the search icon
 * in the tab strip. It looks like a modal's surface, without a border. The search page below
 * shows the results while typing; Enter, Escape or leaving the bar closes it.
 */
export function SearchBar({ value, onChange, onClose, docked }: { value: string; onChange(value: string): void; onClose(): void; docked: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector("input")?.focus();
  }, []);
  return (
    <div
      ref={ref}
      className={`search-bar${docked ? " search-bar--nav-docked" : ""}`}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && onClose()}
      onKeyDownCapture={(e) => (e.key === "Escape" || e.key === "Enter") && onClose()}
    >
      <Search size="lg" labelText="Search all items" placeholder="Search" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
