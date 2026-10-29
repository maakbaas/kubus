import { useId, type ReactNode } from "react";
import { Button, Heading, IconButton, Select, SelectItem, TextInput } from "@carbon/react";
import { Add, TrashCan } from "@carbon/icons-react";
import { isMetaField, newId, pickableFields, selfField, type FieldDef, type FieldKind, type Collection } from "../domain/model";
import { canFilter, canGroup, canSort, fieldOperators } from "../domain/sources";
import { dollarNames } from "../domain/components";
import {
  filterCodeValue,
  filterValueProblem,
  hasSections,
  isPageValue,
  PAGE_ITEM,
  pageItemField,
  sortableFields,
  type FilterOperator,
  type FilterRule,
  type GroupOrder,
  type ViewQuery,
} from "../domain/query";
import { DEFAULT_GROUP_DATE, GROUP_DATES, type GroupDate } from "../domain/groupDate";
import { dateFields, periodRule } from "../domain/datePeriod";
import type { RefOptions } from "../ui/useReferenceOptions";
import { DatePeriodFilter } from "./DatePeriodFilter";
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
  onChange(query: ViewQuery): void;
}

/** The page's fields whose values a rule on a field of this kind compares with (same kind; text with text). */
const TEXT_KINDS: FieldKind[] = ["string", "markdown", "html", "ai", "string_list", "checklist"];
function comparablePageFields(kind: FieldKind, page: Collection): FieldDef[] {
  const kinds: FieldKind[] = TEXT_KINDS.includes(kind) ? ["string", "ai"] : kind === "number" || kind === "date" || kind === "datetime" || kind === "checkbox" ? [kind] : [];
  return page.fields.filter((f) => kinds.includes(f.kind));
}

/** A rule's value as typed (not taken from the page's item). */
const FIXED = "fixed";

/**
 * What a typed value says under its input: what its {{ }} code works out to now ("= true"), or why
 * it can't be compared (failing code, "maybe" for a checkbox), shown as invalid.
 */
function valueNote(field: FieldDef, rule: FilterRule, page?: Collection): { helper?: string; problem?: string } {
  const code = hasSections(rule.value);
  // On an item page, code reading $item is worked out for each page's item, not here.
  if (code && page && dollarNames(rule.value).includes("item")) return { helper: `Worked out for each ${page.name}'s page` };
  const value = code ? filterCodeValue(rule.value, null) : rule.value;
  const problem = filterValueProblem(field, rule.operator, value);
  if (problem) return { problem };
  return code ? { helper: `= ${value || "(empty)"}` } : {};
}

/**
 * Value input for a filter rule, by field kind (an item picker, text otherwise). The text may hold
 * {{ }} code, worked out when the filter runs ($now; on an item page also $item, the page's item).
 * On an item page the value can also be one of the page's item's values, picked by name ("This
 * Book's Year").
 */
function RuleValue({ id, field, rule, refs, page, onChange }: { id: string; field: FieldDef; rule: FilterRule; refs: RefOptions; page?: Collection; onChange(value: string): void }) {
  if (field.kind === "item" || field.kind === "item_list") {
    // On an item page: the page's item itself, or what one of its reference fields points to.
    const pageFields = page ? page.fields.filter((f) => f.kind === "item" && f.targetCollectionId === field.targetCollectionId) : [];
    return (
      <Select id={id} labelText="Value" hideLabel size="sm" value={rule.value} onChange={(e) => onChange(e.target.value)}>
        <SelectItem value="" text="Choose…" disabled hidden />
        {page && field.targetCollectionId === page.id && <SelectItem value={PAGE_ITEM} text={`This ${page.name}`} />}
        {pageFields.map((f) => (
          <SelectItem key={f.id} value={pageItemField(f.id)} text={`This ${page!.name}’s ${f.name}`} />
        ))}
        {(refs[field.targetCollectionId ?? ""] ?? []).filter((o) => !o.elsewhere || o.id === rule.value).map((o) => (
          <SelectItem key={o.id} value={o.id} text={o.label} />
        ))}
      </Select>
    );
  }
  // Text for every kind, so {{ }} code can be typed (a number or date input would refuse the braces).
  const date = field.kind === "date" || field.kind === "datetime";
  const note = valueNote(field, rule, page);
  const input = (
    <TextInput
      id={id}
      labelText="Value"
      hideLabel
      size="sm"
      inputMode={field.kind === "number" ? "decimal" : undefined}
      placeholder={field.kind === "checkbox" ? "true or false" : date ? "yyyy-mm-dd" : "Value"}
      value={rule.value}
      helperText={note.helper}
      invalid={!!note.problem}
      invalidText={note.problem}
      onChange={(e) => onChange(e.target.value)}
    />
  );
  const pageFields = page ? comparablePageFields(field.kind, page) : [];
  if (pageFields.length === 0) return input;
  const fromPage = isPageValue(rule.value);
  return (
    <div className="query-editor__value">
      <Select
        id={`${id}-from`}
        labelText="Value from"
        hideLabel
        size="sm"
        value={fromPage ? rule.value : FIXED}
        onChange={(e) => onChange(e.target.value === FIXED ? "" : e.target.value)}
      >
        <SelectItem value={FIXED} text="A value" />
        {pageFields.map((f) => (
          <SelectItem key={f.id} value={pageItemField(f.id)} text={`This ${page!.name}’s ${f.name}`} />
        ))}
      </Select>
      {!fromPage && input}
    </div>
  );
}

