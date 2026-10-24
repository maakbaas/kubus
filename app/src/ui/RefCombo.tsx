import { useRef, useState } from "react";
import { ComboBox } from "@carbon/react";
import type { FieldDef } from "../domain/model";
import { choicesFor, type RefOption } from "./useReferenceOptions";

/** Room a menu of a few items needs below the box (rem), else it opens upwards. */
const MENU_ROOM_REM = 15;

/**
 * One item of a reference field, chosen from a ComboBox. Its menu opens downwards unless the
 * window has no room below it: there it would extend the page (a second scrollbar), so it opens
 * upwards instead.
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
  const [direction, setDirection] = useState<"top" | "bottom">("bottom");
  return (
    <div
      ref={box}
      className="ref-combo"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onLeave?.();
      }}
    >
      <ComboBox<RefOption>
        size="sm"
        id={id}
        aria-label={label}
        placeholder={placeholder}
        direction={direction}
        items={choicesFor(field, options, chosen)}
        itemToString={(o) => o?.label ?? ""}
        selectedItem={options.find((o) => o.id === value) ?? null}
        onChange={({ selectedItem }) => onChange(selectedItem?.id ?? "")}
        onToggle={(open) => {
          if (!open || !box.current) return;
          const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
          const room = window.innerHeight - box.current.getBoundingClientRect().bottom;
          setDirection(room < MENU_ROOM_REM * rem ? "top" : "bottom");
        }}
      />
    </div>
  );
}
