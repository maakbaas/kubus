import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Button, IconButton, Popover, PopoverContent, Search } from "@carbon/react";
import { iconNames, CollectionIcon } from "./collectionIcons";

const MAX_SHOWN = 60;

interface Props {
  id: string;
  value: string | null;
  onChange(icon: string | null): void;
  /** The button's icon size: 24 beside a page title (default), 16 in a table row like its other icons. */
  size?: 16 | 24;
}

/**
 * Picks an icon from the full Carbon set: a button showing the current icon; clicking it
 * opens a popover with a search box over a grid of matches (first MAX_SHOWN drawn, so it
 * stays fast). Choosing an icon, Escape or clicking outside closes it.
 */
export function IconPicker({ id, value, onChange, size = 24 }: Props) {
  const names = iconNames();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchBox = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // Never taller than the room on the roomier side of the button (autoAlign flips to it), so the
  // page doesn't scroll; the grid gives up rows first.
  const [room, setRoom] = useState<number>();
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = root.current?.getBoundingClientRect();
      if (r) setRoom(Math.max(r.top, window.innerHeight - r.bottom) - 16);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

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
    <Popover autoAlign open={open} align="bottom-start" dropShadow onRequestClose={() => setOpen(false)} className="icon-picker" ref={root}>
      <IconButton autoAlign
        id={id}
        label={value ? `Icon: ${value}. Click to change` : "Choose an icon"}
        // Borderless, like the page title next to it; the tooltip and hover show it's clickable.
        kind="ghost"
        size="sm"
        // Starts at the button and runs right: centred, it would slide under the side nav in the Spaces table.
        align="bottom-start"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {/* No icon chosen (or not loaded yet): an empty button, not the default Cube. */}
        <CollectionIcon name={value} size={size} fallback={false} />
      </IconButton>
      <PopoverContent>
        {/* Only while open: PopoverContent keeps its children mounted when closed, which would
            load every icon of the grid on any page with a picker. */}
        {open && (
          // Escape closes (Carbon's Search would only clear its text) and returns focus to the button.
          <div
            className="icon-picker__panel"
            style={room !== undefined ? ({ "--popover-room": `${Math.max(room, 0)}px` } as CSSProperties) : undefined}
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
                  <CollectionIcon name={name} size={20} fallback={false} />
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
        )}
      </PopoverContent>
    </Popover>
  );
}
