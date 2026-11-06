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
  // Set once: given with every call, DOMPurify worked the whole configuration out again each time (every cell).
  p.setConfig({
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    FORBID_TAGS: FORBIDDEN_TAGS,
    ALLOW_DATA_ATTR: false,
    // A leading <style> kept (it would be taken for the document's head and dropped).
    FORCE_BODY: true,
  });
  return (purifier = p);
}

/** Recent results by their HTML: a table's cells are drawn again with the same HTML (another view, a group opened). */
const sanitized = new Map<string, string>();
const KEPT = 500;

/** The HTML made safe to draw in the page: ui/inlineHtmlPolicy.ts. */
export function sanitizeInline(html: string): string {
  const known = sanitized.get(html);
  if (known !== undefined) return known;
  const safe = purify().sanitize(html);
  if (sanitized.size >= KEPT) sanitized.delete(sanitized.keys().next().value!);
  sanitized.set(html, safe);
  return safe;
}

/**
 * Its box: the cell's font and colour; what doesn't fit the cell is cut off. A link in it that has focus marks the box
 * (Carbon's focus ring, inside: the box clips), as the page sees focus on the box, not in its shadow root.
 */
const HOST_CSS = `:host{display:block;min-inline-size:0;overflow:hidden;font:inherit;color:inherit;overflow-wrap:anywhere}:host(:focus-within){outline:2px solid var(--cds-focus);outline-offset:-2px}:focus{outline:none}img,svg{max-inline-size:100%}`;

/**
 * That style as one sheet every cell's shadow root adopts: as a <style> in each, every cell parsed and set up a sheet of
 * its own (a table's column of HTML: a hundred). Null where sheets can't be shared (older browsers): then the <style>.
 */
let hostSheet: CSSStyleSheet | null | undefined;
function sharedHostSheet(): CSSStyleSheet | null {
  if (hostSheet !== undefined) return hostSheet;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(HOST_CSS);
    hostSheet = "adoptedStyleSheets" in ShadowRoot.prototype ? sheet : null;
  } catch {
    hostSheet = null;
  }
  return hostSheet;
}

export function InlineHtml({ html }: { html: string }) {
  const host = useRef<HTMLSpanElement>(null);
  // Stored files (`files/…`) as images in the address, as the frame has them.
  const resolved = useEmbeddedFiles(html);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el || resolved === undefined) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: "open" });
    const sheet = sharedHostSheet();
    if (sheet) {
      if (root.adoptedStyleSheets[0] !== sheet) root.adoptedStyleSheets = [sheet];
      root.innerHTML = sanitizeInline(resolved);
    } else root.innerHTML = `<style>${HOST_CSS}</style>` + sanitizeInline(resolved);
  }, [resolved]);
  return <span ref={host} className="inline-html" />;
}
