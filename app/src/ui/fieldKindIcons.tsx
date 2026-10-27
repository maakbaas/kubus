import { useContext, type ComponentType, type MouseEvent } from "react";
import {
  AiGenerate,
  Calendar,
  CheckboxChecked,
  DataReference,
  EventSchedule,
  Html,
  Image,
  Link,
  ListBulleted,
  ListChecked,
  Markdown,
  StringInteger,
  StringText,
  Code as ComponentIcon,
} from "@carbon/icons-react";
import { fieldKinds } from "../domain/fieldKinds";
import type { FieldDef, FieldKind } from "../domain/model";
import { CollapseCaret, FieldCollapse } from "./SectionHeader";

type Icon = ComponentType<{ size?: number; "aria-hidden"?: boolean | "true" }>;

/** The icon of each field kind (the domain registry in fieldKinds.ts stays UI-free). */
export const FIELD_KIND_ICONS: Record<FieldKind, Icon> = {
  string: StringText,
  markdown: Markdown,
  html: Html,
  number: StringInteger,
  date: Calendar,
  datetime: EventSchedule,
  checkbox: CheckboxChecked,
  image: Image,
  item: Link,
  string_list: ListBulleted,
  checklist: ListChecked,
  item_list: DataReference,
  component: ComponentIcon,
  ai: AiGenerate,
};

function IconLabel({ icon: Icon, children, onClick }: { icon: Icon; children: string; onClick?(e: MouseEvent): void }) {
  return (
    <span className={onClick ? "icon-label section-header__toggle" : "icon-label"} onClick={onClick}>
      <Icon size={16} aria-hidden="true" />
      {/* A long name is cut with "…": its whole text on hover. */}
      <span className="icon-label__text" title={children}>
        {children}
      </span>
    </span>
  );
}

/** A field's label: its kind's icon and its name (form labels, item page labels), after a collapse caret on item pages. */
export function FieldLabel({ field }: { field: FieldDef }) {
  const collapse = useContext(FieldCollapse);
  // An AI field edited as text (see editableField) keeps its own icon: only AI fields have an output.
  // The name toggles too, like a block's (the caret is its keyboard control); inside an editor's
  // <label> the click doesn't also focus the input.
  const toggle = collapse
    ? (e: MouseEvent) => {
        e.preventDefault();
        collapse.onToggle();
      }
    : undefined;
  const label = (
    <IconLabel icon={FIELD_KIND_ICONS[field.aiOutput ? "ai" : field.kind]} onClick={toggle}>
      {field.name}
    </IconLabel>
  );
  return collapse ? (
    <>
      <CollapseCaret {...collapse} />
      {label}
    </>
  ) : (
    label
  );
}

/** A field kind with its icon, e.g. in the collection editor's field type dropdown. */
export function FieldKindLabel({ kind }: { kind: FieldKind }) {
  return <IconLabel icon={FIELD_KIND_ICONS[kind]}>{fieldKinds[kind].label}</IconLabel>;
}
