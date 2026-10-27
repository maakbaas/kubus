// What working out items' values needs besides the items: the collections, components and spaces.
// The AI backfill, the API and the webhooks read it; the screens have it from the store.

import type { Repository } from "../data/repository";
import { withComputed, type Component } from "./components";
import type { Collection, Item, ItemLabel } from "./model";
import { refLabelForSpace } from "./refOptions";
import type { Space } from "./spaces";

export interface World {
  collections: Collection[];
  components: Component[];
  spaces: Space[];
}

export const loadWorld = async (repo: Pick<Repository, "listCollections" | "listComponents" | "listSpaces">): Promise<World> => ({
  collections: await repo.listCollections(),
  components: await repo.listComponents(),
  spaces: await repo.listSpaces(),
});

/**
 * Items of one collection with their computed values (component fields), as shown in `spaceId`.
 * `labels` caches referenced collections' labels between calls (see refLabelForSpace).
 */
export const computeItems = async (
  repo: Pick<Repository, "listItems" | "listLabels">,
  world: World,
  collection: Collection,
  items: Item[],
  spaceId: string,
  labels?: Map<string, ItemLabel[]>,
): Promise<Item[]> => withComputed(collection, items, world.components, await refLabelForSpace(repo, collection, spaceId, world, labels));
