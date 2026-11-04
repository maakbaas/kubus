import { Select, SelectItem } from "@carbon/react";

/**
 * How a group of a filter (a rule, a block's date period) joins what comes before it: And / Or, an inline choice at
 * the start of the group's top row (styles.css `.filter-join`: no box, its word on the row's left edge).
 */
export function JoinSelect({ id, value, onChange }: { id: string; value: "and" | "or"; onChange(join: "and" | "or"): void }) {
  return (
    <Select id={id} className="filter-join" inline labelText="Join" hideLabel size="sm" value={value} onChange={(e) => onChange(e.target.value === "or" ? "or" : "and")}>
      <SelectItem value="and" text="And" />
      <SelectItem value="or" text="Or" />
    </Select>
  );
}
