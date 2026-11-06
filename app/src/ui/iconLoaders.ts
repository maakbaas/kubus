import type { CarbonIconType } from "@carbon/icons-react";

// A chunk of its own, loaded by collectionIcons.tsx when the first icon is wanted: a loader per Carbon icon
// (~2,700, ~360 kB of code) kept out of the main chunk, which the app evaluates before it starts.
// (The glob is relative to this file: Vite's root is app/, while node_modules is at the repo root.)
const loaders = import.meta.glob<{ default: CarbonIconType }>("../../../node_modules/@carbon/icons-react/es/[A-Z0-9]*.js");

/** Each icon's loader, by name. */
export const loaderFor = new Map<string, () => Promise<{ default: CarbonIconType }>>();
for (const [path, load] of Object.entries(loaders)) {
  const name = path.slice(path.lastIndexOf("/") + 1, -".js".length);
  if (name !== "Icon") loaderFor.set(name, load);
}

/** All icon names, sorted. */
export const sortedNames = [...loaderFor.keys()].sort((a, b) => a.localeCompare(b));
