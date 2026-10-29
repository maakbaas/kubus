/** How long after a rotation iOS may still report the old window height; and how long the viewport must be still before a panned window is put back. */
const SETTLE_MS = 300;

/** What an on-screen keyboard (or iOS's picker for a select) comes up for. */
export const TEXT_FIELD = "input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]):not([type=reset]):not([type=file]):not([type=color]):not([type=image]):not([type=hidden]), textarea, select, [contenteditable]:not([contenteditable=false])";

/** Whether `el` is a field an on-screen keyboard comes up for. */
export function isTextField(el: Element | null | undefined): boolean {
  return !!el && typeof el.matches === "function" && el.matches(TEXT_FIELD);
}

/**
 * Keeps `--keyboard-inset` on <html> at the height an on-screen keyboard covers. iOS doesn't
 * shrink the layout for its keyboard: the fixed workspace stays full height, so the end of a
 * pane (a long markdown field being edited) sits under the keyboard and can't be scrolled into
 * view. Pane content adds this inset at its end (styles.css). Browsers that resize the layout
 * for the keyboard (Android, `interactive-widget` in index.html) leave it at 0.
 *
 * Also re-measured when the window turns or resizes, and again after it settled: iOS reports the
 * new `innerHeight` a moment after the visual viewport's own events, so a measure taken in them
 * could keep the old orientation's inset.
 *
 * And a window iOS left panned is put back at 0,0: the body is fixed and nothing scrolls it on
 * purpose, but iOS pans the visual viewport to show a focused field and may leave it panned after
 * the keyboard went or the phone turned, which draws every fixed layer displaced from where a
 * touch lands. Only once no field has focus, the visual viewport is the whole window again (no
 * keyboard, not zoomed in) and it stayed so for SETTLE_MS: while a keyboard comes up, iOS's pan
 * IS how the field is shown (a field near the bottom: panned by up to the keyboard's height, which
 * leaves nothing of the window covered, and the pan is reported before the smaller height), and a
 * scroll then undoes it, the field ends up under the keyboard and iOS closes the keyboard at once.
 */
export function trackKeyboardInset() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const panned = () => !!(window.scrollX || window.scrollY || viewport.pageTop || viewport.offsetTop);
  // Panned with nothing to show: no field being typed in, the whole window seen.
  const strayPan = () => panned() && !isTextField(document.activeElement) && viewport.height >= window.innerHeight - 1;
  let reset: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    const covered = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
    document.documentElement.style.setProperty("--keyboard-inset", `${covered}px`);
    clearTimeout(reset);
    reset = undefined;
    if (strayPan())
      reset = setTimeout(() => {
        reset = undefined;
        if (strayPan()) window.scrollTo(0, 0);
      }, SETTLE_MS);
  };
  const turned = () => {
    update();
    setTimeout(update, SETTLE_MS);
  };
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  window.addEventListener("resize", turned);
  window.addEventListener("orientationchange", turned);
  // A field left (the keyboard's Done): a pan iOS leaves now has nothing to show.
  document.addEventListener("focusout", () => setTimeout(update, 0));
  update();
}
