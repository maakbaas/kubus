// Spaces: separate environments (e.g. Work and Private) in one database. Every item belongs to
// one space and shows only there; collections (their fields and item views) and components are
// shared, so one Book collection serves both. A collection can be limited to some spaces
// (spaceIds); null shows it in all. Collection views, bookmarks and the open tabs are per space
// too: a view of work topics doesn't clutter Private. Which space is shown is remembered per device.

import type { Collection } from "./model";

export interface Space {
  id: string;
  name: string;
  /** Carbon icon name, like a collection's; null for the default icon. */
  icon: string | null;
  position: number;
}

/** The space every database starts with. It has no row until it is renamed. */
export const DEFAULT_SPACE_ID = "default";

const DEFAULT_SPACE: Space = { id: DEFAULT_SPACE_ID, name: "Space", icon: null, position: -1 };

/**
 * The stored spaces plus the default one while it has no row. Deleting the default leaves a
 * tombstone row, which `deleted` reports so it isn't added again.
 */
export const withDefaultSpace = (spaces: Space[], deleted = false): Space[] =>
  deleted || spaces.some((s) => s.id === DEFAULT_SPACE_ID) ? spaces : [DEFAULT_SPACE, ...spaces];

/** Whether a collection is shown in a space. */
export const inSpace = (collection: Pick<Collection, "spaceIds">, spaceId: string) =>
  collection.spaceIds === null || collection.spaceIds.includes(spaceId);
