import { useEffect, useMemo, useState } from "react";
import { ComboBox, Select, SelectItem, TextInput } from "@carbon/react";
import type { Collection, FieldDef, FieldKind } from "../domain/model";
import { dollarNames } from "../domain/components";
import { canGroup, deviceTimeZone, sourceQuery } from "../domain/sources";
import {
  chosenOptions,
  filterCodeValue,
  filterValueProblem,
  hasSections,
  isPageValue,
  offersValues,
  PAGE_ITEM,
  pageItemField,
  valueOptions,
  type FilterRule,
  type ValueOption,
} from "../domain/query";
import type { RefOptions } from "../ui/useReferenceOptions";
import { useItems } from "../app/useItems";
import { useStore } from "../app/store";

/** The page's fields whose values a rule on a field of this kind compares with (same kind; text with text). */
const TEXT_KINDS: FieldKind[] = ["string", "markdown", "html", "ai", "string_list", "checklist"];
function comparablePageFields(kind: FieldKind, page: Collection): FieldDef[] {
  const kinds: FieldKind[] = TEXT_KINDS.includes(kind) ? ["string", "ai"] : kind === "number_list" ? ["number"] : kind === "number" || kind === "date" || kind === "datetime" || kind === "checkbox" ? [kind] : [];
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
export function RuleValue({
  id,
  owner,
  field,
  rule,
  refs,
  page,
  labelText,
  onChange,
}: {
  id: string;
  /** The collection the field is of (a page-wide filter's: its own collection's): where its existing values come from. */
  owner: Collection;
  field: FieldDef;
  rule: FilterRule;
  refs: RefOptions;
  page?: Collection;
  /** Its (hidden) label: the filter bar names the rule ("Genre is"); default "Value". */
  labelText?: string;
  onChange(value: string): void;
}) {
  const label = labelText ?? "Value";
  const hideLabel = true;
  if (field.kind === "item" || field.kind === "item_list") {
    // On an item page: the page's item itself, or what one of its reference fields points to.
    const pageFields = page ? page.fields.filter((f) => f.kind === "item" && f.targetCollectionId === field.targetCollectionId) : [];
    return (
      <Select id={id} labelText={label} hideLabel={hideLabel} size="sm" value={rule.value} onChange={(e) => onChange(e.target.value)}>
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
    <TypedValue
      id={id}
      owner={owner}
      field={field}
      rule={rule}
      label={label}
      hideLabel={hideLabel}
      placeholder={field.kind === "checkbox" ? "true or false" : date ? "yyyy-mm-dd" : "Value"}
      note={note}
      onChange={onChange}
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

interface TypedProps {
  id: string;
  owner: Collection;
  field: FieldDef;
  rule: FilterRule;
  label: string;
  hideLabel: boolean;
  placeholder: string;
  note: { helper?: string; problem?: string };
  onChange(value: string): void;
}

/** A collection whose items are its own (not Backlinks, a list's entries or several collections merged): its values can be offered. */
const ownValues = (c: Collection) => !c.virtual && !c.listOf && !c.mergedFrom;

/**
 * A typed value: a box offering the field's existing values where the rule compares with one
 * (`offersValues`: "Genre is ▾"), any other text typed as well, else a plain text input. Code ({{ }})
 * is always typed.
 */
function TypedValue(props: TypedProps) {
  const { owner, field, rule } = props;
  if (!offersValues(field, rule.operator) || hasSections(rule.value) || !ownValues(owner)) return <PlainValue {...props} />;
  return owner.source ? <RemoteValues {...props} /> : <LocalValues {...props} />;
}

function PlainValue({ id, field, rule, label, hideLabel, placeholder, note, onChange }: TypedProps) {
  return (
    <TextInput
      id={id}
      labelText={label}
      hideLabel={hideLabel}
      size="sm"
      inputMode={field.kind === "number" || field.kind === "number_list" ? "decimal" : undefined}
      placeholder={placeholder}
      value={rule.value}
      helperText={note.helper}
      invalid={!!note.problem}
      invalidText={note.problem}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** A native collection's values: from its items as loaded (this space's), worked out again as they change. */
function LocalValues(props: TypedProps) {
  const { items } = useItems(props.owner);
  const options = useMemo(() => (items ? valueOptions(props.field, items) : []), [items, props.field]);
  // While nothing repeats (or before the items are in) it is a plain input: no menu to open.
  return options.length ? <ValueBox {...props} options={options} /> : <PlainValue {...props} />;
}

/** A remote collection's values: its source's groups of the column, asked once a session (`remoteValues`). */
function RemoteValues(props: TypedProps) {
  const options = useRemoteValues(props.owner, props.field);
  return options?.length ? <ValueBox {...props} options={options} /> : <PlainValue {...props} />;
}

function ValueBox({ id, field, rule, label, hideLabel, placeholder, note, onChange, options }: TypedProps & { options: ValueOption[] }) {
  return (
    <ComboBox
      autoAlign
      id={id}
      size="sm"
      titleText={hideLabel ? undefined : label}
      aria-label={label}
      inputMode={field.kind === "number" || field.kind === "number_list" ? "decimal" : undefined}
      placeholder={placeholder}
      items={options.map((o) => o.value)}
      itemToString={(v) => v ?? ""}
      allowCustomValue
      selectedItem={rule.value || null}
      helperText={note.helper}
      invalid={!!note.problem}
      invalidText={note.problem}
      onChange={({ selectedItem }) => onChange(selectedItem ?? "")}
      onInputChange={(text) => text !== rule.value && onChange(text)}
    />
  );
}

/** A remote field's values by source and column, asked once a session (a GROUP BY over the whole table). */
const remoteValues = new Map<string, Promise<ValueOption[]>>();

/** The values a remote field's box offers: its column's groups (at most MAX_SOURCE_GROUPS), as `valueOptions` chooses them; null while asked (or when it can't be grouped, or the request failed). */
function useRemoteValues(collection: Collection, field: FieldDef): ValueOption[] | null {
  const { sources } = useStore();
  const name = collection.source?.name;
  const key = `${name}\u0000${field.id}`;
  const [got, setGot] = useState<{ key: string; options: ValueOption[] } | null>(null);
  useEffect(() => {
    if (!name || !canGroup(collection, field)) return;
    let live = true;
    let asked = remoteValues.get(key);
    if (!asked) {
      const request = sourceQuery(collection, { filters: [], sort: [], groupBy: field.id }, "", deviceTimeZone());
      if (!request.groupBy) return;
      asked = sources.query(name, { ...request, offset: 0, limit: 1, counts: true }).then((r) => {
        const groups = r.groups ?? [];
        const empty = groups.find((g) => g.key === "")?.count ?? 0;
        return chosenOptions(groups.filter((g) => g.key !== "").map((g) => ({ value: g.key, count: g.count })), (r.total ?? 0) - empty);
      });
      remoteValues.set(key, asked);
      // A failed request is asked again next time.
      asked.catch(() => remoteValues.delete(key));
    }
    asked.then((options) => live && setGot({ key, options }), () => undefined);
    return () => {
      live = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return got?.key === key ? got.options : null;
}
