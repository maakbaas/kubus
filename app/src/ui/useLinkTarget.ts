import { useEffect } from "react";

/** A block on a page of a visible tab (blocks carry `data-block-id`; tabs not shown are `hidden`). */
export function findBlock(id: string): Element | null {
  for (const el of document.querySelectorAll(`[data-block-id="${CSS.escape(id)}"]`)) {
    if (!el.closest("[hidden]")) return el;
  }
  return null;
}

/**
 * Scrolls to what a link pointed at (`?block=`, `?field=`) and flashes it (styles.css, `.link-target`).
 * `find` looks for the element and may come up empty while the page is still loading: it is tried
 * again for a few seconds. Once per `target`; `ready` waits for the page to have its content.
 */
export function useLinkTarget(target: string | null, find: (target: string) => Element | null | undefined, ready = true) {
  useEffect(() => {
    if (!target || !ready) return;
    let tries = 0;
    const show = () => {
      const el = find(target);
      if (!el) return tries++ >= 30;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.remove("link-target");
      void (el as HTMLElement).offsetWidth; // restart the animation
      el.classList.add("link-target");
      window.setTimeout(() => el.classList.remove("link-target"), 2200);
      return true;
    };
    if (show()) return;
    const timer = window.setInterval(() => show() && window.clearInterval(timer), 100);
    return () => window.clearInterval(timer);
    // `find` is read as of the render that changed the target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, ready]);
}
