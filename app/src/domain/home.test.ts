import { describe, expect, it } from "vitest";
import { DEFAULT_HOME, parseHomeLayout, shownHomeBlocks, withHomeCollapsed } from "./home";

describe("the Home page's layout", () => {
  it("is read leniently: unknown blocks and repeats dropped, anything unreadable the default", () => {
    expect(parseHomeLayout(undefined)).toEqual(DEFAULT_HOME);
    expect(parseHomeLayout("x")).toEqual(DEFAULT_HOME);
    expect(parseHomeLayout({ shown: ["bookmarks", "gone", "bookmarks"], collapsed: ["pages", 3] })).toEqual({ shown: ["bookmarks"], collapsed: ["pages"] });
    // Every block hidden is a choice, not the default.
    expect(shownHomeBlocks(parseHomeLayout({ shown: [] }))).toEqual([]);
    expect(shownHomeBlocks(DEFAULT_HOME)).toEqual(["pages", "bookmarks"]);
  });

  it("collapses and expands a block once", () => {
    const one = withHomeCollapsed(withHomeCollapsed(DEFAULT_HOME, "pages", true), "pages", true);
    expect(one.collapsed).toEqual(["pages"]);
    expect(withHomeCollapsed(one, "pages", false).collapsed).toEqual([]);
  });
});
