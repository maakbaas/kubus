import type { FieldDef } from "../domain/model";
import { Highlight } from "./Highlight";
import { RelatedLink } from "./RelatedLink";
import { labelOf, type RefOptions } from "./useReferenceOptions";

/**
 * A link to the object a reference field points at, labelled from the loaded options: nothing
 * while they load, "(deleted)" for an object that is gone. `search` highlights matching text.
 */
export function ObjectLink({ field, id, refs, search }: { field: FieldDef; id: string; refs: RefOptions; search?: string }) {
  const options = refs[field.targetTypeId ?? ""];
  const label = labelOf(options, id);
  if (label === undefined) return options ? <span className="object-view__muted">(deleted)</span> : null;
  return (
    <RelatedLink path={`/types/${field.targetTypeId}/objects/${id}`}>
      {search ? <Highlight text={label} query={search} /> : label}
    </RelatedLink>
  );
}
