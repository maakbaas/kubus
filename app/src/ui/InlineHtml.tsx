import { useLayoutEffect, useRef } from "react";
import DOMPurify from "dompurify";
import { allowedUrl, cleanCss, FORBIDDEN_TAGS, URL_ATTRIBUTES } from "./inlineHtmlPolicy";
import { useEmbeddedFiles } from "./ComponentValue";

// HTML in a table cell or a card's field line: drawn in the page itself, without scripts (one frame per cell would be a
// document each). What is kept is ui/inlineHtmlPolicy.ts. It sits in a shadow root: its <style> stays inside it, and
// the page's theme (`var(--cds-…)`, inherited custom properties) and font reach it. On an item page, in a component
// block and as a card's cover the same HTML is the sandboxed frame (HtmlFrame), its scripts run.

/** Its own DOMPurify with the policy's hooks, made on first use (not when loaded: tests and the worker have no window). */
let purifier: ReturnType<typeof DOMPurify> | null = null;
function purify() {
  if (purifier) return purifier;
  const p = DOMPurify(window);
  p.addHook("uponSanitizeAttribute", (node, data) => {
    const name = data.attrName.toLowerCase();
    if (name === "style") data.attrValue = cleanCss(data.attrValue);
    else if (URL_ATTRIBUTES.has(name) && !allowedUrl(name, node.nodeName.toLowerCase(), data.attrValue)) data.keepAttr = false;
  });
  p.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style") node.textContent = cleanCss(node.textContent ?? "");
  });
  p.addHook("afterSanitizeAttributes", (node) => {
    // A link to a page opens it in a new tab (or the system's browser), never in place of the app.
    if (node.nodeName.toLowerCase() === "a" && /^(https?|mailto):/i.test(node.getAttribute("href") ?? "")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  return (purifier = p);
}

/** The HTML made safe to draw in the page: ui/inlineHtmlPolicy.ts. */
export function sanitizeInline(html: string): string {
  return purify().sanitize(html, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    FORBID_TAGS: FORBIDDEN_TAGS,
    ALLOW_DATA_ATTR: false,
    // A leading <style> kept (it would be taken for the document's head and dropped).
    FORCE_BODY: true,
  });
}

/**
 * Its box: the cell's font and colour; what doesn't fit the cell is cut off. A link in it that has focus marks the box
 * (Carbon's focus ring, inside: the box clips), as the page sees focus on the box, not in its shadow root.
 */
const HOST_STYLE = `<style>:host{display:block;min-inline-size:0;overflow:hidden;font:inherit;color:inherit;overflow-wrap:anywhere}:host(:focus-within){outline:2px solid var(--cds-focus);outline-offset:-2px}:focus{outline:none}img,svg{max-inline-size:100%}</style>`;

export function InlineHtml({ html }: { html: string }) {
  const host = useRef<HTMLSpanElement>(null);
  // Stored files (`files/…`) as images in the address, as the frame has them.
  const resolved = useEmbeddedFiles(html);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el || resolved === undefined) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: "open" });
    root.innerHTML = HOST_STYLE + sanitizeInline(resolved);
  }, [resolved]);
  return <span ref={host} className="inline-html" />;
}
