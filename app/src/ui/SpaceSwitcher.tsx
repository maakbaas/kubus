import { Dropdown, Layer } from "@carbon/react";
import { useStore } from "../app/store";
import type { Space } from "../domain/spaces";
import { CollectionLabel } from "./collectionIcons";

/** A space's icon when it has none of its own. */
export const SPACE_ICON = "Workspace";

/** A space with its icon (switcher, Spaces page). */
export const SpaceLabel = ({ space }: { space: Space }) => <CollectionLabel collection={{ name: space.name, icon: space.icon ?? SPACE_ICON }} />;

/**
 * Switches the shown space (its items, bookmarks and tabs), at the top of the side nav. Only
 * there once a second space exists; spaces are made on the Spaces page.
 */
export function SpaceSwitcher() {
  const { spaces, space, setSpace } = useStore();
  if (spaces.length < 2) return null;
  return (
    <Layer className="side-nav-space">
      <Dropdown<Space>
        autoAlign
        id="space-switcher"
        size="sm"
        titleText="Space"
        hideLabel
        label="Space"
        items={spaces}
        itemToString={(s) => s?.name ?? ""}
        itemToElement={(s) => <SpaceLabel space={s} />}
        renderSelectedItem={(s) => <SpaceLabel space={s} />}
        selectedItem={space}
        onChange={({ selectedItem }) => selectedItem && setSpace(selectedItem.id)}
      />
    </Layer>
  );
}
