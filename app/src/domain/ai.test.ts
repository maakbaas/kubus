import { describe, expect, it } from "vitest";
import { aiPromptProblem, aiRequest, aiStaleness, decodeAiInput, encodeAiInput, parseAiReply, parseNumber } from "./ai";
import type { Collection, FieldDef, Item } from "./model";

const field = (id: string, name: string, kind: FieldDef["kind"], position: number, ai?: Partial<FieldDef>): FieldDef => ({
  id, collectionId: "t", name, kind, targetCollectionId: null, componentId: null, componentArgs: {}, choiceFilter: [], toggleIcon: null,
  aiPrompt: null, aiOutput: null, position, ...ai,
});

const sorted = field("sorted", "Shelf", "ai", 2, { aiPrompt: "Artist: {{ $item.Artist }}. Give the artist's last name.", aiOutput: "string" });
const collection: Collection = {
  id: "t", name: "Album", pluralName: "Albums", icon: null, description: "", itemViews: [], spaceIds: null,
  fields: [field("title", "Title", "string", 0), field("artist", "Artist", "string", 1), sorted],
  createdAt: "", updatedAt: "",
};
const album = (title: string, artist: string, shelf?: string): Item => ({
  id: "a1", collectionId: "t", spaceId: "default", values: { title, artist, ...(shelf && { sorted: shelf }) }, createdAt: "", updatedAt: "",
});
const request = (item: Item, f = sorted) => aiRequest(collection, f, item, () => "");

describe("aiRequest", () => {
  it("renders the prompt for the item", () => {
    const r = request(album("Kind of Blue", "Miles Davis"));
    expect(r).toMatchObject({ prompt: "Artist: Miles Davis. Give the artist's last name." });
  });

  it("only changes when what the prompt reads changes", () => {
    const a = request(album("Kind of Blue", "Miles Davis")) as { hash: string };
    expect(a.hash).toBe((request(album("Bitches Brew", "Miles Davis")) as { hash: string }).hash);
    expect(a.hash).not.toBe((request(album("Kind of Blue", "John Coltrane")) as { hash: string }).hash);
  });

  it("does not depend on the field's own stored value", () => {
    const a = request(album("Kind of Blue", "Miles Davis")) as { hash: string };
    expect(a.hash).toBe((request(album("Kind of Blue", "Miles Davis", "Davis")) as { hash: string }).hash);
  });

  it("depends on the output type", () => {
    const a = request(album("x", "y")) as { hash: string };
    const b = request(album("x", "y"), { ...sorted, aiOutput: "number" }) as { hash: string };
    expect(a.hash).not.toBe(b.hash);
  });

  it("keeps AI fields out of $item", () => {
    const other = field("other", "Other", "ai", 3, { aiPrompt: "{{ $item.Shelf }}" });
    const c = { ...collection, fields: [...collection.fields, other] };
    expect(aiRequest(c, other, album("x", "y", "Davis"), () => "")).toEqual({ problem: "The prompt is empty for this item" });
  });

  it("says why a failing section has no request", () => {
    const broken = { ...sorted, aiPrompt: "{{ $item.Artist.nope.nope }}" };
    expect(request(album("x", "y"), broken)).toHaveProperty("problem");
  });
});

describe("aiPromptProblem", () => {
  it("needs a prompt", () => {
    expect(aiPromptProblem("  ")).toBeDefined();
    expect(aiPromptProblem("Say hi")).toBeUndefined();
  });

  it("allows only $item", () => {
    expect(aiPromptProblem("{{ $item.Title }}")).toBeUndefined();
    expect(aiPromptProblem("{{ $now }}")).toMatch(/\$now/);
    expect(aiPromptProblem("{{ $pages }}")).toMatch(/\$pages/);
    expect(aiPromptProblem("costs '$5' {{ $item.Title }}")).toBeUndefined();
  });
});

describe("parseAiReply", () => {
  it("makes numbers out of replies", () => {
    expect(parseAiReply("number", "42")).toEqual({ value: 42 });
    expect(parseAiReply("number", "About 1,234.5 pages")).toEqual({ value: 1234.5 });
    expect(parseAiReply("number", "-3,5")).toEqual({ value: -3.5 });
    expect(parseAiReply("number", "no idea")).toHaveProperty("error");
  });

  it("puts text on one line without quotes", () => {
    expect(parseAiReply("string", '"Davis"\n')).toEqual({ value: "Davis" });
    expect(parseAiReply("string", "a\nb")).toEqual({ value: "a b" });
  });

  it("unwraps a fenced Markdown reply", () => {
    expect(parseAiReply("markdown", "```markdown\n- a\n- b\n```")).toEqual({ value: "- a\n- b" });
  });

  it("reads an empty reply, or an \"Unknown\" number, as no value", () => {
    expect(parseAiReply("number", "Unknown")).toEqual({ value: null });
    expect(parseAiReply("string", "Unknown")).toEqual({ value: "Unknown" });
    expect(parseAiReply("string", "  ")).toEqual({ value: null });
  });
});

describe("parseNumber", () => {
  it("handles both decimal separators", () => {
    expect(parseNumber("1.234,5")).toBe(1234.5);
    expect(parseNumber("1,234")).toBe(1234);
    expect(parseNumber("1.234.567")).toBe(1234567);
    expect(parseNumber("0.5")).toBe(0.5);
    expect(parseNumber("abc")).toBeNull();
  });
});

describe("aiStaleness", () => {
  const withInput = (hash: string | undefined, edited = false): Item => ({
    ...album("x", "y"),
    ...(hash !== undefined && { aiInputs: { sorted: hash } }),
    ...(edited && { aiEdited: { sorted: true as const } }),
  });
  it("makes values that are missing or made from another prompt", () => {
    expect(aiStaleness(withInput(undefined), sorted, "h")).toBe("generate");
    expect(aiStaleness(withInput("old"), sorted, "h")).toBe("generate");
    expect(aiStaleness(withInput("h"), sorted, "h")).toBe("current");
  });

  it("never replaces a typed value by itself", () => {
    expect(aiStaleness(withInput("old", true), sorted, "h")).toBe("ask");
    expect(aiStaleness(withInput("h", true), sorted, "h")).toBe("current");
  });

  it("adopts a value just typed as right for the item as it is", () => {
    expect(aiStaleness(withInput("", true), sorted, "h")).toBe("adopt");
  });
});

describe("encodeAiInput", () => {
  it("round-trips, also what was first stored (the bare fingerprint)", () => {
    expect(decodeAiInput(encodeAiInput("h"))).toEqual({ hash: "h", edited: false });
    expect(decodeAiInput(encodeAiInput("", true))).toEqual({ hash: "", edited: true });
    expect(decodeAiInput('"old"')).toEqual({ hash: "old", edited: false });
    expect(decodeAiInput(null)).toBeNull();
  });
});