/**
 * Edits part of a view's query: its filters, or its sort and grouping (each shown in its own
 * toolbar popover). Built only on the query registry (domain/query.ts).
 */
const SHOWING_ALL = "Showing all items.";

export function QueryEditor({ collection, query, refs, part, noGroup, page, title, emptyText = SHOWING_ALL, footer, owners, onChange }: Props) {
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
  const sort = query.sort[0];
  const groupable = pickableFields(collection).filter((f) => canGroup(collection, f));
  const dated = dateFields(collection).length > 0;
  const { collections } = useStore();
  const remoteMerged = hasRemotePart(collection, collections);
  const groupDates = dateParts(query.groupBy ? fieldsById.get(query.groupBy) : undefined, remoteMerged);

  return (
    <div className="query-editor">
      {part === "filter" && (
      <section>
        {title && <Heading className="query-editor__title">{title}</Heading>}
        {/* Not for a remote collection without dates (its rows have no Created or Updated). */}
        {dated && <DatePeriodFilter collection={collection} filters={query.filters} page={page} onChange={(filters) => onChange({ ...query, filters })} />}
        {query.filters.length === 0 && (emptyText !== SHOWING_ALL || !dated) && <p className="helper">{emptyText}</p>}
        {query.filters.map((rule) => {
          if (rule === period) return null;
          const field = fieldsById.get(rule.fieldId);
          if (!field) return null;
          const offered = operators(field);
          if (offered.length === 0) return null;
          const operator = offered.find((o) => o.id === rule.operator) ?? offered[0];
          return (
            <div key={rule.id} className="query-editor__rule">
              {rule === listed[0] && !joinsFirst ? (
                <span className="query-editor__join">Where</span>
              ) : (
                <Select
                  id={`${uid}-filter-join-${rule.id}`}
                  labelText="Join"
                  hideLabel
                  size="sm"
                  value={rule.join ?? "and"}
                  onChange={(e) => setFilter(rule.id, { join: e.target.value === "or" ? "or" : undefined })}
                >
                  <SelectItem value="and" text="And" />
                  <SelectItem value="or" text="Or" />
                </Select>
              )}
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
                <RuleValue id={`${uid}-filter-value-${rule.id}`} field={field} rule={rule} refs={refs} page={page} onChange={(value) => setFilter(rule.id, { value })} />
              ) : (
                <span />
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
            </div>
          );
        })}
        {(filterable.some((f) => !isMetaField(f)) || footer) && (
          <div className="query-editor__foot">
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
      <section>
        <Heading className="query-editor__title">Sort</Heading>
        <div className="query-editor__pair">
          <Select
            id={`${uid}-sort-field`}
            labelText="Sort by"
            size="sm"
            value={sort?.fieldId ?? ""}
            onChange={(e) =>
              onChange({ ...query, sort: e.target.value ? [{ fieldId: e.target.value, direction: sort?.direction ?? "asc" }] : [] })
            }
          >
            <SelectItem value="" text="No sorting" />
            {sortableFields(collection).filter((f) => canSort(collection, f.id)).map((f) => (
              <SelectItem key={f.id} value={f.id} text={f.name} />
            ))}
          </Select>
          <Select
            id={`${uid}-sort-direction`}
            labelText="Direction"
            size="sm"
            disabled={!sort}
            value={sort?.direction ?? "asc"}
            onChange={(e) => sort && onChange({ ...query, sort: [{ ...sort, direction: e.target.value as "asc" | "desc" }] })}
          >
            <SelectItem value="asc" text="Ascending" />
            <SelectItem value="desc" text="Descending" />
          </Select>
        </div>
      </section>

      {!noGroup && (
      <section>
        <Heading className="query-editor__title">Group</Heading>
        <div className="query-editor__pair">
          <Select
            id={`${uid}-group-by`}
            labelText="Group by"
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
          {groupDates.length > 0 && (
            <Select
              id={`${uid}-group-date`}
              labelText="Group dates by"
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
                <SelectItem key={p.value} value={p.value} text={p.text} />
              ))}
            </Select>
          )}
          <Select
            id={`${uid}-group-order`}
            labelText="Group order"
            size="sm"
            disabled={!query.groupBy}
            value={query.groupOrder ?? "asc"}
            onChange={(e) => {
              const groupOrder = e.target.value as GroupOrder;
              // The default isn't stored, so views saved before the option compare equal.
              const { groupOrder: _old, ...rest } = query;
              onChange(groupOrder === "asc" ? rest : { ...rest, groupOrder });
            }}
          >
            <SelectItem value="asc" text="Ascending" />
            <SelectItem value="desc" text="Descending" />
            <SelectItem value="count" text="Most items first" />
          </Select>
        </div>
      </section>
      )}
      </>
      )}
    </div>
  );
}
