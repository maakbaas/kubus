import { describe, expect, it } from "vitest";
import { isOpenableUrl, safeUrl } from "./openExternal";

describe("links to other apps", () => {
  it("opens any scheme but the blocked ones", () => {
    for (const url of ["https://x.org", "mailto:a@b.c", "tel:+31612345678", "spotify:track:4uLU6hMCjMI75M1A2tKUQC", "obsidian://open?vault=v"]) {
      expect(isOpenableUrl(url)).toBe(true);
    }
    for (const url of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,x", "file:///C:/x.exe", "vbscript:x", "files/abc", ""]) {
      expect(isOpenableUrl(url)).toBe(false);
    }
  });
  it("keeps relative and openable URLs in Markdown, drops the rest", () => {
    expect(safeUrl("spotify:album:1")).toBe("spotify:album:1");
    expect(safeUrl("files/abc")).toBe("files/abc");
    expect(safeUrl("javascript:alert(1)")).toBe("");
  });
});
