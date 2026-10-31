import { useEffect } from "react";

/** What the user does to scroll or move on themselves: the page is no longer kept on the target after it. */
const USER_SCROLLS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/** A block on a page of a visible tab (blocks carry `data-block-id`; tabs not shown are `hidden`). */
export function findBlock(id: string): Element | null {
  for (const el of document.querySelectorAll(`[data-block-id="${CSS.escape(id)}"]`)) {
    if (!el.closest("[hidden]")) return el;
  }
  return null;
}

/** Where an element is in its page's content, whatever is scrolled: its top plus the scroll of every ancestor
 * (the window's is `<html>`'s). */
function contentTop(el: Element): number | undefined {
  if (typeof el.getBoundingClientRect !== "function") return undefined;
  let top = el.getBoundingClientRect().top;
  for (let p = el.parentElement; p; p = p.parentElement) top += p.scrollTop;
  return top;
}

/**
 * Scrolls to what a link pointed at (`?block=`, `?field=`) and flashes it (styles.css, `.link-target`).
 * `find` looks for the element and may come up empty while the page is still loading: it is tried
 * again for a few seconds. Once per `target`; `ready` waits for the page to have its content.
 * Blocks above the target may still be filling in when it is found (their items, a chart, a map), which
 * pushes it out of sight again: for a few seconds after, it is scrolled to again whenever it has moved in
 * the page, until the user scrolls, types or taps themselves.
 */
export function useLinkTarget(target: string | null, find: (target: string) => Element | null | undefined, ready = true) {
  useEffect(() => {
    if (!target || !ready) return;
    let tries = 0;
    let settle: number | undefined;
    const stopSettling = () => {
      if (settle === undefined) return;
      window.clearInterval(settle);
      settle = undefined;
      for (const e of USER_SCROLLS) window.removeEventListener(e, stopSettling, true);
    };
    const keepInView = (el: Element) => {
      let last = contentTop(el);
      if (last === undefined) return;
      let ticks = 0;
      for (const e of USER_SCROLLS) window.addEventListener(e, stopSettling, { capture: true, passive: true });
      settle = window.setInterval(() => {
        const now = el.isConnected ? contentTop(el) : undefined;
        if (now === undefined || ticks++ >= 30) return stopSettling();
        if (Math.abs(now - last!) > 1) el.scrollIntoView({ block: "center", behavior: "smooth" });
        last = now;
      }, 100);
    };
    const show = () => {
      const el = find(target);
      if (!el) return tries++ >= 30;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      keepInView(el);
      el.classList.remove("link-target");
      void (el as HTMLElement).offsetWidth; // restart the animation
      el.classList.add("link-target");
      window.setTimeout(() => el.classList.remove("link-target"), 2200);
      return true;
    };
    if (show()) return stopSettling;
    const timer = window.setInterval(() => show() && window.clearInterval(timer), 100);
    return () => {
      window.clearInterval(timer);
      stopSettling();
    };
    // `find` is read as of the render that changed the target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, ready]);
}
