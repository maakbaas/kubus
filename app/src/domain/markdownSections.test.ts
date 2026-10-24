import { describe, expect, it } from "vitest";
import { protectSections, restoreSections } from "../ui/markdownSections";

describe("markdown sections", () => {
  it("swaps sections for plain tokens and back, whatever the code holds", () => {
    const text = "Total **{{ $a * $b * 2 }}** and {{ $item.Name_x }}\n\n```\n{{ code }}\n```";
    const { text: safe, sections } = protectSections(text);
    expect(safe).not.toContain("{{");
    expect(sections).toEqual([" $a * $b * 2 ", " $item.Name_x ", " code "]);
    expect(restoreSections(safe, sections)).toBe(text);
  });

  it("leaves unknown tokens alone", () => {
    expect(restoreSections("KUSEC9Z", [])).toBe("KUSEC9Z");
  });
});
