import { ComboBox } from "@carbon/react";
import type { FieldDef, ComponentArg } from "../domain/model";

/**
 * What feeds one of a component's variables: pick a field from the list, or type a fixed text or
 * number into the same box instead.
 */
export function ComponentArgInput({
  id,
  param,
  fields,
  value,
  onChange,
}: {
  id: string;
  param: string;
  /** The fields that can feed it. */
  fields: { id: string; name: string }[];
  value: ComponentArg | undefined;
  onChange(arg: ComponentArg | null): void;
}) {
  // A typed value is the combo box's custom selection (a string).
  const initial = value ? ("field" in value ? fields.find((f) => f.id === value.field) ?? null : value.value) : null;
  return (
    <ComboBox<Pick<FieldDef, "id" | "name"> | string>
      autoAlign
      size="sm"
      id={id}
      titleText={<code className="field-row__param">${param}</code>}
      placeholder="A field, or type a value"
      items={fields}
      allowCustomValue
      // Carbon accepts null (nothing chosen) at runtime; its types only say undefined.
      initialSelectedItem={initial as Pick<FieldDef, "id" | "name"> | string}
      itemToString={(f) => (typeof f === "string" ? f : f?.name ?? "")}
      onChange={({ selectedItem: s, inputValue }) => {
        if (s && typeof s !== "string") return onChange({ field: s.id });
        const text = typeof s === "string" ? s : inputValue ?? "";
        onChange(text ? { value: text } : null);
      }}
    />
  );
}
