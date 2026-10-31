import { describe, expect, it } from "vitest";
import { splitUrls } from "./Highlight";

// Web addresses in plain values become links (Highlight's `links`): what counts as one.
describe("web addresses in text", () => {
  it("are found without the punctuation around them", () => {
    expect(splitUrls("See https://example.com/a?b=1#c, or (http://x.org/y).")).toEqual(["See ", "https://example.com/a?b=1#c", ", or (", "http://x.org/y", ")."]);
  });

  it("include anything written as scheme:…, other apps' links too", () => {
    expect(splitUrls("Play spotify:album:35yZZTWeSrszSKjRlFETwf.")).toEqual(["Play ", "spotify:album:35yZZTWeSrszSKjRlFETwf", "."]);
    expect(splitUrls("open obsidian://open?vault=a or slack:open")).toEqual(["open ", "obsidian://open?vault=a", " or ", "slack:open", ""]);
    // A space after the colon, a time, a drive letter: text. A scheme that may not be opened: text.
    expect(splitUrls("Note: done at 10:30 in C:\\Users")).toEqual(["Note: done at 10:30 in C:\\Users"]);
    expect(splitUrls("see javascript:alert(1) and file:///etc")).toEqual(["see javascript:alert(1) and file:///etc"]);
  });

  it("leave other text as it is", () => {
    expect(splitUrls("no link here, example.com #tag")).toEqual(["no link here, example.com #tag"]);
  });
});
