import { Checkbox, Dropdown } from "@carbon/react";
import { useStore } from "../app/store";
import { fieldComponentProblem, type ComponentCode } from "../domain/components";
import { isReferenceKind, type Collection, type FieldDraft } from "../domain/model";
import { ChoiceFilterEditor } from "./ChoiceFilterEditor";
import { CollectionLabel } from "./collectionIcons";
import { ComponentChoice, type ComponentRef } from "./ComponentChoice";
import { TOGGLE_CHOICES, TOGGLE_ICONS, ToggleIconLabel } from "./ToggleInput";

/** A collection a reference field can point at (including the one being created). */
export interface Target {
  id: string;
  name: string;
  icon: string | null;
}

/** Whether a field of this kind has settings of its own (shown under its name and type). */
export const hasSettings = (kind: FieldDraft["kind"]) =>
  isReferenceKind(kind) || kind === "component" || kind === "ai" || kind === "checkbox" || kind === "checklist";

/** A new field's type changed: its settings start afresh (a component field with one written here). */
export const newKindPatch = (kind: FieldDraft["kind"]): Partial<FieldDraft> => ({
  kind,
  targetCollectionId: null,
  choiceFilter: [],
  componentId: null,
  code: kind === "component" || kind === "ai" ? "" : null,
  output: kind === "component" ? "markdown" : kind === "ai" ? "string" : null,
  frameRatio: null,
});

/** A component or AI field's component as ComponentChoice edits it. */
export const componentRef = (f: FieldDraft): ComponentRef => ({
  componentId: f.componentId,
  local: f.code === null ? null : { code: f.code, output: f.output ?? (f.kind === "ai" ? "string" : "markdown"), frameRatio: f.frameRatio, ai: f.kind === "ai" },
});

/** A ComponentChoice result as the field's own columns. */
const fromRef = (ref: ComponentRef, local: ComponentCode | null = ref.local): Partial<FieldDraft> => ({
  componentId: local ? null : ref.componentId,
  code: local?.code ?? null,
  output: local?.output ?? null,
  frameRatio: local?.frameRatio ?? null,
});

/** Why a field's settings can't be saved (shown at them once the user tried), or undefined. */
export function settingsProblem(f: FieldDraft, components: Parameters<typeof fieldComponentProblem>[1]): string | undefined {
  if (isReferenceKind(f.kind) && !f.targetCollectionId) return "Choose a collection";
  return fieldComponentProblem(f, components) ?? undefined;
}

/**
 * The settings of one field beyond its name and type, the same in the collection editor (under
 * the field's row) and in the field dialog: the referenced collection and which of its items can
 * be chosen; a checkbox's icon and strike through; a component field's component (written here or
 * shared, asking AI or not). Stacked, one control per line, as a part of the field it belongs to.
 */
export function FieldSettings({
  id,
  field,
  persisted,
  targets,
  problem,
  itemCount,
  collection,
  onChange,
}: {
  id: string;
  field: FieldDraft;
  /** Saved before: its type, target and an AI field's output can't change. */
  persisted: boolean;
  targets: Target[];
  /** What is wrong (shown once the user tried to save). */
  problem?: string;
  /** How many items the collection has (an AI field's prompt is asked for each). */
  itemCount?: number;
  /** The field's collection, once saved (Write with AI reads its fields). */
  collection?: Collection;
  onChange(patch: Partial<FieldDraft>): void;
}) {
  const { collections } = useStore();
  const f = field;
  if (isReferenceKind(f.kind)) {
    const target = collections.find((t) => t.id === f.targetCollectionId);
    return (
      <>
        <Dropdown<Target>
          autoAlign
          size="sm"
          id={`${id}-target`}
          titleText="Refers to"
          label="Choose…"
          items={targets}
          // Carbon accepts null (nothing chosen yet) at runtime; its types only say undefined.
          selectedItem={(targets.find((t) => t.id === f.targetCollectionId) ?? null) as Target}
          disabled={persisted}
          itemToString={(t) => t?.name ?? ""}
          itemToElement={(t) => <CollectionLabel collection={t} />}
          renderSelectedItem={(t) => <CollectionLabel collection={t} />}
          onChange={({ selectedItem: t }) => onChange({ targetCollectionId: t?.id ?? null, choiceFilter: [] })}
          invalid={!!problem}
          invalidText={problem}
        />
        {/* A reference field can limit which items it offers (filters over the target). */}
        {target && <ChoiceFilterEditor target={target} filters={f.choiceFilter} onChange={(choiceFilter) => onChange({ choiceFilter })} />}
      </>
    );
  }
  if (f.kind === "checkbox" || f.kind === "checklist") {
    return (
      <>
        <Dropdown<string>
          autoAlign
          size="sm"
          id={`${id}-toggle-icon`}
          titleText="Icon"
          label="Icon"
          items={TOGGLE_CHOICES}
          selectedItem={f.toggleIcon ?? "checkbox"}
          itemToString={(i) => (i ? (TOGGLE_ICONS[i]?.label ?? "Checkbox") : "")}
          itemToElement={(i) => <ToggleIconLabel id={i} />}
          renderSelectedItem={(i) => <ToggleIconLabel id={i} />}
          onChange={({ selectedItem: i }) => i && onChange({ toggleIcon: i === "checkbox" ? null : i })}
        />
        <Checkbox
          id={`${id}-strike-through`}
          className="field-settings__check"
          labelText={f.kind === "checkbox" ? "Strike through the item when checked" : "Strike through checked entries"}
          checked={f.strikeThrough}
          onChange={(_, { checked }) => onChange({ strikeThrough: checked })}
        />
      </>
    );
  }
  if (f.kind === "component" || f.kind === "ai") {
    const isAi = f.kind === "ai";
    return (
      <>
      <ComponentChoice
        id={id}
        place="field"
        value={componentRef(f)}
        onChange={(ref) => onChange(fromRef(ref))}
        ai={{ value: isAi, locked: persisted, onChange: (on) => onChange({ kind: on ? "ai" : "component" }) }}
        outputLocked={persisted && isAi}
        invalidText={problem}
        suggestedName={f.name.trim() || undefined}
        collection={collection}
      />
      {/* What asking AI costs: a request per item, and the values are stored (made again when the prompt as it reads for an item changes). */}
      {isAi && (
        <p className="helper field-settings__note">
          {`The language model writes each item's value${itemCount !== undefined ? `, for ${itemCount === 1 ? "1 item" : `${itemCount} items`} now` : ""}; it is stored, and made again only when the prompt, as it reads for that item, changes.`}
        </p>
      )}
      </>
    );
  }
  return null;
}
