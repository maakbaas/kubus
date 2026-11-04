import { useId, type ReactNode } from "react";
import { Button, Heading, IconButton, Select, SelectItem } from "@carbon/react";
import { Add, Pin, PinFilled, TrashCan } from "@carbon/icons-react";
import { isMetaField, newId, pickableFields, selfField, type FieldDef, type Collection } from "../domain/model";
import { canFilter, canGroup, canSort, fieldOperators, isRemote } from "../domain/sources";
import {
  sortableFields,
  type FilterOperator,
  type FilterRule,
  type GroupOrder,
  type ItemGroup,
  type SortRule,
  type ViewQuery,
} from "../domain/query";
import { DEFAULT_GROUP_DATE, GROUP_DATES, type GroupDate } from "../domain/groupDate";
import { dateFields, periodRule } from "../domain/datePeriod";
import type { RefOptions } from "../ui/useReferenceOptions";
import { DatePeriodFilter } from "./DatePeriodFilter";
import { RuleValue } from "./RuleValue";
import { JoinSelect } from "./JoinSelect";
import { GroupOrderList } from "./GroupOrderList";
import { useStore } from "../app/store";
import { hasRemotePart } from "../domain/mergedCollection";

/** The ways to group by a date field (none for another kind, and for a merged collection with a remote part: its source groups by the value). An hour is of a date & time only. A remote collection's rows are grouped by a part other than the day in the app (groupsInApp). */
function dateParts(field: FieldDef | undefined, remoteMerged: boolean) {
  if (remoteMerged || (field?.kind !== "date" && field?.kind !== "datetime")) return [];
  return GROUP_DATES.filter((p) => p.value !== "hour" || field.kind === "datetime");
}

interface Props {
  collection: Collection;
  query: ViewQuery;
  refs: RefOptions;
  part: "filter" | "sortGroup";
  /** Sort part: without the grouping (a block whose items aren't shown in groups). */
  noGroup?: boolean;
  /** On an item page: its collection, so reference rules can compare with the page's item. */
  page?: Collection;
  /** Sort part: the block's groups now, for a custom group order to drag (none: Custom isn't offered). */
  groups?: ItemGroup[];
  /**
   * Filter part: its heading (none where its button says it: "Filter"), what an empty filter means
   * (default: a view's, left out under a date period, whose "Any date" says it), and what goes
   * beside "Add filter" (a block's limit).
   */
  title?: string;
  emptyText?: string;
  footer?: ReactNode;
  /** A page-wide filter over several collections (`collection` holds all their fields): each field's operators are its own collection's (a remote one's, what its column supports). */
  owners?: Collection[];
  /** Filter part of a view whose filter bar is shown: a rule can be put on the bar (`FilterRule.onBar`), its value edited there. */
  bar?: boolean;
  /** With `bar`: whether the date period is on the bar, and its pin (DatePeriodFilter). */
  periodPin?: { on: boolean; set(on: boolean): void };
  onChange(query: ViewQuery): void;
}

/**
 * Edits part of a view's query: its filters, or its sort and grouping (each shown in its own
 * toolbar popover). Built only on the query registry (domain/query.ts).
 */
const SHOWING_ALL = "Showing all items.";

