import { useId } from "react";
import { Button, Heading, IconButton, Select, SelectItem, TextInput } from "@carbon/react";
import { Add, TrashCan } from "@carbon/icons-react";
import { newId, pickableFields, type FieldDef, type ObjectType } from "../domain/model";
import {
  isGroupable,
  operatorsFor,
  sortableFields,
  type FilterOperator,
  type FilterRule,
  type GroupOrder,
  type ViewQuery,
} from "../domain/query";
import type { RefOptions } from "../ui/useReferenceOptions";

interface Props {
  type: ObjectType;
  query: ViewQuery;
  refs: RefOptions;
  part: "filter" | "sortGroup";
  /** Filter part: its heading and what an empty filter means (defaults: a view's). */
  title?: string;
  emptyText?: string;
  onChange(query: ViewQuery): void;
}

/** Value input for a filter rule, by field kind (a date input, an object picker, plain text…). */
function RuleValue({ id, field, rule, refs, onChange }: { id: string; field: FieldDef; rule: FilterRule; refs: RefOptions; onChange(value: string): void }) {
  if (field.kind === "object" || field.kind === "object_list") {
    return (
      <Select id={id} labelText="Value" hideLabel size="sm" value={rule.value} onChange={(e) => onChange(e.target.value)}>
        <SelectItem value="" text="Choose…" disabled hidden />
        {(refs[field.targetTypeId ?? ""] ?? []).map((o) => (
          <SelectItem key={o.id} value={o.id} text={o.label} />
        ))}
      </Select>
    );
  }
  const type = field.kind === "number" ? "number" : field.kind === "date" || field.kind === "datetime" ? "date" : "text";
  return (
    <TextInput
      id={id}
      labelText="Value"
      hideLabel
      size="sm"
      type={type}
      placeholder={type === "date" ? "yyyy-mm-dd" : "Value"}
      value={rule.value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * Edits part of a view's query: its filters, or its sort and grouping (each shown in its own
 * toolbar popover). Built only on the query registry (domain/query.ts).
 */
export function QueryEditor({ type, query, refs, part, title = "Filter", emptyText = "Showing all objects.", onChange }: Props) {
  // Element ids unique per editor: several object lists (tabs, panes) can be open at once.
  const uid = useId();
  const fieldsById = new Map(pickableFields(type).map((f) => [f.id, f]));
  const setFilter = (id: string, patch: Partial<FilterRule>) =>
    onChange({ ...query, filters: query.filters.map((r) => (r.id === id ? { ...r, ...patch } : r)) });

  const addFilter = () => {
    const field = type.fields[0];
    if (!field) return;
    onChange({ ...query, filters: [...query.filters, { id: newId(), fieldId: field.id, operator: operatorsFor(field.kind)[0].id, value: "" }] });
  };

  const sort = query.sort[0];
  const groupable = pickableFields(type).filter((f) => isGroupable(f.kind));

  return (
    <div className="query-editor">
      {part === "filter" && (
      <section>
        <Heading className="query-editor__title">{title}</Heading>
        {query.filters.length === 0 && <p className="helper">{emptyText}</p>}
        {query.filters.map((rule) => {
          const field = fieldsById.get(rule.fieldId);
          if (!field) return null;
          const operator = operatorsFor(field.kind).find((o) => o.id === rule.operator) ?? operatorsFor(field.kind)[0];
          return (
            <div key={rule.id} className="query-editor__rule">
              <Select
                id={`${uid}-filter-field-${rule.id}`}
                labelText="Field"
                hideLabel
                size="sm"
                value={rule.fieldId}
                onChange={(e) => {
                  const next = fieldsById.get(e.target.value)!;
                  setFilter(rule.id, { fieldId: next.id, operator: operatorsFor(next.kind)[0].id, value: "" });
                }}
              >
                {pickableFields(type).map((f) => (
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
                {operatorsFor(field.kind).map((o) => (
                  <SelectItem key={o.id} value={o.id} text={o.label} />
                ))}
              </Select>
              {operator.needsValue ? (
                <RuleValue id={`${uid}-filter-value-${rule.id}`} field={field} rule={rule} refs={refs} onChange={(value) => setFilter(rule.id, { value })} />
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
        {type.fields.length > 0 && (
          <Button kind="tertiary" size="sm" renderIcon={Add} iconDescription="Add filter" onClick={addFilter} className="query-editor__add">
            Add filter
          </Button>
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
            {sortableFields(type).map((f) => (
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

      <section>
        <Heading className="query-editor__title">Group</Heading>
        <div className="query-editor__pair">
          <Select
            id={`${uid}-group-by`}
            labelText="Group by"
            size="sm"
            value={query.groupBy ?? ""}
            onChange={(e) => onChange({ ...query, groupBy: e.target.value || null })}
          >
            <SelectItem value="" text="No grouping" />
            {groupable.map((f) => (
              <SelectItem key={f.id} value={f.id} text={f.name} />
            ))}
          </Select>
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
            <SelectItem value="count" text="Most objects first" />
          </Select>
        </div>
      </section>
      </>
      )}
    </div>
  );
}
