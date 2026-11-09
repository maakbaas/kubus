/** How long the keyboard is held for an editor that doesn't take it (a failed load): then let go. */
const HOLD_MS = 5000;

let held: { input: HTMLInputElement; timer: ReturnType<typeof setTimeout> } | null = null;

/**
 * Brings up the on-screen keyboard now, in the tap that starts editing, for an editor that only takes focus once it has
 * loaded (the Markdown editor: loaded on use, made asynchronously). iOS shows its keyboard only for a focus during the
 * tap itself: the editor's own focus came too late, so it opened without one and needed a second tap. An invisible text
 * input at the tap is focused now; the editor's focus later moves the keyboard to it (`letGoOfKeyboard`). Touch screens
 * only: a mouse needs no keyboard.
 */
export function holdKeyboard(at?: { clientX: number; clientY: number }) {
  if (typeof window === "undefined" || !window.matchMedia?.("(hover: none) and (pointer: coarse)").matches) return;
  letGoOfKeyboard();
  const input = document.createElement("input");
  input.setAttribute("aria-hidden", "true");
  input.tabIndex = -1;
  // At the tap (iOS scrolls a focused field into view: there it already is), unseen; 16px, or iOS zooms in on it.
  Object.assign(input.style, {
    position: "fixed",
    left: `${at?.clientX ?? 0}px`,
    top: `${at?.clientY ?? 0}px`,
    width: "1px",
    height: "1px",
    opacity: "0",
    fontSize: "16px",
    border: "0",
    padding: "0",
    pointerEvents: "none",
  });
  document.body.append(input);
  input.focus({ preventScroll: true });
  held = { input, timer: setTimeout(letGoOfKeyboard, HOLD_MS) };
}

/** The editor has focus (or won't take it): the held keyboard's input goes. */
export function letGoOfKeyboard() {
  if (!held) return;
  clearTimeout(held.timer);
  held.input.remove();
  held = null;
}
