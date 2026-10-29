// @vitest-environment node
import type { ElementContent } from "hast";
import { describe, expect, it } from "vitest";
import { highlightCode, highlightComponent } from "./codeHighlight";

/** The text a highlighted tree spells out. */
const textOf = (nodes: ElementContent[]): string =>
  nodes.map((n) => (n.type === "text" ? n.value : n.type === "element" ? textOf(n.children) : "")).join("");
const classesOf = (nodes: ElementContent[]): string[] =>
  nodes.flatMap((n) => (n.type === "element" ? [...((n.properties?.className as string[] | undefined) ?? []), ...classesOf(n.children)] : []));

describe("highlightCode", () => {
  it("colours the tokens of a known language and loses no text", () => {
    const out = highlightCode("const a = 1;", "javascript");
    expect(textOf(out)).toBe("const a = 1;");
    expect(classesOf(out)).toContain("keyword");
    expect(classesOf(out)).toContain("number");
  });

  it("gives plain text for a language it doesn't know", () => {
    expect(highlightCode("a {{ b }}", "no-such-language")).toEqual([{ type: "text", value: "a {{ b }}" }]);
  });
});

describe("highlightComponent", () => {
  it("colours the sections as JavaScript between braces, the text around them as Markdown", () => {
    const code = "# Title\n{{ $item.Name }} and {{ 1 + 2 }}";
    const out = highlightComponent(code);
    expect(textOf(out)).toBe(code);
    const sections = out.filter((n) => n.type === "element" && (n.properties?.className as string[]).includes("code-editor__section"));
    expect(sections).toHaveLength(2);
    expect(textOf(sections as ElementContent[])).toBe("{{ $item.Name }}{{ 1 + 2 }}");
    // Each section: the braces as punctuation around JavaScript.
    const first = sections[0] as Extract<ElementContent, { type: "element" }>;
    const [open, ...rest] = first.children as Extract<ElementContent, { type: "element" }>[];
    expect(open.properties?.className).toEqual(["token", "punctuation"]);
    expect(textOf([open])).toBe("{{");
    expect(textOf([rest[rest.length - 1]])).toBe("}}");
    expect(classesOf([sections[1]] as ElementContent[])).toEqual(expect.arrayContaining(["number", "operator"]));
  });

  it("a component without sections is just its text, in the text language", () => {
    const out = highlightComponent("plain **text**");
    expect(textOf(out)).toBe("plain **text**");
    expect(classesOf(out)).toContain("bold");
  });

  it("colours the text around the sections as HTML when asked", () => {
    const out = highlightComponent("<b>{{ $item.A }}</b>", "markup");
    expect(textOf(out)).toBe("<b>{{ $item.A }}</b>");
    expect(classesOf(out)).toContain("tag");
  });

  it("handles an empty component and an unclosed brace", () => {
    expect(textOf(highlightComponent(""))).toBe("");
    expect(textOf(highlightComponent("a {{ b"))).toBe("a {{ b");
  });
});
