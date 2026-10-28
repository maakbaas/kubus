import { describe, expect, it } from "vitest";
import { splitUrls } from "./Highlight";

// Web addresses in plain values become links (Highlight's `links`): what counts as one.
describe("web addresses in text", () => {
  it("are found without the punctuation around them", () => {
    expect(splitUrls("See https://example.com/a?b=1#c, or (http://x.org/y).")).toEqual(["See ", "https://example.com/a?b=1#c", ", or (", "http://x.org/y", ")."]);
  });

  it("leave other text as it is", () => {
    expect(splitUrls("no link here, example.com #tag")).toEqual(["no link here, example.com #tag"]);
  });
});
