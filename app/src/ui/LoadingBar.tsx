import { useEffect, useRef, useState } from "react";
import { IconButton, ProgressBar } from "@carbon/react";
import { Close } from "@carbon/icons-react";

/** How long one request (a page of rows) is expected to take: the bar fills its share in about this time. */
export const REQUEST_MS = 3000;
/** How often the bar moves while a request is out (Carbon's bar eases each step). */
const TICK_MS = 100;

/**
 * How much of a request's share of the bar is shown `ms` after it was sent: quickly at first, about
 * 90% after REQUEST_MS, then ever slower towards 97%, never full (only its answer fills it).
 */
export const requestShare = (ms: number) => 0.97 * (1 - Math.exp(-ms / (REQUEST_MS / 2.7)));

/**
 * The one progress bar of the app (rows loading into a block), with a small "×" icon button at its
 * right to stop it: a 32px icon button at the row's right edge, so it lines up with the buttons of
 * the heading above (a block's menus). Without `onStop` (what can't be stopped) there is no button.
 *
 * It moves while a request is out, not only when its rows come in: the request on its way fills its
 * share of the bar (the next `step` rows of `max`; the whole bar while the total isn't known) over
 * about REQUEST_MS, slowing towards its end (`requestShare`), so a block whose rows come in one
 * answer doesn't show an empty bar until it is done. It never moves back: once the total is known,
 * the rest is measured from where it got to.
 */
export function LoadingBar({
  label,
  value,
  max,
  step,
  onStop,
}: {
  label: string;
  /** Without a value the total isn't known yet: the first request fills the bar. */
  value?: number;
  max?: number;
  /** The rows one request brings (a page): the share of the bar the request on its way fills. */
  step?: number;
  onStop?(): void;
}) {
  const known = value != null && max != null && max > 0;
  const real = known ? Math.min(value / max, 1) : 0;
  const share = known ? Math.max(0, Math.min(step ?? max, max - value)) / max : 1;
  // When the request now on its way was sent: when what's in last changed.
  const at = known ? `${value}/${max}` : "";
  const sent = useRef({ at, time: Date.now() });
  if (sent.current.at !== at) sent.current = { at, time: Date.now() };
  // Where the bar was when the total came in (the rest of it is measured from there), and where it is.
  const from = useRef<{ known: boolean; base: number }>({ known, base: 0 });
  const shown = useRef(0);
  if (from.current.known !== known) {
    // Known: the rest from here. Unknown again: a new request (another query) starts the bar anew.
    from.current = { known, base: known ? shown.current : 0 };
    if (!known) shown.current = 0;
  }

  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const target = Math.min(1, real + share * requestShare(Date.now() - sent.current.time));
  const { base } = from.current;
  shown.current = Math.max(shown.current, base + (1 - base) * target);
  return (
    <div className="loading-bar">
      <ProgressBar className="loading-bar__bar" size="small" type="inline" label={label} value={shown.current * 100} max={100} />
      {onStop && (
        <IconButton autoAlign kind="ghost" size="sm" align="top-end" label="Stop loading" onClick={onStop}>
          <Close />
        </IconButton>
      )}
    </div>
  );
}