export function QueryEditor({ collection, query, refs, part, noGroup, page, groups, title, emptyText = SHOWING_ALL, footer, owners, bar, periodPin, onChange }: Props) {
  // Element ids unique per editor: several item lists (tabs, panes) can be open at once.
  const uid = useId();
  // On an item page, a block of its own collection can also be filtered on the item itself
  // ("Item is This Book": the page's item alone), not in a page-wide filter (several collections).
  const self = page && page.id === collection.id && !owners ? [selfField(collection)] : [];
  const fieldsById = new Map([...pickableFields(collection), selfField(collection)].map((f) => [f.id, f]));
  const setFilter = (id: string, patch: Partial<FilterRule>) =>
    onChange({ ...query, filters: query.filters.map((r) => (r.id === id ? { ...r, ...patch } : r)) });

  // Fields it can filter by (in a remote collection: its columns, by what each supports).
  const ownerOf = (f: FieldDef) => owners?.find((c) => c.fields.some((x) => x.id === f.id)) ?? collection;
  const filterable = [...pickableFields(collection), ...self].filter((f) => canFilter(ownerOf(f), f));
  const operators = (f: FieldDef) => fieldOperators(ownerOf(f), f);
  const addFilter = () => {
    const field = filterable.find((f) => !isMetaField(f));
    if (!field) return;
    onChange({ ...query, filters: [...query.filters, { id: newId(), fieldId: field.id, operator: operators(field)[0].id, value: "" }] });
  };

  // The date period's rule is edited above the others (DatePeriodFilter), not in their list.
  const period = periodRule(query.filters);
  // Each rule says how it joins what comes before it (the filter it builds on, the rules above):
  // And narrows, Or lets more items in. The first rule of a filter building on nothing has nothing to join.
  const listed = query.filters.filter((r) => r !== period);
  const joinsFirst = (query.inherited?.length ?? 0) > 0;
  // Sort levels: what a remote collection's source can sort by; a field is in one level at most.
  const sortable = sortableFields(collection).filter((f) => canSort(collection, f.id));
  const unsorted = sortable.filter((f) => !query.sort.some((s) => s.fieldId === f.id));
  const setSort = (i: number, rule: SortRule) => onChange({ ...query, sort: query.sort.map((s, j) => (j === i ? rule : s)) });
  const groupable = pickableFields(collection).filter((f) => canGroup(collection, f));
  const dated = dateFields(collection).length > 0;
  const { collections } = useStore();
  const remoteMerged = hasRemotePart(collection, collections);
  const customOffered = !!groups && !isRemote(collection) && !remoteMerged;
  const groupDates = dateParts(query.groupBy ? fieldsById.get(query.groupBy) : undefined, remoteMerged);

  return (
    <div className="query-editor">
      {part === "filter" && (
      <section>
        {title && <Heading className="query-editor__title">{title}</Heading>}
        {/* Not for a remote collection without dates (its rows have no Created or Updated). */}
        {dated && <DatePeriodFilter collection={collection} filters={query.filters} page={page} joins={joinsFirst} pin={bar ? periodPin : undefined} onChange={(filters) => onChange({ ...query, filters })} />}
        {query.filters.length === 0 && (emptyText !== SHOWING_ALL || !dated) && <p className="helper">{emptyText}</p>}
        {query.filters.map((rule) => {
          if (rule === period) return null;
          const field = fieldsById.get(rule.fieldId);
          if (!field) return null;
          const offered = operators(field);
          if (offered.length === 0) return null;
          const operator = offered.find((o) => o.id === rule.operator) ?? offered[0];
          return (
            <div key={rule.id} className="query-editor__rule filter-group">
              {/* Its top row: how it joins the rules before it (And / Or; "Where" for a view's first), and its buttons. */}
              <div className="filter-group__head">
                {rule === listed[0] && !joinsFirst ? (
                  <span className="filter-group__word">Where</span>
                ) : (
                  <JoinSelect id={`${uid}-filter-join-${rule.id}`} value={rule.join ?? "and"} onChange={(join) => setFilter(rule.id, { join: join === "or" ? "or" : undefined })} />
                )}
                <span className="filter-group__buttons">
                  {bar && operator.needsValue && (
                    <IconButton
                      autoAlign
                      label={rule.onBar ? "Remove from filter bar" : "Show on filter bar"}
                      kind="ghost"
                      size="sm"
                      align="left"
                      onClick={() => setFilter(rule.id, { onBar: rule.onBar ? undefined : true })}
                    >
                      {rule.onBar ? <PinFilled /> : <Pin />}
                    </IconButton>
                  )}
                  <IconButton autoAlign
                    label="Remove filter"
                    kind="ghost"
                    size="sm"
                    align="left"
                    onClick={() => onChange({ ...query, filters: query.filters.filter((r) => r.id !== rule.id) })}
                  >
                    <TrashCan />
                  </IconButton>
                </span>
              </div>
              {/* Field, condition and value: three columns (on a phone the field on a row of its own). */}
              <div className="query-editor__fields">
                <Select
                  id={`${uid}-filter-field-${rule.id}`}
                  labelText="Field"
                  hideLabel
                  size="sm"
                  value={rule.fieldId}
                  onChange={(e) => {
                    const next = fieldsById.get(e.target.value)!;
                    setFilter(rule.id, { fieldId: next.id, operator: operators(next)[0].id, value: "" });
                  }}
                >
                  {filterable.map((f) => (
                    <SelectItem key={f.id} value={f.id} text={f.name} />
                  ))}
                </Select>
                <Select
                  id={`${uid}-filter-op-${rule.id}`}
                  labelText="Condition"
                  hideLabel
                  size="sm"
                  value={operator.id}
                  onChange={(e) => setFilter(rule.id, { operator: e.target.value as FilterOperator })}
                >
                  {offered.map((o) => (
                    <SelectItem key={o.id} value={o.id} text={o.label} />
                  ))}
                </Select>
                {operator.needsValue ? (
                  <RuleValue id={`${uid}-filter-value-${rule.id}`} owner={ownerOf(field)} field={field} rule={rule} refs={refs} page={page} onChange={(value) => setFilter(rule.id, { value })} />
                ) : (
                  <span />
                )}
              </div>
            </div>
          );
        })}
        {(filterable.some((f) => !isMetaField(f)) || footer) && (
          <div className="query-editor__foot query-editor__foot--filter">
            {filterable.some((f) => !isMetaField(f)) ? (
              <Button kind="tertiary" size="sm" renderIcon={Add} iconDescription="Add filter" onClick={addFilter}>
                Add filter
              </Button>
            ) : (
              <span />
            )}
            {footer}
          </div>
        )}
      </section>
      )}

      {part === "sortGroup" && (
      <>
      {/* As the filter's groups: each level, then the grouping, a group with its top row (its words at the left, its
          remove at the far right), then its field across two of three columns and its direction or order in the third. */}
      <section>
        {/* Levels: the first sorts, each next one orders what the ones above leave equal ("by date, then by name"). */}
        {query.sort.length === 0 && <p className="helper">Not sorted.</p>}
        {query.sort.map((rule, i) => (
          <div key={i} className="query-editor__rule filter-group">
            <div className="filter-group__head">
              <span className="filter-group__word">{i === 0 ? "Sort by" : "Then by"}</span>
              <span className="filter-group__buttons">
                <IconButton autoAlign
                  label="Remove sort level"
                  kind="ghost"
                  size="sm"
                  align="left"
                  onClick={() => onChange({ ...query, sort: query.sort.filter((_, j) => j !== i) })}
                >
                  <TrashCan />
                </IconButton>
              </span>
            </div>
            <div className="query-editor__pick">
              <Select
                id={`${uid}-sort-field-${i}`}
                labelText={i === 0 ? "Sort by" : "Then by"}
                hideLabel
                size="sm"
                value={rule.fieldId}
                onChange={(e) => setSort(i, { ...rule, fieldId: e.target.value })}
              >
                {sortable.filter((f) => f.id === rule.fieldId || !query.sort.some((s) => s.fieldId === f.id)).map((f) => (
                  <SelectItem key={f.id} value={f.id} text={f.name} />
                ))}
              </Select>
              <Select
                id={`${uid}-sort-direction-${i}`}
                labelText="Direction"
                hideLabel
                size="sm"
                value={rule.direction}
                onChange={(e) => setSort(i, { ...rule, direction: e.target.value as "asc" | "desc" })}
              >
                <SelectItem value="asc" text="Ascending" />
                <SelectItem value="desc" text="Descending" />
              </Select>
            </div>
          </div>
        ))}
        {unsorted.length > 0 && (
          <div className="query-editor__foot query-editor__foot--filter">
            <Button
              kind="tertiary"
              size="sm"
              renderIcon={Add}
              iconDescription="Add sort level"
              onClick={() => onChange({ ...query, sort: [...query.sort, { fieldId: unsorted[0].id, direction: "asc" }] })}
            >
              {query.sort.length === 0 ? "Add sort" : "Add sort level"}
            </Button>
          </div>
        )}
      </section>

      {!noGroup && (
      <section>
        <div className="query-editor__rule filter-group">
          {/* "Group by", a date's part inline after it ("Group by month"), and No grouping at the far right. */}
          <div className="filter-group__head">
            <span className="filter-group__lead">
              <span className="filter-group__word">Group by</span>
              {groupDates.length > 0 && (
                <Select
                  id={`${uid}-group-date`}
                  className="filter-join"
                  inline
                  labelText="Group dates by"
                  hideLabel
                  size="sm"
                  value={query.groupDate ?? DEFAULT_GROUP_DATE}
                  onChange={(e) => {
                    const groupDate = e.target.value as GroupDate;
                    // The default isn't stored, so views saved before the option compare equal.
                    const { groupDate: _old, ...rest } = query;
                    onChange(groupDate === DEFAULT_GROUP_DATE ? rest : { ...rest, groupDate });
                  }}
                >
                  {groupDates.map((p) => (
                    <SelectItem key={p.value} value={p.value} text={p.text.toLowerCase()} />
                  ))}
                </Select>
              )}
            </span>
            {query.groupBy && (
              <span className="filter-group__buttons">
                <IconButton
                  autoAlign
                  label="No grouping"
                  kind="ghost"
                  size="sm"
                  align="left"
                  onClick={() => {
                    const { groupDate: _date, groupOrder: _order, groupCustom: _custom, ...rest } = query;
                    onChange({ ...rest, groupBy: null });
                  }}
                >
                  <TrashCan />
                </IconButton>
              </span>
            )}
          </div>
          <div className="query-editor__pick">
            <Select
              id={`${uid}-group-by`}
              labelText="Group by"
              hideLabel
              size="sm"
              value={query.groupBy ?? ""}
              onChange={(e) => {
                const groupBy = e.target.value || null;
                // A date grouping goes with a date field (an hour only with a date & time one).
                const next = groupBy ? fieldsById.get(groupBy) : undefined;
                const { groupDate: _old, ...rest } = query;
                const keep = query.groupDate && dateParts(next, remoteMerged).some((p) => p.value === query.groupDate);
                onChange({ ...rest, groupBy, ...(keep && { groupDate: query.groupDate }) });
              }}
            >
              <SelectItem value="" text="No grouping" />
              {groupable.map((f) => (
                <SelectItem key={f.id} value={f.id} text={f.name} />
              ))}
            </Select>
            {query.groupBy && (
              <Select
                id={`${uid}-group-order`}
                labelText="Group order"
                hideLabel
                size="sm"
                value={query.groupOrder ?? "asc"}
                onChange={(e) => {
                  const groupOrder = e.target.value as GroupOrder;
                  // The default isn't stored, so views saved before the option compare equal.
                  const { groupOrder: _old, groupCustom: _oldCustom, ...rest } = query;
                  // Custom starts as the order shown now (then dragged).
                  const shownKeys = (groups ?? []).filter((g) => g.key !== "").map((g) => g.key);
                  onChange(groupOrder === "asc" ? rest : groupOrder === "custom" ? { ...rest, groupOrder, groupCustom: shownKeys } : { ...rest, groupOrder });
                }}
              >
                <SelectItem value="asc" text="Ascending" />
                <SelectItem value="desc" text="Descending" />
                <SelectItem value="count" text="Most items first" />
                {/* A remote collection's source orders its groups: no custom order there. */}
                {(customOffered || query.groupOrder === "custom") && <SelectItem value="custom" text="Custom" />}
              </Select>
            )}
          </div>
          {query.groupBy && query.groupOrder === "custom" && groups && (
            <GroupOrderList
              groups={groups}
              order={query.groupCustom ?? []}
              isDate={["date", "datetime"].includes(fieldsById.get(query.groupBy)?.kind ?? "")}
              onChange={(groupCustom) => onChange({ ...query, groupCustom })}
            />
          )}
        </div>
      </section>
      )}
      </>
      )}
    </div>
  );
}
