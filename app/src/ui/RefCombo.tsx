import { useRef } from "react";
import { ComboBox } from "@carbon/react";
import type { FieldDef } from "../domain/model";
import { choicesFor, type RefOption } from "./useReferenceOptions";

/**
 * One item of a reference field, chosen from a ComboBox. Its menu is placed by Carbon (autoAlign):
 * below the box, or above it where the window has no room below (it never extends the page).
 */
export function RefCombo({
  id,
  field,
  label,
  options,
  chosen,
  value,
  placeholder,
  onChange,
  onLeave,
}: {
  id: string;
  field: FieldDef;
  label: string;
  options: RefOption[];
  /** Ids chosen elsewhere in the field, kept offered even when its choice filter drops them. */
  chosen: string[];
  value: string;
  placeholder?: string;
  onChange(id: string): void;
  /** Focus moved out of the ComboBox (and its menu). */
  onLeave?(): void;
}) {
  const box = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={box}
      className="ref-combo"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onLeave?.();
      }}
    >
      <ComboBox<RefOption>
        autoAlign
        size="sm"
        id={id}
        aria-label={label}
        placeholder={placeholder}
        items={choicesFor(field, options, chosen)}
        itemToString={(o) => o?.label ?? ""}
        selectedItem={options.find((o) => o.id === value) ?? null}
        onChange={({ selectedItem }) => onChange(selectedItem?.id ?? "")}
      />
    </div>
  );
}
