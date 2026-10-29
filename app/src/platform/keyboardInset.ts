/** How long after a rotation iOS may still report the old window height. */
const SETTLE_MS = 300;

/**
 * Keeps `--keyboard-inset` on <html> at the height an on-screen keyboard covers. iOS doesn't
 * shrink the layout for its keyboard: the fixed workspace stays full height, so the end of a
 * pane (a long markdown field being edited) sits under the keyboard and can't be scrolled into
 * view. Pane content adds this inset at its end (styles.css). Browsers that resize the layout
 * for the keyboard (Android, `interactive-widget` in index.html) leave it at 0.
 *
 * Also re-measured when the window turns or resizes, and again after it settled: iOS reports the
 * new `innerHeight` a moment after the visual viewport's own events, so a measure taken in them
 * could keep the old orientation's inset. And with no keyboard up the window is put back at 0,0:
 * the body is fixed and nothing scrolls it on purpose, but iOS pans the layout viewport to show a
 * focused field and may leave it panned after the keyboard went or the phone turned, which draws
 * every fixed layer displaced from where a touch lands.
 */
export function trackKeyboardInset() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const update = () => {
    const covered = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
    document.documentElement.style.setProperty("--keyboard-inset", `${covered}px`);
    if (covered === 0 && (window.scrollX || window.scrollY || viewport.pageTop)) window.scrollTo(0, 0);
  };
  const turned = () => {
    update();
    setTimeout(update, SETTLE_MS);
  };
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  window.addEventListener("resize", turned);
  window.addEventListener("orientationchange", turned);
  update();
}
