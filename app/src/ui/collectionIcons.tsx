import type { Collection } from "../domain/model";
import { useEffect, useState } from "react";
import { Cube, type CarbonIconType } from "@carbon/icons-react";

// (The glob is relative to this file: Vite's root is app/, while node_modules is at the repo root.)
// Every Carbon icon is its own module (`@carbon/icons-react/es/<Name>.js`), loaded on demand
// and cached, so only the icons actually shown are fetched. Until one is there (or when unset or
// unknown) collections show the default Cube icon.

const loaders = import.meta.glob<{ default: CarbonIconType }>("../../../node_modules/@carbon/icons-react/es/[A-Z0-9]*.js");

const loaderFor = new Map<string, () => Promise<{ default: CarbonIconType }>>();
for (const [path, load] of Object.entries(loaders)) {
  const name = path.slice(path.lastIndexOf("/") + 1, -".js".length);
  if (name !== "Icon") loaderFor.set(name, load);
}

const loaded = new Map<string, CarbonIconType>();
const loading = new Map<string, Promise<CarbonIconType | null>>();

function loadIcon(name: string): Promise<CarbonIconType | null> {
  let p = loading.get(name);
  if (!p) {
    const load = loaderFor.get(name);
    p = load
      ? load().then(
          (m) => {
            loaded.set(name, m.default);
            return m.default;
          },
          (e) => {
            console.error(`Loading icon ${name} failed`, e);
            loading.delete(name); // not cached, so a later render retries
            return null;
          },
        )
      : Promise.resolve(null);
    loading.set(name, p);
  }
  return p;
}

const sortedNames = [...loaderFor.keys()].sort((a, b) => a.localeCompare(b));

/** All selectable icon names, sorted. */
export function iconNames(): string[] {
  return sortedNames;
}

/** Component for a collection's icon; Cube while loading or when unset/unknown (null with `fallback` false). */
export function useCollectionIcon(name: string | null | undefined, fallback?: true): CarbonIconType;
export function useCollectionIcon(name: string | null | undefined, fallback: boolean): CarbonIconType | null;
export function useCollectionIcon(name: string | null | undefined, fallback = true): CarbonIconType | null {
  const [, setLoadedName] = useState<string | null>(null);
  useEffect(() => {
    if (name && !loaded.has(name)) {
      let live = true;
      loadIcon(name).then((icon) => live && icon && setLoadedName(name));
      return () => {
        live = false;
      };
    }
  }, [name]);
  return (name && loaded.get(name)) || (fallback ? Cube : null);
}

/**
 * Renders a collection's icon. Without `fallback` (the icon picker) nothing stands in for an
 * icon still loading or unset: an empty space of its size, never the Cube.
 */
export function CollectionIcon({ name, size = 16, fallback = true }: { name: string | null | undefined; size?: 16 | 20 | 24 | 32; fallback?: boolean }) {
  const Icon = useCollectionIcon(name, fallback);
  return Icon ? <Icon size={size} aria-hidden="true" /> : <span style={{ display: "inline-block", inlineSize: size, blockSize: size }} aria-hidden="true" />;
}

/** A collection with its icon, e.g. in dropdowns that pick a collection. */
export function CollectionLabel({ collection }: { collection: Pick<Collection, "name" | "icon"> }) {
  return (
    <span className="icon-label">
      <CollectionIcon name={collection.icon} />
      <span className="icon-label__text">{collection.name}</span>
    </span>
  );
}
