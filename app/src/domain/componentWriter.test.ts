import { describe, expect, it } from "vitest";
import { componentMessages, describeCollections, parseComponentReply } from "./componentWriter";
import type { Collection, FieldDef } from "./model";

const field = (id: string, name: string, kind: FieldDef["kind"]): FieldDef => ({
  id, collectionId: "t", name, kind, targetCollectionId: null, componentId: null, componentArgs: {}, choiceFilter: [], toggleIcon: null, strikeThrough: false,
  aiPrompt: null, aiOutput: null, position: 0,
});
const book: Collection = {
  id: "t", name: "Book", pluralName: "Books", icon: null, description: "", itemViews: [], spaceIds: null,
  fields: [field("title", "Title", "string"), field("pages", "Pages", "number")],
  createdAt: "", updatedAt: "",
};

describe("componentMessages", () => {
  it("gives the documentation, the fields and the request", () => {
    const [system, user] = componentMessages({ help: "HELP TEXT", request: "reading time", collections: [book], focus: book });
    expect(system.content).toContain("HELP TEXT");
    expect(user.content).toContain("Title (String), Pages (Number)");
    expect(user.content).toContain("reading time");
  });

  it("asks for a description of the whole final component, not of the request", () => {
    const [system] = componentMessages({ help: "", request: "shorter", collections: [] });
    expect(system.content).toContain("final code as a whole");
  });

  it("hands over the component to change", () => {
    const [, user] = componentMessages({
      help: "", request: "shorter", collections: [], current: { name: "N", description: "", output: "markdown", code: "{{ 1 }}" },
    });
    expect(user.content).toContain("<code>\n{{ 1 }}\n</code>");
  });
});

describe("describeCollections", () => {
  it("stops at the limit", () => {
    expect(describeCollections([book, book, book], 60).split("\n")).toHaveLength(1);
  });
});

describe("parseComponentReply", () => {
  it("takes the code between the tags as it is, backslashes included", () => {
    const reply = '{"name":"Lines","description":"One per line","output":"string"}\n<code>\n{{ $item.Tags.join("\\n") }} <code>x</code>\n</code>';
    expect(parseComponentReply(reply)).toEqual({ name: "Lines", description: "One per line", output: "string", code: '{{ $item.Tags.join("\\n") }} <code>x</code>' });
  });

  it("reads code inside the JSON too, also inside a fence or text", () => {
    const reply = 'Here you go:\n```json\n{"name":"Reading time","description":"Hours","output":"number","code":"{{ $item.Pages / 40 }}"}\n```';
    expect(parseComponentReply(reply)).toEqual({ name: "Reading time", description: "Hours", output: "number", code: "{{ $item.Pages / 40 }}" });
  });

  it("falls back to Markdown for an unknown output", () => {
    expect(parseComponentReply('{"output":"pdf","code":"x"}')).toMatchObject({ output: "markdown" });
  });

  it("explains an answer it can't use", () => {
    expect(parseComponentReply("no")).toHaveProperty("error");
    expect(parseComponentReply("{bad json}")).toHaveProperty("error");
    expect(parseComponentReply('{"name":"x"}')).toHaveProperty("error");
  });
});
