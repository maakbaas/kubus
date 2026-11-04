import { describe, expect, it } from "vitest";
import { markdownExcerpt, markdownPlainText, aroundMatch } from "./markdownExcerpt";

describe("markdownPlainText", () => {
  it("is what a reader sees: text, code and image descriptions, no syntax, URLs or HTML", () => {
    const md = "# Title\n\nSome **bold** and `code` with [a link](https://secret.example/x) ![an image](files/abc)\n\n<div>html</div>\n\n```js\nlet x;\n```";
    const text = markdownPlainText(md);
    for (const shown of ["Title", "bold", "code", "a link", "an image", "let x;"]) expect(text).toContain(shown);
    for (const hidden of ["secret.example", "files/abc", "html", "**", "```"]) expect(text).not.toContain(hidden);
  });

  it("keeps words of inline text together and separates blocks and cells", () => {
    expect(markdownPlainText("a**b**c")).toBe("abc");
    expect(markdownPlainText("one\n\ntwo")).toContain("one two");
    expect(markdownPlainText("| a | b |\n|---|---|\n| 1 | 2 |")).toMatch(/a.*b.*1.*2/);
  });

  it("is empty for nothing", () => {
    expect(markdownPlainText("")).toBe("");
  });
});

describe("markdownExcerpt", () => {
  const doc = [
    "# Books",
    "",
    "Intro about reading.",
    "",
    "## Fiction",
    "",
    "Dune is a **desert** novel.",
    "",
    "Emma is about matchmaking.",
    "",
    "## Notes",
    "",
    "- buy dune",
    "- call Anna",
    "- reread Dune again",
  ].join("\n");

  it("shows the matching block under its section's heading", () => {
    const out = markdownExcerpt(doc, "matchmaking");
    expect(out).toEqual({ markdown: "## Fiction\n\nEmma is about matchmaking.", more: 0 });
  });

  it("shows a heading's section once for several matches in it", () => {
    const out = markdownExcerpt("## Fiction\n\nDune one.\n\nDune two.", "dune");
    expect(out.markdown).toBe("## Fiction\n\nDune one.\n\nDune two.");
  });

  it("a match in a heading shows just that heading", () => {
    expect(markdownExcerpt(doc, "fiction").markdown).toBe("## Fiction");
  });

  it("a match before any heading has no heading to show", () => {
    expect(markdownExcerpt("Dune first.\n\n# Later", "dune").markdown).toBe("Dune first.");
  });

  it("matches the visible text, never the syntax", () => {
    expect(markdownExcerpt("[click](https://dune.example)\n\n![dune](files/x)", "example").markdown).toBe("");
    expect(markdownExcerpt("Some **desert** text", "desert").markdown).toBe("Some **desert** text");
    expect(markdownExcerpt("a [link](http://x.org) b", "link").markdown).toBe("a [link](http://x.org) b");
  });

  it("a list is cut down to its matching items, loose lists keep their blank lines", () => {
    expect(markdownExcerpt(doc, "dune", false).markdown).toContain("## Notes\n\n- buy dune\n- reread Dune again");
    expect(markdownExcerpt("- a dune\n\n- b\n\n- c dune", "dune").markdown).toBe("- a dune\n\n- c dune");
  });

  it("a table is cut down to its header and matching rows", () => {
    const table = "| Book | Year |\n| :--- | ---: |\n| Dune | 1965 |\n| Emma | 1815 |\n| Dune Messiah | 1969 |";
    expect(markdownExcerpt(table, "dune").markdown).toBe("| Book | Year |\n| :--- | ---: |\n| Dune | 1965 |\n| Dune Messiah | 1969 |");
    expect(markdownExcerpt(table, "year").markdown).toBe("| Book | Year |\n| :--- | ---: |");
    expect(markdownExcerpt("Book | Year\n--- | ---\nDune | 1965\nEmma | 1815", "emma").markdown).toBe("Book | Year\n--- | ---\nEmma | 1815");
  });

  it("a paragraph is shown without its images and the line breaks they leave", () => {
    // Shift+Enter, then an image: one paragraph in Markdown, two blocks to the reader.
    expect(markdownExcerpt("para dune\\\n![shot.png](files/x)", "dune").markdown).toBe("para dune");
    expect(markdownExcerpt("![a](files/x)  \nfirst dune\\\n![b](files/y)\\\nsecond line", "dune").markdown).toBe("first dune\\\nsecond line");
    expect(markdownExcerpt("para dune\n<br />", "dune").markdown).toBe("para dune");
    expect(markdownExcerpt("Some **dune** text", "dune").markdown).toBe("Some **dune** text");
    // Only an image (its description matched): nothing to show.
    expect(markdownExcerpt("![dune.png](files/x)\n\ndune text", "dune")).toEqual({ markdown: "dune text", more: 0 });
  });

  it("shows three blocks at most and counts the rest", () => {
    const many = Array.from({ length: 6 }, (_, i) => `dune ${i}`).join("\n\n");
    const out = markdownExcerpt(many, "dune");
    expect(out.markdown.split("\n\n")).toHaveLength(3);
    expect(out.more).toBe(3);
  });

  it("a tag query can be exact: not #dunes for #dune, but nested tags", () => {
    const tags = "see #dunes\n\nsee #dune/part-one\n\nsee #dune";
    expect(markdownExcerpt(tags, "#dune").markdown.split("\n\n")).toHaveLength(3);
    expect(markdownExcerpt(tags, "#dune", true).markdown).toBe("see #dune/part-one\n\nsee #dune");
  });

  it("nothing matches an empty query or an empty document", () => {
    expect(markdownExcerpt(doc, "")).toEqual({ markdown: "", more: 0 });
    expect(markdownExcerpt(doc, "   ")).toEqual({ markdown: "", more: 0 });
    expect(markdownExcerpt("", "x")).toEqual({ markdown: "", more: 0 });
  });
});

describe("aroundMatch", () => {
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `Sentence number ${i} says **little** here.`).join(" ");

  it("cuts a long paragraph to whole sentences around the match, never through syntax", () => {
    const text = `${filler(6)} The *dune* sea is where the needle is. ${filler(6)}`;
    const out = aroundMatch(text, "needle");
    expect(out.startsWith("… The *dune* sea is where the needle is.")).toBe(true);
    expect(out.endsWith(" …")).toBe(true);
    expect(out.length).toBeLessThan(text.length);
    expect((out.match(/\*\*/g) ?? []).length % 2).toBe(0); // no bold left open
  });

  it("leaves a short paragraph, or one without the match, as it is", () => {
    expect(aroundMatch("Short. With a needle.", "needle")).toBe("Short. With a needle.");
    const long = filler(12);
    expect(aroundMatch(long, "absent")).toBe(long);
  });
});
