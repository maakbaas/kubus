import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { IconButton } from "@carbon/react";
import { ChevronLeft, ChevronRight, PageLast } from "@carbon/icons-react";
import { pickableFields, type Collection } from "../domain/model";
import { fieldOperators } from "../domain/sources";
import type { RefOptions } from "../ui/useReferenceOptions";
import { RuleValue } from "./RuleValue";
import { useMediaQuery } from "../ui/useMediaQuery";
import { RollingMark } from "./RollingMark";
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
 * The rules put on the bar (`FilterRule.onBar`, the pin in the filter panel), each the rule in words ("Genre is",
 * "Pages below") and its value (RuleValue: the field's existing values offered), follow the period on its line
 * while they all fit there; else they all go below it in a grid of as many columns as fit (one on a phone), the
 * words of each as wide as the longest and its value filling its column. Their field and comparison are changed
 * in the panel. On a touch screen a value with existing values offered is picked from a menu (or "Any"), not typed:
 * no keyboard comes up for it; any other value is typed in the panel.
 */
export function FilterBar({
  collection,
  filters,
  refs,
  owners,
  period = true,
  onBelow,
  onChange,
  children,
}: {
  collection: Collection;
  filters: FilterRule[];
  refs: RefOptions;
  /** A page-wide filter over several collections (a dashboard's): each field's own collection. */
  owners?: Collection[];
  /** The date period on the bar (its words, ‹ › >|); false: the bar is the rules and the Filter button alone (`filterBarPeriod`). */
  period?: boolean;
  /** Told whether the rules are below the line (they didn't fit on it): without the period the page then keeps its Filter button in the toolbar. */
  onBelow?(below: boolean): void;
  onChange(filters: FilterRule[]): void;
  children: ReactNode;
}) {
  const uid = useId();
  // A touch screen picks a rule's value from its menu: tapping the box brings up no keyboard.
  const touch = useMediaQuery("(hover: none)");
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
  // The rules go on the bar's line while they all fit there (each its words and a 10rem box); else they all go
  // below it, in as many columns as fit, each rule its words (as wide as the longest: `--bar-words`) and a box
  // filling its column: one column on a phone. Measured on each change of the rules or of the bar's width.
  const barRef = useRef<HTMLDivElement>(null);
  const rolling = !!state?.counted;
  const [below, setBelow] = useState(false);
  const allWords = pinned.map((p) => p.words).join("\n");
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar || !allWords) return;
    const measure = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      // Text by its own width, whatever the room its element has now.
      const textWidth = (el: Element | null) => {
        if (!el) return 0;
        const range = document.createRange();
        range.selectNodeContents(el);
        return Math.ceil(range.getBoundingClientRect().width);
      };
      const words = [...bar.querySelectorAll(".filter-bar__words")].map(textWidth);
      // The period and its gap (none without it), each rule (words, gap, box) with gaps between, a gap, the buttons:
      // ‹ › >| (with the period) and Filter, 2rem each, counted whether the Filter button is here or (below the line,
      // without the period) back in the toolbar, so its moving never changes what fits.
      const label = bar.querySelector(".filter-bar__label");
      const others = ((period ? 3 : 0) + 1 + (period && rolling ? 1 : 0)) * 2 * rem;
      const need = (label ? textWidth(label) + rem : 0) + words.reduce((sum, w) => sum + w + 0.5 * rem + 10 * rem, 0) + rem * (words.length - 1) + rem + others;
      bar.style.setProperty("--bar-words", `${Math.max(0, ...words)}px`);
      setBelow(need > bar.clientWidth + 0.5);
    };
    measure();
    const seen = new ResizeObserver(measure);
    seen.observe(bar);
    return () => seen.disconnect();
  }, [allWords, period, rolling]);
  useEffect(() => onBelow?.(below && pinned.length > 0), [below, pinned.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const setValue = (id: string, value: string) => onChange(filters.map((r) => (r.id === id ? { ...r, value } : r)));
  return (
    <div
      ref={barRef}
      className={["filter-bar", pinned.length > 0 && "filter-bar--rules", pinned.length > 0 && below && "filter-bar--below", !period && "filter-bar--no-period"].filter(Boolean).join(" ")}
    >
      {period && state?.counted && <RollingMark />}
      {period && (
        <span className="filter-bar__label" title={state ? periodText(state) : text}>
          {text}
        </span>
      )}
      {pinned.length > 0 && (
        <div className="filter-bar__rules">
          {pinned.map(({ rule, field, words }) => (
            <div key={rule.id} className="filter-bar__rule">
              <label className="filter-bar__words" htmlFor={`${uid}-bar-${rule.id}`} title={words}>
                {words}
              </label>
              <RuleValue id={`${uid}-bar-${rule.id}`} owner={ownerOf(field.id)} field={field} rule={rule} refs={refs} labelText={words} pickOnly={touch} onChange={(value) => setValue(rule.id, value)} />
            </div>
          ))}
        </div>
      )}
      {period && (
        <>
          <IconButton autoAlign kind="ghost" size="sm" align="bottom" label="Previous" disabled={still} onClick={() => value && set(stepValue(value.value, -1, now))}>
            <ChevronLeft />
          </IconButton>
          <IconButton autoAlign kind="ghost" size="sm" align="bottom" label="Next" disabled={still} onClick={() => value && set(stepValue(value.value, 1, now))}>
            <ChevronRight />
          </IconButton>
          <IconButton autoAlign kind="ghost" size="sm" align="bottom" label={latest} disabled={!state || state.kind === "range"} onClick={() => value && set(latestValue(value.value, now))}>
            <PageLast />
          </IconButton>
        </>
      )}
      {children}
    </div>
  );
}
