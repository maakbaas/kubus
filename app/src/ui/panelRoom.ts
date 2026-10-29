/**
 * Room for floating panels (toolbar popovers, the icon picker) when an on-screen keyboard comes
 * and goes. Android resizes the window for its keyboard (`interactive-widget` in index.html); iOS
 * doesn't: only the visual viewport shrinks (and may pan), so a panel sized to the window would
 * run on under the keyboard, and the field being typed in sit behind it.
 */
import { isTextField } from "../platform/keyboardInset";

/** The part of the window that can be seen (not under an on-screen keyboard), in layout coordinates. */
export function visibleArea(): { top: number; bottom: number } {
  const vv = window.visualViewport;
  return vv ? { top: vv.offsetTop, bottom: Math.min(vv.offsetTop + vv.height, window.innerHeight) } : { top: 0, bottom: window.innerHeight };
}

/** Less than this beside its button (padding, a field, padding) and a panel being typed in may still change sides. */
const MIN_SIDE = 64;

export type PanelSide = "below" | "above";

/** Which side of its button a panel is on. */
export function sideOf(button: DOMRect, panel: DOMRect): PanelSide {
  return panel.top >= button.top ? "below" : "above";
}

/**
 * The height a panel hanging from `button` may take: the room on the roomier side (autoAlign flips
 * it there), within what can be seen. While a field in it is being typed in, `keep` is the side it
 * was on when that began: the room there, so the keyboard coming up doesn't flip it to the other
 * side of its button, which moved the field from under the finger (and on iOS made the keyboard
 * close at once).
 */
export function panelRoom(button: DOMRect, keep: PanelSide | null, margin = 16): number {
  const { top, bottom } = visibleArea();
  const above = button.top - top - margin;
  const below = bottom - button.bottom - margin;
  const kept = keep === "below" ? below : keep === "above" ? above : -1;
  return kept >= MIN_SIDE ? kept : Math.max(above, below);
}

/** Whether a text field inside `el` has focus (an on-screen keyboard may be up for it). */
export function typingIn(el: Element | null | undefined): boolean {
  const focus = document.activeElement;
  return !!el && !!focus && el.contains(focus) && isTextField(focus);
}

/**
 * Keeps the focused field of a scrolling panel in sight after the panel shrank (the keyboard came
 * up): within the panel and within what can be seen of it (a panel above a button the keyboard
 * covers runs on under the keyboard: Floating UI hangs it from the button). Scrolls the panel
 * only, never the page behind it: on iOS a scrolled window undoes the pan that shows the field.
 */
export function keepFocusInView(scroller: HTMLElement | null | undefined) {
  if (!scroller || !typingIn(scroller)) return;
  const field = document.activeElement as HTMLElement;
  const s = scroller.getBoundingClientRect();
  const seen = visibleArea();
  const top = Math.max(s.top, seen.top);
  const bottom = Math.min(s.bottom, seen.bottom);
  const f = field.getBoundingClientRect();
  if (f.bottom > bottom) scroller.scrollTop += Math.min(f.bottom - bottom, f.top - top);
  else if (f.top < top) scroller.scrollTop -= top - f.top;
}

/**
 * Calls `update` whenever the window or its visible part (an on-screen keyboard) changes size;
 * returns the clean-up. Before Floating UI's own resize handler (capture runs first at the
 * window), so a panel shrunk there synchronously (`setRoom`) is placed with its new height: placed
 * with the old one, it would flip to the other side of its button for a frame and stay there.
 */
export function onViewportChange(update: () => void): () => void {
  const vv = window.visualViewport;
  window.addEventListener("resize", update, true);
  vv?.addEventListener("resize", update);
  vv?.addEventListener("scroll", update);
  return () => {
    window.removeEventListener("resize", update, true);
    vv?.removeEventListener("resize", update);
    vv?.removeEventListener("scroll", update);
  };
}

/** Sets a panel's room at once (`--popover-room`, styles.css), ahead of the render that sets it from state. */
export function setRoom(panel: HTMLElement | null | undefined, room: number) {
  panel?.style.setProperty("--popover-room", `${Math.max(room, 0)}px`);
}
