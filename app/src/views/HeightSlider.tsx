import { Slider } from "@carbon/react";
import { BLOCK_HEIGHT } from "../domain/views";

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
