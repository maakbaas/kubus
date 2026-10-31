import { describe, expect, it } from "vitest";
import { splitUrls } from "./Highlight";

// Web addresses in plain values become links (Highlight's `links`): what counts as one.
describe("web addresses in text", () => {
  it("are found without the punctuation around them", () => {
    expect(splitUrls("See https://example.com/a?b=1#c, or (http://x.org/y).")).toEqual(["See ", "https://example.com/a?b=1#c", ", or (", "http://x.org/y", ")."]);
  });

  it("include other apps' links: scheme:// ones, and the well-known ones without slashes", () => {
    expect(splitUrls("Play spotify:album:35yZZTWeSrszSKjRlFETwf.")).toEqual(["Play ", "spotify:album:35yZZTWeSrszSKjRlFETwf", "."]);
    expect(splitUrls("open obsidian://open?vault=a or mailto:me@example.com")).toEqual(["open ", "obsidian://open?vault=a", " or ", "mailto:me@example.com", ""]);
    // A word before a colon is no link, nor one that may not be opened.
    expect(splitUrls("TODO:fix at 10:30, Note: done")).toEqual(["TODO:fix at 10:30, Note: done"]);
    expect(splitUrls("see javascript://alert and file:///etc")).toEqual(["see javascript://alert and file:///etc"]);
  });

  it("leave other text as it is", () => {
    expect(splitUrls("no link here, example.com #tag")).toEqual(["no link here, example.com #tag"]);
  });
});
