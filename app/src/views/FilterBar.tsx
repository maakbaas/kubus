import { useId, type ReactNode } from "react";
import { Dropdown, IconButton } from "@carbon/react";
import { Calendar, ChevronLeft, ChevronRight } from "@carbon/icons-react";
import type { Collection } from "../domain/model";
import type { FilterRule } from "../domain/query";
import { KINDS, steps } from "./DatePeriodFilter";
import {
  defaultDateField,
  kindValue,
  latestValue,
  nowMinute,
  periodRule,
  periodParts,
  periodState,
  periodText,
  rollingLabel,
  splitAnchor,
  stepValue,
  withPeriod,
  type Unit,
} from "../domain/datePeriod";

type UnitChoice = { kind: Unit; text: string };

/** The kinds of the bar's switch (a range is only chosen in the filter panel). */
const UNITS = KINDS.filter((k): k is UnitChoice => k.kind !== "range");

/**
 * A collection view's filter bar ("Show filter bar" in View settings), below its tabs: the view's
 * Filter button (`children`: it leaves the toolbar while the bar is shown), then its date period
 * (domain/datePeriod.ts) stepped with ‹ › (a rolling one stays rolling), jumped to the most recent
 * one of its kind (rolling: this week, not literally these days) and switched between hour, day,
 * week, month and year. Every change is an edit of the view's filter, as in the filter panel
 * (DatePeriodFilter), which keeps what only it has: a range, the window (last n, so far) and the
 * field the period goes by. The label sits between the buttons and takes what room is left, so
 * stepping never moves the buttons.
 */
export function FilterBar({ collection, filters, onChange, children }: { collection: Collection; filters: FilterRule[]; onChange(filters: FilterRule[]): void; children: ReactNode }) {
  const uid = useId();
  const now = nowMinute();
  const rule = periodRule(filters);
  const value = rule ? splitAnchor(rule.value) : null;
  const state = value ? periodState(value.value, now) : null;
  const set = (next: string | null) => next && onChange(withPeriod(filters, defaultDateField(collection), next));
  const label = state ? periodText(state) : "Any date";
  const parts = state ? periodParts(state) : { counting: "", days: "Any date" };
  const kind = state && state.kind !== "range" ? UNITS.find((u) => u.kind === state.kind) : undefined;
  const latest = state && state.kind !== "range" ? rollingLabel({ kind: state.kind, offset: 0 }) : "Most recent";
  const still = !steps(state, !!value?.fieldId);
  return (
    <div className="filter-bar">
      {children}
      <IconButton autoAlign kind="ghost" size="sm" align="bottom" label="Previous" disabled={still} onClick={() => value && set(stepValue(value.value, -1, now))}>
        <ChevronLeft />
      </IconButton>
      {/* What it is counted as ("Last week") keeps its room; the days give way first. */}
      <span className={`filter-bar__label${parts.counting ? " filter-bar__label--counted" : ""}`} title={label}>
        {parts.counting && <span className="filter-bar__counting">{parts.counting}</span>}
        <span className="filter-bar__days">{parts.counting ? ` · ${parts.days}` : parts.days}</span>
      </span>
      <IconButton autoAlign kind="ghost" size="sm" align="bottom" label="Next" disabled={still} onClick={() => value && set(stepValue(value.value, 1, now))}>
        <ChevronRight />
      </IconButton>
      <IconButton
        autoAlign
        kind="ghost"
        size="sm"
        align="bottom"
        label={latest}
        disabled={!state || state.kind === "range"}
        onClick={() => value && set(latestValue(value.value, now))}
      >
        <Calendar />
      </IconButton>
      <Dropdown<UnitChoice | null>
        autoAlign
        size="sm"
        id={`${uid}-kind`}
        className="filter-bar__kind"
        titleText="Period"
        hideLabel
        label="Period"
        items={UNITS}
        selectedItem={kind ?? null}
        itemToString={(u) => u?.text ?? ""}
        // The same window in the other kind; with no period yet, the current one (kindValue).
        onChange={({ selectedItem }) => selectedItem && set(kindValue(value ? value.value : null, selectedItem.kind, now))}
      />
    </div>
  );
}
