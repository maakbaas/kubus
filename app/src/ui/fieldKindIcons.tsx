import type { ComponentType } from "react";
import {
  Calendar,
  CheckboxChecked,
  DataReference,
  EventSchedule,
  Image,
  Link,
  ListBulleted,
  ListChecked,
  Markdown,
  StringInteger,
  StringText,
  Code as TemplateIcon,
} from "@carbon/icons-react";
import { fieldKinds } from "../domain/fieldKinds";
import type { FieldDef, FieldKind } from "../domain/model";

type Icon = ComponentType<{ size?: number; "aria-hidden"?: boolean | "true" }>;

/** The icon of each field kind (the domain registry in fieldKinds.ts stays UI-free). */
export const FIELD_KIND_ICONS: Record<FieldKind, Icon> = {
  string: StringText,
  markdown: Markdown,
  number: StringInteger,
  date: Calendar,
  datetime: EventSchedule,
  checkbox: CheckboxChecked,
  image: Image,
  object: Link,
  string_list: ListBulleted,
  checklist: ListChecked,
  object_list: DataReference,
  template: TemplateIcon,
};

function IconLabel({ icon: Icon, children }: { icon: Icon; children: string }) {
  return (
    <span className="icon-label">
      <Icon size={16} aria-hidden="true" />
      {children}
    </span>
  );
}

/** A field's label: its kind's icon and its name (form labels, item page labels). */
export function FieldLabel({ field }: { field: FieldDef }) {
  return <IconLabel icon={FIELD_KIND_ICONS[field.kind]}>{field.name}</IconLabel>;
}

/** A field kind with its icon, e.g. in the object editor's type dropdown. */
export function FieldKindLabel({ kind }: { kind: FieldKind }) {
  return <IconLabel icon={FIELD_KIND_ICONS[kind]}>{fieldKinds[kind].label}</IconLabel>;
}
