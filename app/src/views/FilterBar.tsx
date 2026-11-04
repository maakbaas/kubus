import { useId, useRef, type ReactNode } from "react";
import { Dropdown, IconButton } from "@carbon/react";
import { ChevronLeft, ChevronRight, PageLast } from "@carbon/icons-react";
import type { Collection } from "../domain/model";
import type { FilterRule } from "../domain/query";
import { KINDS, steps } from "./DatePeriodFilter";
import {
  defaultDateField,
  kindValue,
  latestValue,
  nowMinute,
  periodRule,
  periodState,
  periodWords,
  rollingLabel,
  splitAnchor,
  stepValue,
  withPeriod,
  type Unit,
} from "../domain/datePeriod";

type UnitChoice = { kind: Unit; text: string };

/** The kinds of the bar's switch (a range is only chosen in the filter panel), as its menu says them. */
const ADVERBS: Record<Unit, string> = { hour: "Hourly", day: "Daily", week: "Weekly", month: "Monthly", year: "Yearly" };
const UNITS: UnitChoice[] = KINDS.filter((k): k is { kind: Unit; text: string } => k.kind !== "range").map((k) => ({ kind: k.kind, text: ADVERBS[k.kind] }));

/**
 * A collection view's filter bar ("Show filter bar" in View settings), below its tabs: the date period
 * (domain/datePeriod.ts) as a line of words at the left, and at the right ‹ › stepping it (a rolling one
 * stays rolling), >| "this one" (the most recent one of its kind: rolling, this week, not literally these
 * days) and the view's Filter button (`children`: it leaves the toolbar while the bar is shown), touching
 * and ending where the toolbar's icon buttons end. The unit word of the line is the dropdown that
 * switches the kind (Hourly … Yearly), with its number, and at most one word stands before it:
 * "This [week]", "[7 weeks] ago", "Last [7 days]", "[Year] to date" (periodWords). In a period with no
 * unit word its first words are the dropdown ("[Today]", "[October 2026]", "[Week 44]", "[1 Oct – 15 Nov 2026]"),
 * and none yet is "[Any date]". The period's days are not shown (on any width): the whole line with them is
 * the tooltip. Every change is an edit of the view's filter, as in the filter panel
 * (DatePeriodFilter), which keeps what only it has: a range, the window (last n, so far) and the field the
 * period goes by. The line takes what room is left and is ellipsized, so stepping never moves the buttons.
 */
export function FilterBar({ collection, filters, onChange, children }: { collection: Collection; filters: FilterRule[]; onChange(filters: FilterRule[]): void; children: ReactNode }) {
  const uid = useId();
  const head = useRef<HTMLSpanElement>(null);
  const now = nowMinute();
  const rule = periodRule(filters);
  const value = rule ? splitAnchor(rule.value) : null;
  const state = value ? periodState(value.value, now) : null;
  const set = (next: string | null) => next && onChange(withPeriod(filters, defaultDateField(collection), next));
  const words = state ? periodWords(state) : null;
  const kind = state && state.kind !== "range" ? UNITS.find((u) => u.kind === state.kind) : undefined;
  const latest = state && state.kind !== "range" ? rollingLabel({ kind: state.kind, offset: 0 }) : "Most recent";
  const still = !steps(state, !!value?.fieldId);
  // What the dropdown shows: the unit word with its number ("Last [7 days]"), else the words that stand first:
  // the counting ("[Today]"), else the period's first part ("[October 2026]", "[Week 44]"); none: "Any date".
  // At most one word before it; the days are only in the tooltip.
  const dayParts = words ? words.days.split(" - ") : [];
  const shown = words?.unit ?? (words ? words.before || dayParts[0] : "Any date");
  const before = words?.unit ? words.before : "";
  const after = words?.unit ? words.after : "";
  // The whole line, with the days: the tooltip.
  const more = words ? (words.unit || words.before ? dayParts : dayParts.slice(1)) : [];
  const label = [before, shown, after].filter(Boolean).join(" ") + (more.length ? ` - ${more.join(" - ")}` : "");
  // The menu hangs from the dropdown's left edge and is wider than its word: moved left as far as it would
  // run past the window's right edge (Carbon's floating placement only flips it up or down). Once placed.
  const keepMenuOnPage = () =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const menu = head.current?.querySelector<HTMLElement>(".cds--list-box__menu");
        if (!menu) return;
        menu.style.marginInlineStart = "";
        const room = document.documentElement.clientWidth - parseFloat(getComputedStyle(document.documentElement).fontSize);
        const over = menu.getBoundingClientRect().right - room;
        if (over > 0) menu.style.marginInlineStart = `${-over}px`;
      }),
    );
  return (
    <div className="filter-bar">
      <span className="filter-bar__label" title={label}>
        <span className="filter-bar__head" ref={head} onClickCapture={keepMenuOnPage} onKeyDownCapture={keepMenuOnPage}>
          {before && <span className="filter-bar__text">{before}</span>}
          <Dropdown<UnitChoice | null>
            autoAlign
            type="inline"
            size="sm"
            id={`${uid}-kind`}
            className="filter-bar__kind"
            titleText="Period"
            hideLabel
            label={shown}
            items={UNITS}
            selectedItem={kind ?? null}
            itemToString={(u) => u?.text ?? ""}
            renderSelectedItem={() => shown}
            // The same window in the other kind; with no period yet, the current one (kindValue).
            onChange={({ selectedItem }) => selectedItem && set(kindValue(value ? value.value : null, selectedItem.kind, now))}
          />
          {after && <span className="filter-bar__text">{after}</span>}
        </span>
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
}
