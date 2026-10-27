import { refractor } from "refractor";
import type { ElementContent } from "hast";

/** Code coloured by refractor (prism's tokens, styles.css), as hast; plain text for a language it doesn't know. */
export const highlightCode = (text: string, language: string): ElementContent[] =>
  refractor.registered(language) ? (refractor.highlight(text, language).children as ElementContent[]) : [{ type: "text", value: text }];

/** The fence language of a component's code in Markdown (the Help page's examples): coloured like the component editor. */
export const COMPONENT_LANGUAGE = "component";

/**
 * A component, coloured: the text around the {{ }} sections as Markdown (or HTML, for HTML
 * output), the sections as JavaScript, the braces as punctuation.
 */
export function highlightComponent(code: string, textLanguage = "markdown"): ElementContent[] {
  const punctuation = (value: string): ElementContent => ({ type: "element", tagName: "span", properties: { className: ["token", "punctuation"] }, children: [{ type: "text", value }] });
  const parts: ElementContent[] = [];
  let at = 0;
  for (const m of code.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    const i = m.index ?? 0;
    parts.push(...highlightCode(code.slice(at, i), textLanguage));
    parts.push({
      type: "element",
      tagName: "span",
      properties: { className: ["code-editor__section"] },
      children: [punctuation("{{"), ...highlightCode(m[1], "javascript"), punctuation("}}")],
    });
    at = i + m[0].length;
  }
  parts.push(...highlightCode(code.slice(at), textLanguage));
  return parts;
}
