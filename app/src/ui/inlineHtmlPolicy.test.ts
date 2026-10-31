import { describe, expect, it } from "vitest";
import { allowedUrl, cleanCss } from "./inlineHtmlPolicy";

describe("inline HTML: what loads from elsewhere is left out", () => {
  it("keeps links to pages and in-app anchors, and only stored files or images in the address for what is loaded", () => {
    expect(["https://x.org", "#/collections", "mailto:a@b.c"].map((v) => allowedUrl("href", "a", v))).toEqual([true, true, true]);
    expect(allowedUrl("href", "a", "javascript:alert(1)")).toBe(false);
    expect(allowedUrl("src", "img", `files/${"a".repeat(64)}`)).toBe(true);
    expect(allowedUrl("src", "img", "data:image/svg+xml,<svg/>")).toBe(true);
    expect(allowedUrl("src", "img", "https://tracker.example/p.gif")).toBe(false);
    expect(allowedUrl("src", "img", "data:text/html,<script>")).toBe(false);
    expect(allowedUrl("href", "use", "#bar")).toBe(true);
    expect(allowedUrl("href", "image", "https://x.org/a.png")).toBe(false);
    expect(allowedUrl("srcset", "img", "files/a 1x")).toBe(false);
  });

  it("takes @import and outside url() out of CSS, keeping the rest", () => {
    expect(cleanCss("@import url(https://x.org/a.css); .a { color: red }")).toBe(" .a { color: red }");
    expect(cleanCss("background: url('https://x.org/a.png') no-repeat; width: 40%")).toBe("background: none no-repeat; width: 40%");
    expect(cleanCss("background: url(data:image/png;base64,AAAA)")).toBe("background: url(data:image/png;base64,AAAA)");
    expect(cleanCss("background: u\\72l(https://x.org)")).toBe("background: ul(https://x.org)");
    expect(cleanCss('background: image-set("https://x.org/a.png" 1x)')).toBe('background: blocked("https://x.org/a.png" 1x)');
  });
});
