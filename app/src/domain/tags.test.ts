import { describe, expect, it } from "vitest";
import { markdownPreview, markdownPreviewParts } from "./fieldKinds";
import { markdownExcerpt } from "./markdownExcerpt";
import { containsQuery, isTag, splitTags, tagSearchPath, tagsIn } from "./tags";

describe("tags", () => {
  it("finds tags where a word doesn't continue", () => {
    expect(splitTags("Read #books and #books/to-read, #über_alles.")).toEqual(["Read ", "#books", " and ", "#books/to-read", ", ", "#über_alles", "."]);
    expect(splitTags("#start")).toEqual(["", "#start", ""]);
    expect(splitTags("(#a)")).toEqual(["(", "#a", ")"]);
  });

  it("leaves what isn't a tag", () => {
    for (const text of ["a#b", "#1", "#2024", "##x", "&#123;", "https://x.org/#frag", "# heading", "\\#escaped", "no tags"]) {
      expect(splitTags(text)).toEqual([text]);
    }
  });

  it("doesn't end a tag in - or /", () => {
    expect(splitTags("#todo- #a/")).toEqual(["", "#todo", "- ", "#a", "/"]);
  });

  it("tells a tag query", () => {
    expect(isTag("#books")).toBe(true);
    expect(isTag("#books x")).toBe(false);
    expect(isTag("books")).toBe(false);
    expect(tagsIn("#A #a #b")).toEqual(["#a", "#b"]);
  });

  it("matches a typed query as text, a clicked tag exactly", () => {
    expect(containsQuery("on the #bookshelf", "#books")).toBe(true);
    expect(containsQuery("on the #bookshelf", "#books", true)).toBe(false);
    expect(containsQuery("#Books today", "#books", true)).toBe(true);
    expect(containsQuery("#books/to-read", "#books", true)).toBe(true);
    expect(containsQuery("plain books", "books", true)).toBe(true);
    expect(tagSearchPath("#a/b")).toBe("/search?q=%23a%2Fb&tag=1");
  });

  it("shows a tag the editor escaped at a line's start", () => {
    expect(markdownPreview("\\#books are *great*")).toBe("#books are great");
    // Inline code is its own part in a preview: shown without tags, as rendered Markdown does.
    expect(markdownPreviewParts("a `#x` b")).toEqual(["a ", { text: "#x", href: "" }, " b"]);
    expect(markdownExcerpt("Para\n\n\\#books here\n\n#bookshelf", "#books", true).markdown).toBe("\\#books here");
  });
});
