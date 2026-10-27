import type { FieldDef } from "../domain/model";
import { Highlight } from "./Highlight";
import { RelatedLink } from "./RelatedLink";
import { labelOf, type RefOptions } from "./useReferenceOptions";

/**
 * A link to the item a reference field points at, labelled from the loaded options: nothing
 * while they load, "(deleted)" for an item that is gone. `search` highlights matching text.
 */
export function ItemLink({ field, id, refs, search }: { field: FieldDef; id: string; refs: RefOptions; search?: string }) {
  const options = refs[field.targetCollectionId ?? ""];
  const label = labelOf(options, id);
  if (label === undefined) return options ? <span className="item-view__muted">(deleted)</span> : null;
  return (
    <RelatedLink path={`/collections/${field.targetCollectionId}/items/${id}`}>
      <Highlight text={label} query={search ?? ""} />
    </RelatedLink>
  );
}
