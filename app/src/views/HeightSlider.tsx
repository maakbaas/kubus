import { Select, SelectItem } from "@carbon/react";
import { SettledSlider } from "./SettledSlider";
import { ASPECT_RATIOS, BLOCK_HEIGHT, type AspectRatio } from "../domain/views";

/** A block's Height setting (chart, map, component): the most it takes, in rem (domain/views.ts). */
export function HeightSlider({ id, value, disabled, onChange }: { id: string; value: number; disabled?: boolean; onChange(height: number): void }) {
  return (
    <SettledSlider
      id={id}
      labelText="Height"
      min={BLOCK_HEIGHT.min}
      max={BLOCK_HEIGHT.max}
      step={BLOCK_HEIGHT.step}
      value={value}
      disabled={disabled}
      formatLabel={(v) => `${v}rem`}
      hideTextInput
      onChange={onChange}
    />
  );
}

/** Under Height and Aspect ratio while the block is in a row side by side (they are set aside there). */
export function InRowNote() {
  return <p className="helper">In a row of blocks side by side it fills the row's height (Row height, above).</p>;
}

/** A block's Aspect ratio beside its Height: it takes the less of the two (blockHeightCss). */
export function AspectSelect({ id, value, disabled, onChange }: { id: string; value: AspectRatio; disabled?: boolean; onChange(aspect: AspectRatio): void }) {
  return (
    <Select size="sm" id={id} labelText="Aspect ratio" helperText="Its height is the less of the two" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as AspectRatio)}>
      {ASPECT_RATIOS.map((a) => (
        <SelectItem key={a} value={a} text={a === "none" ? "None: the height" : a} />
      ))}
    </Select>
  );
}
