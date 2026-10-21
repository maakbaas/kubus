import type { ComponentType } from "react";
import { Button, Checkbox } from "@carbon/react";
import {
  Bookmark,
  BookmarkFilled,
  CheckboxCheckedFilled,
  CheckmarkFilled,
  CheckmarkOutline,
  FaceDissatisfied,
  FaceDissatisfiedFilled,
  FaceNeutral,
  FaceNeutralFilled,
  FaceSatisfied,
  FaceSatisfiedFilled,
  FaceWink,
  FaceWinkFilled,
  Favorite,
  FavoriteFilled,
  Flag,
  FlagFilled,
  Star,
  StarFilled,
  ThumbsUp,
  ThumbsUpFilled,
} from "@carbon/icons-react";

type CarbonIcon = ComponentType<{ size?: number | string }>;

/** What a checkbox / checklist can show instead of a box: an outline icon (off) and a filled one (on). */
export const TOGGLE_ICONS: Record<string, { label: string; off: CarbonIcon; on: CarbonIcon }> = {
  heart: { label: "Heart", off: Favorite, on: FavoriteFilled },
  star: { label: "Star", off: Star, on: StarFilled },
  flag: { label: "Flag", off: Flag, on: FlagFilled },
  bookmark: { label: "Bookmark", off: Bookmark, on: BookmarkFilled },
  checkmark: { label: "Checkmark", off: CheckmarkOutline, on: CheckmarkFilled },
  thumbsUp: { label: "Thumbs up", off: ThumbsUp, on: ThumbsUpFilled },
  happy: { label: "Happy face", off: FaceSatisfied, on: FaceSatisfiedFilled },
  neutral: { label: "Neutral face", off: FaceNeutral, on: FaceNeutralFilled },
  sad: { label: "Sad face", off: FaceDissatisfied, on: FaceDissatisfiedFilled },
  wink: { label: "Winking face", off: FaceWink, on: FaceWinkFilled },
};

/** The choices of a field's icon: the ordinary box (stored as null), then the icons. */
export const TOGGLE_CHOICES: string[] = ["checkbox", ...Object.keys(TOGGLE_ICONS)];

/** An icon choice with its name, for dropdowns. */
export function ToggleIconLabel({ id }: { id: string }) {
  const def = TOGGLE_ICONS[id];
  const On = def?.on ?? CheckboxCheckedFilled;
  return (
    <span className="toggle-icon-label">
      <On size={16} />
      {def?.label ?? "Checkbox"}
    </span>
  );
}

/**
 * The control of a Checkbox field or a checklist item: Carbon's checkbox, or (field.toggleIcon) a
 * toggle button showing the icon outlined when off and filled when on. Same 2rem footprint, and the
 * icon sits where the box would, so layouts need not know which one they hold.
 */
export function ToggleInput({
  icon,
  id,
  label,
  checked,
  onChange,
}: {
  icon: string | null;
  id: string;
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  const def = icon ? TOGGLE_ICONS[icon] : undefined;
  if (!def) return <Checkbox id={id} labelText={label} hideLabel checked={checked} onChange={(_, { checked: c }) => onChange(c)} />;
  const Icon = checked ? def.on : def.off;
  return (
    // A plain icon Button, not an IconButton: the icon needs no tooltip (its state is its look).
    <Button
      className={`toggle-input${checked ? " toggle-input--on" : ""}`}
      id={id}
      kind="ghost"
      size="sm"
      renderIcon={Icon}
      iconDescription={label}
      aria-label={label}
      role="checkbox"
      aria-checked={checked}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
    />
  );
}
