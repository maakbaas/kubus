import { describe, expect, it } from "vitest";
import { fieldKindList, fieldKinds, formatDate, formatDateTime, formatTime, htmlPreview, markdownPreview, markdownPreviewParts, offeredKind } from "./fieldKinds";
import type { FieldKind } from "./model";

describe("date formats", () => {
  it("are local, padded and sortable", () => {
    const d = new Date(2026, 0, 5, 7, 3);
    expect(formatDate(d)).toBe("2026-01-05");
    expect(formatTime(d)).toBe("07:03");
    expect(formatDateTime(d.toISOString())).toBe("2026-01-05 07:03");
  });

  it("a datetime that isn't one is shown as it is", () => {
    expect(formatDateTime("not a date")).toBe("not a date");
    expect(fieldKinds.datetime.format("later")).toBe("later");
  });
});

describe("the storage of each kind", () => {
  it("text kinds store a non-empty string, and read empty as nothing", () => {
    for (const kind of ["string", "markdown", "html", "date", "datetime", "image", "item"] as FieldKind[]) {
      const spec = fieldKinds[kind];
      expect(spec.toDb("x")).toBe("x");
      expect(spec.toDb("")).toBeNull();
      expect(spec.toDb(null)).toBeNull();
      expect(spec.toDb(5)).toBeNull();
      expect(spec.fromDb(null)).toBeNull();
      expect(spec.fromDb(undefined)).toBeNull();
      expect(spec.fromDb("x")).toBe("x");
    }
  });

  it("numbers keep only finite numbers and are shown as typed", () => {
    const n = fieldKinds.number;
    expect(n.toDb(12.5)).toBe(12.5);
    expect(n.toDb(Infinity)).toBeNull();
    expect(n.toDb(NaN)).toBeNull();
    expect(n.toDb("12")).toBeNull();
    expect(n.fromDb("3.5")).toBe(3.5);
    expect(n.fromDb(null)).toBeNull();
    expect(n.format(1234567.5)).toBe("1234567.5");
    expect(n.format(null)).toBe("");
    expect(n.format("x")).toBe("");
  });

  it("checkboxes are stored as 0 and 1, and are only shown when checked", () => {
    const c = fieldKinds.checkbox;
    expect([c.toDb(true), c.toDb(false), c.toDb(null)]).toEqual([1, 0, null]);
    expect([c.fromDb(1), c.fromDb(0), c.fromDb("1"), c.fromDb(null)]).toEqual([true, false, true, null]);
    expect([c.format(true), c.format(false), c.format(null)]).toEqual(["✓", "", ""]);
  });

  it("lists are stored as JSON, an empty one as nothing, and unreadable ones as nothing", () => {
    for (const kind of ["string_list", "checklist", "item_list"] as FieldKind[]) {
      const spec = fieldKinds[kind];
      expect(spec.toDb(["a", "b"])).toBe('["a","b"]');
      expect(spec.toDb([])).toBeNull();
      expect(spec.toDb("a")).toBeNull();
      expect(spec.fromDb('["a",2]')).toEqual(["a", "2"]);
      expect(spec.fromDb("{not json")).toBeNull();
      expect(spec.fromDb('{"a":1}')).toBeNull();
      expect(spec.fromDb(null)).toBeNull();
    }
  });

  it("lists are shown joined; a checklist shows its progress", () => {
    expect(fieldKinds.string_list.format(["a", "b"])).toBe("a, b");
    expect(fieldKinds.string_list.format(null)).toBe("");
    expect(fieldKinds.item_list.format(["i1", "i2"])).toBe("i1, i2");
    expect(fieldKinds.item_list.format("x")).toBe("");
    expect(fieldKinds.checklist.format(["[x] a", "[ ] b", "c"])).toBe("1/3");
    expect(fieldKinds.checklist.format([])).toBe("");
  });

  it("computed kinds are never written to the database; their stored text reads back", () => {
    for (const kind of ["component", "ai"] as FieldKind[]) {
      const spec = fieldKinds[kind];
      expect(spec.toDb("anything")).toBeNull();
      expect(spec.fromDb("stored")).toBe("stored");
      expect(spec.fromDb(null)).toBeNull();
      expect(spec.format("**bold**")).toBe("bold");
      expect(spec.format(42)).toBe("42");
      expect(spec.format(null)).toBe("");
    }
  });

  it("text kinds show a plain version", () => {
    expect(fieldKinds.string.format(null)).toBe("");
    expect(fieldKinds.string.format("a")).toBe("a");
    expect(fieldKinds.markdown.format("# Hi **there**")).toBe("Hi there");
    expect(fieldKinds.markdown.format(null)).toBe("");
    expect(fieldKinds.html.format("<p>Hi <b>there</b></p>")).toBe("Hi there");
    expect(fieldKinds.html.format(3)).toBe("");
    expect(fieldKinds.date.format("2026-02-03")).toBe("2026-02-03");
    expect(fieldKinds.date.format(null)).toBe("");
    expect(fieldKinds.image.format("abc")).toBe("abc");
    expect(fieldKinds.item.format("i1")).toBe("i1");
    expect(fieldKinds.item.format(null)).toBe("");
  });

  it("every kind has a label and a value column", () => {
    for (const [kind, spec] of Object.entries(fieldKinds)) {
      expect(spec.label, kind).not.toBe("");
      expect(spec.column, kind).toMatch(/^value_/);
    }
  });
});

