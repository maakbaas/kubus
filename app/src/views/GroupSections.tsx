import type { ReactNode } from "react";
import { Accordion, AccordionItem } from "@carbon/react";
import type { ItemGroup } from "../domain/query";
import { Highlight } from "../ui/Highlight";

/**
 * A grouped block's groups as collapsible sections (open by default; collapsing is stored with the view), each holding what
 * `children` makes of it: a table, cards. One line per group, the same in every block that groups.
 */
export function GroupSections({
  groups,
  collapsed,
  onCollapse,
  children,
}: {
  groups: ItemGroup[];
  collapsed: string[];
  onCollapse(key: string, collapsed: boolean): void;
  children(group: ItemGroup): ReactNode;
}) {
  return (
    <Accordion size="sm" align="start">
      {groups.map((group) => (
        <AccordionItem
          key={group.key}
          open={!collapsed.includes(group.key)}
          onHeadingClick={({ isOpen }) => onCollapse(group.key, !isOpen)}
          title={
            <span className="table-group__title">
              <Highlight text={group.label} query="" />
            </span>
          }
        >
          {children(group)}
        </AccordionItem>
      ))}
    </Accordion>
  );
}
