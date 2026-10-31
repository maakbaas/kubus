// The Home page's layout (pages/HomePage.tsx): which of its blocks it shows, in which order, and which are collapsed.
// A synced setting (`settings` table, key "home"), so every device of the user has the same Home; read leniently
// (a value from another version, or written by hand, falls back block by block to the default).

/** The Home page's blocks, in their default order. */
export const HOME_BLOCKS = ["pages", "bookmarks"] as const;
export type HomeBlockId = (typeof HOME_BLOCKS)[number];

/** The setting's key. */
export const HOME_SETTING = "home";

export interface HomeLayout {
  /** The blocks shown, in order; null: the default (all, in HOME_BLOCKS' order). */
  shown: HomeBlockId[] | null;
  /** The blocks collapsed to their header. */
  collapsed: HomeBlockId[];
}

export const DEFAULT_HOME: HomeLayout = { shown: null, collapsed: [] };

const isBlock = (v: unknown): v is HomeBlockId => (HOME_BLOCKS as readonly unknown[]).includes(v);
/** The known block ids of a list, each once. */
const blocksOf = (v: unknown): HomeBlockId[] => (Array.isArray(v) ? [...new Set(v.filter(isBlock))] : []);

/** The layout a stored value says (unknown blocks dropped, anything unreadable the default). */
export function parseHomeLayout(raw: unknown): HomeLayout {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { shown: Array.isArray(o.shown) ? blocksOf(o.shown) : null, collapsed: blocksOf(o.collapsed) };
}

/** The blocks the page shows, in order. */
export const shownHomeBlocks = (layout: HomeLayout): HomeBlockId[] => layout.shown ?? [...HOME_BLOCKS];

/** The layout with one block collapsed or expanded. */
export const withHomeCollapsed = (layout: HomeLayout, id: HomeBlockId, collapsed: boolean): HomeLayout => ({
  ...layout,
  collapsed: collapsed ? [...new Set([...layout.collapsed, id])] : layout.collapsed.filter((c) => c !== id),
});