describe("the kinds offered", () => {
  it("every kind but 'ai', which is a Component field asking AI", () => {
    expect(fieldKindList).toContain("component");
    expect(fieldKindList).not.toContain("ai");
    expect(fieldKindList).toHaveLength(Object.keys(fieldKinds).length - 1);
    expect(offeredKind("ai")).toBe("component");
    expect(offeredKind("string")).toBe("string");
  });
});

describe("htmlPreview", () => {
  it("is the text, cut with an ellipsis when long", () => {
    expect(htmlPreview("<p>short</p>")).toBe("short");
    const long = htmlPreview(`<p>${"word ".repeat(50)}</p>`);
    expect(long).toHaveLength(120);
    expect(long.endsWith("…")).toBe(true);
  });

  it("drops comments, decodes entities and keeps inline tags from splitting words", () => {
    expect(htmlPreview("<!-- note -->a<b>b</b>c &lt;&gt; &quot;q&quot; &#39;s&#39; &amp;amp;&nbsp;x")).toBe(`abc <> "q" 's' &amp; x`);
  });
});

describe("markdownPreview", () => {
  it("drops block syntax: headings, quotes, lists, task boxes, fences, table rules", () => {
    const md = "# Title\n> quote\n- [x] done\n1. first\n```js\ncode\n```\n| a | b |\n|---|:--:|\n| 1 | 2 |";
    expect(markdownPreview(md)).toBe("Title quote done first code a b 1 2");
  });

  it("shows inline code as it is, without tags, and does not link it", () => {
    expect(markdownPreviewParts("use `<b>` here")).toEqual(["use ", { text: "<b>", href: "" }, " here"]);
  });

  it("drops emphasis, escapes, HTML tags and hard breaks; keeps entities' spaces", () => {
    expect(markdownPreview("*a* __b__ ~~c~~ \\#tag <br /> x&nbsp;y end\\\nnext")).toBe("a b c #tag x y end next");
  });

  it("uses the target as the text of a link without one", () => {
    expect(markdownPreviewParts("[](https://x.org)")).toEqual([{ text: "https://x.org", href: "https://x.org" }]);
  });

  it("a link is cut with the text, and nothing follows the cut", () => {
    const parts = markdownPreviewParts(`${"w ".repeat(55)}[${"link ".repeat(20)}](https://x.org) after`);
    const total = parts.map((p) => (typeof p === "string" ? p : p.text)).join("");
    expect(total.length).toBeLessThanOrEqual(120);
    expect(total.endsWith("…")).toBe(true);
    expect(total).not.toContain("after");
  });

  it("is empty for nothing", () => {
    expect(markdownPreviewParts("")).toEqual([]);
    expect(markdownPreview("![](files/abc)")).toBe("");
  });
});
