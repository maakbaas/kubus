import { useId, useMemo, useState } from "react";
import { Button, Dropdown, IconButton, TextInput } from "@carbon/react";
import { Merge, TrashCan } from "@carbon/icons-react";
import { canShow, mergeRef, partFields, readKind } from "../domain/blend";
import { newId, type Collection, type FieldDef } from "../domain/model";
import type { ViewBlock } from "../domain/views";

interface Choice {
  owner: Collection;
  field: FieldDef;
  label: string;
}

/**
 * "Merge fields" in the Fields menu of a block listing several collections: two fields of different collections that have
 * different names but can be shown alike become one column (stored with the block: `ViewBlock.merges`). Fields already in a
 * merged column are not offered again; a merged column is taken apart with its trash button.
 */
export function MergeFields({ block, parts, onSet }: { block: ViewBlock; parts: Collection[]; onSet(patch: Partial<ViewBlock>): void }) {
  const uid = useId();
  const [first, setFirst] = useState<Choice | null>(null);
  const [second, setSecond] = useState<Choice | null>(null);
  const [name, setName] = useState("");
  const merges = block.merges ?? [];
  const taken = useMemo(() => new Set(merges.flatMap((m) => m.fields)), [merges]);
  const all: Choice[] = useMemo(
    () => parts.flatMap((owner) => partFields(owner).filter((f) => !taken.has(mergeRef(owner.id, f.id))).map((field) => ({ owner, field, label: `${field.name} (${owner.pluralName})` }))),
    [parts, taken],
  );
  const partners = first ? all.filter((c) => c.owner.id !== first.owner.id && (canShow(readKind(first.field)!, readKind(c.field)) || canShow(readKind(c.field)!, readKind(first.field)))) : [];
  // The layout starts afresh: the columns changed (the new one is shown with the others).
  const set = (next: ViewBlock["merges"]) => onSet({ merges: next && next.length > 0 ? next : undefined, layout: { ...block.layout, fields: null, hiddenLabels: [] } });
  const collectionName = (id: string) => parts.find((c) => c.id === id)?.pluralName ?? "";
  const fieldName = (ref: string) => {
    const at = ref.indexOf("/");
    return parts.find((c) => c.id === ref.slice(0, at))?.fields.find((f) => f.id === ref.slice(at + 1))?.name ?? "(removed)";
  };
  return (
    <div className="merge-fields">
      <p className="cds--label">Merge fields</p>
      {merges.map((m) => (
        <div className="merge-fields__row" key={m.id}>
          <span className="merge-fields__text" title={m.fields.map((r) => `${fieldName(r)} (${collectionName(r.slice(0, r.indexOf("/")))})`).join(" + ")}>
            {m.name}: {m.fields.map((r) => `${fieldName(r)} (${collectionName(r.slice(0, r.indexOf("/")))})`).join(" + ")}
          </span>
          <IconButton autoAlign size="sm" kind="ghost" label={`Unmerge ${m.name}`} onClick={() => set(merges.filter((x) => x.id !== m.id))}>
            <TrashCan />
          </IconButton>
        </div>
      ))}
      <Dropdown<Choice>
        autoAlign
        size="sm"
        id={`${uid}-merge-a`}
        titleText="Merge this field"
        label="Choose a field"
        items={all}
        selectedItem={first as Choice}
        itemToString={(c) => c?.label ?? ""}
        onChange={({ selectedItem }) => {
          setFirst(selectedItem ?? null);
          setSecond(null);
          if (selectedItem && !name) setName(selectedItem.field.name);
        }}
      />
      <Dropdown<Choice>
        autoAlign
        size="sm"
        id={`${uid}-merge-b`}
        titleText="With this field"
        label={first ? "Choose a field" : "Choose the first field"}
        disabled={!first}
        items={partners}
        selectedItem={second as Choice}
        itemToString={(c) => c?.label ?? ""}
        onChange={({ selectedItem }) => setSecond(selectedItem ?? null)}
      />
      <TextInput size="sm" id={`${uid}-merge-name`} labelText="Column name" value={name} onChange={(e) => setName(e.target.value)} />
      <Button
        kind="tertiary"
        size="sm"
        renderIcon={Merge}
        disabled={!first || !second || !name.trim()}
        onClick={() => {
          if (!first || !second) return;
          set([...merges, { id: newId(), name: name.trim(), fields: [mergeRef(first.owner.id, first.field.id), mergeRef(second.owner.id, second.field.id)] }]);
          setFirst(null);
          setSecond(null);
          setName("");
        }}
      >
        Merge
      </Button>
    </div>
  );
}
