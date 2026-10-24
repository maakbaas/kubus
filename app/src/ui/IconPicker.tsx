import { useEffect, useMemo, useRef, useState } from "react";
import { Button, IconButton, Popover, PopoverContent, Search } from "@carbon/react";
import { iconNames, CollectionIcon } from "./collectionIcons";

const MAX_SHOWN = 60;

interface Props {
  id: string;
  value: string | null;
  onChange(icon: string | null): void;
}

/**
 * Picks an icon from the full Carbon set: a button showing the current icon; clicking it
 * opens a popover with a search box over a grid of matches (first MAX_SHOWN drawn, so it
 * stays fast). Choosing an icon, Escape or clicking outside closes it.
 */
export function IconPicker({ id, value, onChange }: Props) {
  const names = iconNames();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchBox = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? names.filter((n) => n.toLowerCase().includes(q)) : names;
  }, [names, query]);
  const shown = matches.slice(0, MAX_SHOWN);

  // Focus the search box when the popover opens.
  useEffect(() => {
    if (open) searchBox.current?.querySelector("input")?.focus();
  }, [open]);

  const choose = (icon: string | null) => {
    onChange(icon);
    setOpen(false);
  };

  return (
    <Popover autoAlign open={open} align="bottom-start" dropShadow onRequestClose={() => setOpen(false)} className="icon-picker">
      <IconButton autoAlign
        id={id}
        label={value ? `Icon: ${value}. Click to change` : "Choose an icon"}
        // Borderless, like the page title next to it; the tooltip and hover show it's clickable.
        kind="ghost"
        size="sm"
        align="bottom"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <CollectionIcon name={value} size={24} />
      </IconButton>
      <PopoverContent>
        {/* Escape closes (Carbon's Search would only clear its text) and returns focus to the button. */}
        <div
          className="icon-picker__panel"
          onKeyDownCapture={(e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            setOpen(false);
            document.getElementById(id)?.focus();
          }}
        >
          <div ref={searchBox}>
            <Search
              id={`${id}-search`}
              size="sm"
              labelText="Search icons"
              placeholder={`Search ${names.length} icons`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="icon-grid" role="listbox" aria-label="Icons">
            {shown.map((name) => (
              <IconButton autoAlign
                key={name}
                label={name}
                kind="ghost"
                size="sm"
                align="top"
                isSelected={name === value}
                role="option"
                aria-selected={name === value}
                onClick={() => choose(name)}
              >
                <CollectionIcon name={name} size={20} />
              </IconButton>
            ))}
          </div>
          <div className="icon-grid__footer">
            <span className="helper">
              {matches.length === 0
                ? "No icons match."
                : matches.length > MAX_SHOWN
                  ? `Showing ${MAX_SHOWN} of ${matches.length}, type to narrow down`
                  : `${matches.length} icon${matches.length === 1 ? "" : "s"}`}
            </span>
            {value && (
              <Button kind="tertiary" size="sm" onClick={() => choose(null)}>
                Remove icon
              </Button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
