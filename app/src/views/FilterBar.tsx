import { useId, type ReactNode } from "react";
import { IconButton } from "@carbon/react";
import { ChevronLeft, ChevronRight, PageLast } from "@carbon/icons-react";
import { pickableFields, type Collection } from "../domain/model";
import { fieldOperators } from "../domain/sources";
import type { RefOptions } from "../ui/useReferenceOptions";
import { RuleValue } from "./RuleValue";
import type { FilterRule } from "../domain/query";
import { steps } from "./DatePeriodFilter";
import { defaultDateField, latestValue, nowMinute, periodParts, periodRule, periodState, periodText, rollingLabel, splitAnchor, stepValue, withPeriod } from "../domain/datePeriod";

/**
 * A collection view's filter bar ("Show filter bar" in View settings), below its tabs: the date period
 * (domain/datePeriod.ts) as a status line at the left, and at the right ‹ › stepping it (a rolling one
 * stays rolling), >| "this one" (the most recent one of its kind: rolling, this week, not literally these
 * days) and the view's Filter button (`children`: it leaves the toolbar while the bar is shown), touching
 * and ending where the toolbar's icon buttons end. The line is how the period is counted ("This week",
 * "Last 7 days", "Year to date"), else its first words ("October 2026", "Week 44", "1 Oct – 15 Nov 2026"),
 * none yet "Any date", the same at every width; the whole line with its days is the tooltip. The kind and
 * everything else is changed in the filter panel (DatePeriodFilter); every change here is an edit of the
 * view's filter as there. The line takes what room is left and is ellipsized, so stepping never moves the buttons.
 * Below it, a row for each rule put on the bar (`FilterRule.onBar`, the pin in the filter panel), at every width:
 * the rule in words ("Genre is", "Pages below") and its value, filling the line (RuleValue: the field's existing
 * values offered); its field and comparison are changed in the panel.
 */
export function FilterBar({
  collection,
  filters,
  refs,
  owners,
  onChange,
  children,
}: {
  collection: Collection;
  filters: FilterRule[];
  refs: RefOptions;
  /** A page-wide filter over several collections (a dashboard's): each field's own collection. */
  owners?: Collection[];
  onChange(filters: FilterRule[]): void;
  children: ReactNode;
}) {
  const uid = useId();
  const now = nowMinute();
  const rule = periodRule(filters);
  const value = rule ? splitAnchor(rule.value) : null;
  const state = value ? periodState(value.value, now) : null;
  const set = (next: string | null) => next && onChange(withPeriod(filters, defaultDateField(collection), next));
  const latest = state && state.kind !== "range" ? rollingLabel({ kind: state.kind, offset: 0 }) : "Most recent";
  const still = !steps(state, !!value?.fieldId);
  const parts = state ? periodParts(state) : null;
  const text = parts ? parts.counting || parts.days.split(" - ")[0] : "Any date";
  const fields = new Map(pickableFields(collection).map((f) => [f.id, f]));
  const ownerOf = (id: string) => owners?.find((c) => c.fields.some((f) => f.id === id)) ?? collection;
  // The rules on the bar whose field and comparison still take a value.
  const pinned = filters.flatMap((rule) => {
    const f = rule.onBar ? fields.get(rule.fieldId) : undefined;
    const operator = f && fieldOperators(ownerOf(f.id), f).find((o) => o.id === rule.operator);
    return f && operator?.needsValue ? [{ rule, field: f, words: `${f.name} ${operator.label}` }] : [];
  });
  const setValue = (id: string, value: string) => onChange(filters.map((r) => (r.id === id ? { ...r, value } : r)));
  const line = (
    <div className="filter-bar">
      <span className="filter-bar__label" title={state ? periodText(state) : text}>
        {text}
      </span>
      <IconButton autoAlign kind="ghost" size="sm" align="bottom" label="Previous" disabled={still} onClick={() => value && set(stepValue(value.value, -1, now))}>
        <ChevronLeft />
      </IconButton>
      <IconButton autoAlign kind="ghost" size="sm" align="bottom" label="Next" disabled={still} onClick={() => value && set(stepValue(value.value, 1, now))}>
        <ChevronRight />
      </IconButton>
      <IconButton autoAlign kind="ghost" size="sm" align="bottom" label={latest} disabled={!state || state.kind === "range"} onClick={() => value && set(latestValue(value.value, now))}>
        <PageLast />
      </IconButton>
      {children}
    </div>
  );
  if (pinned.length === 0) return line;
  return (
    <div className="filter-bar-wrap">
      {line}
      <div className="filter-bar__rules">
        {pinned.map(({ rule, field, words }) => (
          <div key={rule.id} className="filter-bar__rule">
            <label className="filter-bar__words" htmlFor={`${uid}-bar-${rule.id}`} title={words}>
              {words}
            </label>
            <RuleValue id={`${uid}-bar-${rule.id}`} owner={ownerOf(field.id)} field={field} rule={rule} refs={refs} labelText={words} onChange={(value) => setValue(rule.id, value)} />
          </div>
        ))}
      </div>
    </div>
  );
}
