import { Dropdown } from "@carbon/react";
import { Settings } from "@carbon/icons-react";
import { useStore } from "../app/store";
import { useWorkspace } from "../workspace/Workspace";
import type { Space } from "../domain/spaces";
import { CollectionLabel } from "./collectionIcons";

/** A space's icon when it has none of its own. */
export const SPACE_ICON = "Home";

/** A space with its icon (switcher, Spaces page). */
export const SpaceLabel = ({ space }: { space: Space }) => <CollectionLabel collection={{ name: space.name, icon: space.icon ?? SPACE_ICON }} />;

/** The dropdown's last entry: opens the Spaces page (there is no nav entry for it). */
const MANAGE = "manage" as const;

/**
 * Switches the shown space (its items, bookmarks and tabs), in the side nav's top row, beside the
 * menu toggle. Its last entry, "Manage spaces", opens the Spaces page, where spaces are made,
 * renamed and deleted.
 */
export function SpaceSwitcher() {
  const { spaces, space, setSpace } = useStore();
  const ws = useWorkspace();
  return (
    <div className="side-nav-space">
      <Dropdown<Space | typeof MANAGE>
        autoAlign
        id="space-switcher"
        size="sm"
        titleText="Space"
        hideLabel
        label="Space"
        items={[...spaces, MANAGE]}
        itemToString={(s) => (s === MANAGE ? "Manage spaces" : (s?.name ?? ""))}
        itemToElement={(s) =>
          s === MANAGE ? (
            <span className="icon-label space-manage">
              <Settings size={16} aria-hidden="true" />
              Manage spaces
            </span>
          ) : (
            <SpaceLabel space={s} />
          )
        }
        renderSelectedItem={(s) => (s === MANAGE ? null : <SpaceLabel space={s} />)}
        selectedItem={space}
        onChange={({ selectedItem }) => {
          if (selectedItem === MANAGE) ws.navigate("/spaces");
          else if (selectedItem) setSpace(selectedItem.id);
        }}
      />
    </div>
  );
}
