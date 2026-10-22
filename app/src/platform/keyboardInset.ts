/**
 * Keeps `--keyboard-inset` on <html> at the height an on-screen keyboard covers. iOS doesn't
 * shrink the layout for its keyboard: the fixed workspace stays full height, so the end of a
 * pane (a long markdown field being edited) sits under the keyboard and can't be scrolled into
 * view. Pane content adds this inset at its end (styles.css). Browsers that resize the layout
 * for the keyboard (Android, `interactive-widget` in index.html) leave it at 0.
 */
export function trackKeyboardInset() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const update = () => {
    const covered = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
    document.documentElement.style.setProperty("--keyboard-inset", `${covered}px`);
  };
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  update();
}
