import { describe, expect, it } from "vitest";
import { browserUrl, isOpenableUrl, safeUrl } from "./openExternal";

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

describe("the iOS home-screen app", () => {
  it("hands a web page to the chosen browser, never the in-app one", () => {
    const url = " https://x.org/a?b=1&c=2 ";
    expect(browserUrl(url, "safari", 18)).toBe("x-safari-https://x.org/a?b=1&c=2");
    expect(browserUrl("https://x.org", "safari", 16)).toBe("com-apple-mobilesafari-tab:https://x.org");
    expect(browserUrl(url, "chrome", 18)).toBe("googlechromes://x.org/a?b=1&c=2");
    expect(browserUrl("http://x.org", "chrome", 18)).toBe("googlechrome://x.org");
    expect(browserUrl(url, "firefox", 18)).toBe("firefox://open-url?url=https%3A%2F%2Fx.org%2Fa%3Fb%3D1%26c%3D2");
    expect(browserUrl(url, "edge", 18)).toBe("microsoft-edge-https://x.org/a?b=1&c=2");
    expect(browserUrl(url, "brave", 18)).toBe("brave://open-url?url=https%3A%2F%2Fx.org%2Fa%3Fb%3D1%26c%3D2");
  });
});
