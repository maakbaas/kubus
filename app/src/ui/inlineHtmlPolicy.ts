// What HTML drawn inline (in a table cell or a card's field line: ui/InlineHtml.tsx) may keep. It runs nothing and loads
// nothing from another host: no scripts or handlers (DOMPurify drops them), no frames, forms or media elements, and of
// the addresses in it only links, the page's own anchors, stored files (`files/…`) and images written into the address
// (`data:image/…`). Plain functions (no DOM), so they are tested in node.

/** Elements left out on top of DOMPurify's own (it already drops scripts): no forms, frames, media or document parts. */
export const FORBIDDEN_TAGS = [
  "form", "input", "button", "select", "textarea", "option", "optgroup", "datalist", "fieldset", "label",
  "iframe", "frame", "frameset", "object", "embed", "applet", "portal",
  "audio", "video", "source", "track", "picture", "canvas",
  "link", "meta", "base", "title", "noscript", "template", "dialog",
];

/** Attributes whose value is an address. */
export const URL_ATTRIBUTES = new Set(["href", "src", "xlink:href", "srcset", "action", "formaction", "poster", "background", "ping", "cite", "data"]);

/**
 * Whether an address may stay: a link (`href` on `a`) to a page (http, https, mailto) or an anchor in this app (`#…`);
 * for anything loaded (an image's src, an SVG `use`), a stored file, an image in the address, or a reference inside the
 * same HTML (`#id`).
 */
export function allowedUrl(attribute: string, tag: string, value: string): boolean {
  const v = value.trim().toLowerCase();
  if (attribute === "srcset" || attribute === "ping" || attribute === "action" || attribute === "formaction" || attribute === "data") return false;
  if (attribute === "href" && tag === "a") return v.startsWith("#") || v.startsWith("https://") || v.startsWith("http://") || v.startsWith("mailto:");
  return v.startsWith("#") || v.startsWith("files/") || v.startsWith("data:image/");
}

/** CSS without what loads from elsewhere: `@import` rules, and any `url(…)` but a stored file or an image in the address. */
export function cleanCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, "")
    // image-set() and cross-fade() load their plain strings too: not kept.
    .replace(/(-webkit-)?(image-set|cross-fade)\s*\(/gi, "blocked(")
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (whole, _quote: string, address: string) => (allowedUrl("src", "img", address) ? whole : "none"))
    // What escapes could still spell (`u\72l(`): an escaped CSS text is not kept at all.
    .replace(/\\[0-9a-f]{1,6}\s?/gi, "");
}
