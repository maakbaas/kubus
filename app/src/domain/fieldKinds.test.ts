import { describe, expect, it } from "vitest";
import { htmlPlainText, markdownPreview, markdownPreviewParts } from "./fieldKinds";

describe("markdownPreviewParts", () => {
  it("strips syntax but keeps links", () => {
    expect(markdownPreviewParts("Some **bold** [a *link*](https://x.org/a_b) and <https://y.org>\n\n- see https://z.org/p.")).toEqual([
      "Some bold ",
      { text: "a link", href: "https://x.org/a_b" },
      " and ",
      { text: "https://y.org", href: "https://y.org" },
      " see ",
      { text: "https://z.org/p", href: "https://z.org/p" },
      ".",
    ]);
  });
  it("leaves images out and truncates", () => {
    expect(markdownPreview("![photo](files/abc) hi")).toBe("hi");
    const long = markdownPreview("word ".repeat(50));
    expect(long.length).toBe(120);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("markdownPreviewParts with other schemes", () => {
  it("keeps links to other apps", () => {
    expect(markdownPreviewParts("[Song](spotify:track:1) <obsidian://open?vault=v>")).toEqual([
      { text: "Song", href: "spotify:track:1" },
      " ",
      { text: "obsidian://open?vault=v", href: "obsidian://open?vault=v" },
    ]);
  });
});

describe("htmlPlainText", () => {
  it("keeps the text, words apart only where blocks end", () => {
    expect(htmlPlainText('<style>p{}</style><h3>Hi <em>there</em></h3><p>A &amp; <a href="x">link</a>.</p><script>x()</script><button>Go</button>')).toBe(
      "Hi there A & link. Go",
    );
  });
});
