import type { ObjectType } from "../domain/model";
import { defaultQuery, type FilterRule } from "../domain/query";
import { QueryEditor } from "../views/QueryEditor";
import { useReferenceOptions } from "./useReferenceOptions";

/**
 * Which objects a reference field offers: filters over the type it refers to, edited like a
 * view's filters (e.g. Book's Tags offers only tags whose "Used for" contains "Books").
 */
export function ChoiceFilterEditor({ target, filters, onChange }: { target: ObjectType; filters: FilterRule[]; onChange(filters: FilterRule[]): void }) {
  // The target's own reference fields need their options for "is" rules.
  const refs = useReferenceOptions(target);
  return (
    <QueryEditor
      type={target}
      query={{ ...defaultQuery(), filters }}
      refs={refs}
      part="filter"
      title="Choices"
      emptyText={`Any ${target.name} can be chosen.`}
      onChange={(q) => onChange(q.filters)}
    />
  );
}
