import { useId, type ReactNode, type Ref } from "react";
import { Checkbox, TextInput } from "@carbon/react";
import { SettingsAdjust } from "@carbon/icons-react";
import { ToolbarPopover } from "./ToolbarPopover";
import { ViewNameRow } from "./ViewMoveButtons";

/** A setting's checkbox in View settings: shown with a value, left out with null. */
type Check = { checked: boolean; onChange(checked: boolean): void } | null;

/**
 * "View settings" of a collection view or a dashboard tab: the view's name and place among the views, Show filter bar,
 * Full width, Show number of items (a collection view's), Fields are editable, and its blocks (`children`: the block list). The same panel on both pages.
 */
export function ViewSettingsPanel({
  view,
  nameInput,
  openRequest,
  onOpenChange,
  onMove,
  onRename,
  filterBar,
  fullWidth,
  showCount = null,
  editable,
  children,
}: {
  /** The shown view (null: none yet), and its place among the views. */
  view: { id: string; name: string; index: number; count: number } | null;
  /** The name input, focused and selected after "+" (`openRequest` opens the panel then). */
  nameInput: Ref<HTMLInputElement>;
  openRequest: number;
  onOpenChange(open: boolean): void;
  onMove(by: 1 | -1): void;
  onRename(name: string): void;
  filterBar: Check;
  fullWidth: Check;
  /** "Show number of items" (collection views only: a dashboard's has none). */
  showCount?: Check;
  editable: Check;
  children: ReactNode;
}) {
  const uid = useId();
  const check = (key: string, label: string, c: Check) => c && <Checkbox id={`${uid}-${key}`} labelText={label} checked={c.checked} onChange={(_, { checked }) => c.onChange(checked)} />;
  return (
    <ToolbarPopover label="View settings" icon={SettingsAdjust} width="narrow" openRequest={openRequest} onOpenChange={onOpenChange}>
      <div className="view-settings">
        {view && (
          <ViewNameRow
            noun="view"
            index={view.index}
            count={view.count}
            onMove={onMove}
            input={
              <TextInput
                size="sm"
                key={view.id + view.name}
                id={`${uid}-rename`}
                ref={nameInput}
                labelText="View name"
                defaultValue={view.name}
                onBlur={(e) => onRename(e.target.value.trim())}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
            }
          />
        )}
        <div className="view-options__checks">
          {check("filter-bar", "Show filter bar", filterBar)}
          {check("full-width", "Full width", fullWidth)}
          {check("show-count", "Show number of items", showCount)}
          {check("editable", "Fields are editable", editable)}
        </div>
        {children}
      </div>
    </ToolbarPopover>
  );
}
