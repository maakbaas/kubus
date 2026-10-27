// What the API and the webhooks read for every answer: the collections, components and spaces,
// and items with their computed values as the screens of their space show them.

import type { SqliteRepository } from "../data/sqlite/SqliteRepository";
import { withComputed, type Component } from "../domain/components";
import type { Collection, Item } from "../domain/model";
import { refLabelForSpace } from "../domain/refOptions";
import type { Space } from "../domain/spaces";

export interface World {
  collections: Collection[];
  components: Component[];
  spaces: Space[];
}

export const loadWorld = async (repo: SqliteRepository): Promise<World> => ({
  collections: await repo.listCollections(),
  components: await repo.listComponents(),
  spaces: await repo.listSpaces(),
});

/** Items with their computed values (component fields), as shown in `spaceId`. */
export const computeItems = async (repo: SqliteRepository, world: World, collection: Collection, items: Item[], spaceId: string): Promise<Item[]> =>
  withComputed(collection, items, world.components, await refLabelForSpace(repo, collection, spaceId, world));
