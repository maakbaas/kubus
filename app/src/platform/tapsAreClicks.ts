/** How soon after a touch a mouse event is the one the browser made for that touch (iOS sends them right after it). */
const SAME_TAP_MS = 800;

/** The mouse-hover events a browser makes up for a tap. */
export const HOVER_EVENTS = ["mouseover", "mouseout", "mouseenter", "mouseleave", "mousemove"] as const;

/**
 * A tap is always a click: the hover events a touch screen makes up for a tap (iOS sends mouseover, mouseenter and
 * mousemove before the click) reach nothing in the app. iOS takes a tap as only a hover when that hover shows something
 * new (a Carbon icon button's tooltip opens on mouseenter, the editor's link popover on mouseover): the button or field
 * then needed a second tap, at times and not at others. Stopped at the window, before React and Carbon see them, for
 * SAME_TAP_MS after a touch; a mouse or trackpad (an iPad's too) still hovers as ever. CSS `:hover` reveals are off on
 * touch screens already (styles.css, `@media (hover: none)`).
 */
export function tapsAreClicks(target: Pick<Window, "addEventListener"> = window, now: () => number = () => performance.now()) {
  let touchedAt = -Infinity;
  const touched = () => {
    touchedAt = now();
  };
  target.addEventListener("touchstart", touched, { capture: true, passive: true });
  target.addEventListener("touchend", touched, { capture: true, passive: true });
  const hover = (e: Event) => {
    if (now() - touchedAt < SAME_TAP_MS) e.stopImmediatePropagation();
  };
  for (const type of HOVER_EVENTS) target.addEventListener(type, hover, true);
}
