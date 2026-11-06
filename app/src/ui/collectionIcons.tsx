import type { Collection } from "../domain/model";
import { useEffect, useState } from "react";
import { Cube, type CarbonIconType } from "@carbon/icons-react";

// Every Carbon icon is its own module (`@carbon/icons-react/es/<Name>.js`), loaded on demand
// and cached, so only the icons actually shown are fetched. Until one is there (or when unset or
// unknown) collections show the default Cube icon. Their loaders are a chunk of their own too (iconLoaders.ts).

type Registry = typeof import("./iconLoaders");
let registry: Registry | null = null;
let registryLoading: Promise<Registry> | null = null;
function loadRegistry(): Promise<Registry> {
  registryLoading ??= import("./iconLoaders").then(
    (m) => (registry = m),
    (e) => {
      registryLoading = null; // a later call retries
      throw e;
    },
  );
  return registryLoading;
}

const loaded = new Map<string, CarbonIconType>();
const loading = new Map<string, Promise<CarbonIconType | null>>();

function loadIcon(name: string): Promise<CarbonIconType | null> {
  let p = loading.get(name);
  if (!p) {
    p = loadRegistry()
      .then((r) => {
        const load = r.loaderFor.get(name);
        return load ? load().then((m) => m.default) : null;
      })
      .then(
        (icon) => {
          if (icon) loaded.set(name, icon);
          return icon;
        },
        (e) => {
          console.error(`Loading icon ${name} failed`, e);
          loading.delete(name); // not cached, so a later render retries
          return null;
        },
      );
    loading.set(name, p);
  }
  return p;
}

/** All selectable icon names, sorted: none until their list has loaded (it starts loading on first use). */
export function useIconNames(): string[] {
  const [names, setNames] = useState<string[]>(() => registry?.sortedNames ?? []);
  useEffect(() => {
    if (registry) return;
    let live = true;
    loadRegistry().then((r) => live && setNames(r.sortedNames), (e) => console.error("Loading the icons failed", e));
    return () => {
      live = false;
    };
  }, []);
  return names;
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
      <span className="icon-label__text" title={collection.name}>
        {collection.name}
      </span>
    </span>
  );
}
