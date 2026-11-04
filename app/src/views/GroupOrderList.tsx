import { compareGroups, type ItemGroup } from "../domain/query";
import { moveBlock, useReorder } from "../ui/useReorder";

/**
 * A custom group order (Sort and group, Group order "Custom"): the block's groups as a list to drag into order (by their
 * handles; Arrow up / down on a handle). The order is kept as the groups' keys (`ViewQuery.groupCustom`); a key of a group
 * * not shown now (no items at the moment) is kept after them, a new group comes after the ordered ones until it is moved.
 * The "(empty)" group is always last, so it isn't listed.
 */
export function GroupOrderList({ groups, order, isDate, onChange }: { groups: ItemGroup[]; order: string[]; isDate: boolean; onChange(order: string[]): void }) {
  const shown = groups
    .filter((g) => g.key !== "")
    .sort((a, b) => compareGroups({ ...a, count: 0 }, { ...b, count: 0 }, "custom", isDate, order));
  /** The new order: the shown groups as moved, then the keys of groups not shown now. */
  const store = (moved: ItemGroup[]) => {
    const keys = moved.map((g) => g.key);
    const hidden = order.filter((k) => !keys.includes(k));
    onChange([...keys, ...hidden]);
  };
  const reorder = useReorder({ count: shown.length, onMove: (start, end, to) => store(moveBlock(shown, start, end, to)), noun: ["group", "groups"] });
  if (shown.length === 0) return null;
  return (
    <div className="group-order" role="group" aria-label="Group order">
      {shown.map((g, i) => (
        <div key={g.key} className="list-input__row group-order__row" {...reorder.row(i)}>
          <span className="group-order__label" title={g.label}>
            {g.label}
          </span>
          {reorder.handle(i)}
        </div>
      ))}
      {reorder.dialog}
    </div>
  );
}
