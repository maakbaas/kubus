import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Slider } from "@carbon/react";

/** After a keyboard change, how long the value rests before it is stored. */
const SETTLE_MS = 400;
/** A value shown but not (yet) given back by the store is let go after this long. */
const SHOWN_MAX_MS = 3000;

type Props = Omit<ComponentProps<typeof Slider>, "value" | "onChange" | "onRelease"> & {
  value: number;
  /** The value to store: once the thumb is let go, or a moment after the last key. */
  onChange(value: number): void;
};

/**
 * Carbon's Slider for a setting that is stored (a block's Height, Width, Card width). While it is dragged it shows its own
 * value and stores nothing; the value is stored once when it is let go (or SETTLE_MS after a key). Storing every step made
 * a write and a reload each: a reload of an earlier step reset the slider (Carbon takes a changed `value` as its own and
 * reports it as a change), which stored that step again: the block flickered between values, the page could hang.
 */
export function SettledSlider({ value, onChange, ...props }: Props) {
  // The value shown while it differs from the stored one (being dragged, or stored and not back yet).
  const [shown, setShown] = useState<number | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef(onChange);
  latest.current = onChange;
  const store = (v: number) => {
    window.clearTimeout(timer.current);
    if (v !== value) latest.current(v);
    // Shown until the store gives it back, at most SHOWN_MAX_MS (a value the setting changes, e.g. one out of range).
    timer.current = window.setTimeout(() => setShown(null), SHOWN_MAX_MS);
  };
  useEffect(() => {
    if (shown !== null && value === shown) setShown(null);
  }, [value, shown]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <Slider
      {...props}
      value={shown ?? value}
      onChange={({ value: v }) => {
        if (v === (shown ?? value)) return;
        setShown(v);
        // A key (no release follows): stored once the keys rest; a drag's release stores it at once.
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => store(v), SETTLE_MS);
      }}
      onRelease={({ value: v }) => store(v)}
    />
  );
}
