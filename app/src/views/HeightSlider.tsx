import { Select, SelectItem, Slider } from "@carbon/react";
import { ASPECT_RATIOS, BLOCK_HEIGHT, type AspectRatio } from "../domain/views";

/** A block's Height setting (chart, map, component): the most it takes, in rem (domain/views.ts). */
export function HeightSlider({ id, value, disabled, onChange }: { id: string; value: number; disabled?: boolean; onChange(height: number): void }) {
  return (
    <Slider
      id={id}
      labelText="Height"
      min={BLOCK_HEIGHT.min}
      max={BLOCK_HEIGHT.max}
      step={BLOCK_HEIGHT.step}
      value={value}
      disabled={disabled}
      formatLabel={(v) => `${v}rem`}
      hideTextInput
      onChange={({ value }) => onChange(value)}
    />
  );
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
