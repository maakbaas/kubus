// "Write with AI" in the component editor: asking a language model for a component's code and
// description from a few words. The model is given the whole documentation of components
// and `{{ }}` code (help/components.md, the same text as the Help page) and the collections' fields, and
// answers with a JSON object (name, description, output) followed by the code between <code> tags.
// The code stays out of the JSON: as a JSON string every backslash in it (a "\n", a regex) would
// need escaping twice, which models get wrong. UI-free: the editor sends the messages and applies the draft.

import { isComponentOutput, type ComponentOutput } from "./components";
import { fieldKinds } from "./fieldKinds";
import type { Collection } from "./model";

export interface ComponentSuggestion {
  name: string;
  description: string;
  output: ComponentOutput;
  code: string;
}

/** What the model is told about the collections: names and fields, so it can read `$item.Pages`. Cut off at `limit` characters. */
export function describeCollections(collections: Collection[], limit = 4000): string {
  const lines = collections.map(
    (c) =>
      `- ${c.name}: ${c.fields
        .map((f) => `${f.name} (${fieldKinds[f.kind].label})`)
        .join(", ")}`,
  );
  let text = "";
  for (const line of lines) {
    if (text.length + line.length > limit) break;
    text += `${text ? "\n" : ""}${line}`;
  }
  return text;
}

/**
 * The conversation: the documentation and the shape of the answer, then what the user wants (with
 * the component as it is now, when there is one, to change it). `focus` is the collection the
 * component is meant for, when the user chose one.
 */
export function componentMessages(args: {
  help: string;
  request: string;
  current?: { name: string; description: string; output: ComponentOutput; code: string };
  collections: Collection[];
  focus?: Collection;
}): { role: "system" | "user"; content: string }[] {
  const { help, request, current, collections, focus } = args;
  const system = [
    "You write components for Kubus, a personal knowledge base. A component is text with {{ JavaScript }} sections. The documentation follows; rely on it, and on nothing else about Kubus.",
    "<documentation>",
    help.trim(),
    "</documentation>",
    "Reply with one JSON object, then the text of the component between <code> and </code>, exactly as it is to be stored (not escaped), and nothing else (no code fence, no comments):",
    '{"name": "two to four words", "description": "one short sentence on what it shows", "output": "markdown" | "string" | "number" | "image" | "html"}',
    "<code>",
    "the text of the component",
    "</code>",
    "Rules:",
    "- Read an item's fields with $item (for example {{ $item.Pages }}). There are no other variables: any $name but $now, $item, $items, $groups, $fields and $all is an error.",
    "- Never use $item together with $items, $groups, $fields or $all in one component: it is either about one item or about a block's items.",
    "- Each section is one JavaScript expression. Guard for empty fields (null).",
    "- Choose the simplest output that fits: number for a computed number, string for one line of plain text, markdown for formatted text, html only for what Markdown cannot do (charts, maps).",
    "- Keep it short and plain; do not add what was not asked for.",
    "- The description says what the finished component shows, worked out from its final code as a whole. It is not about the request, and when you change an existing component it is not about the change: write it as if describing the final component to someone who never saw the earlier one.",
  ].join("\n");
  const known = focus ? describeCollections([focus]) : describeCollections(collections);
  const user = [
    focus ? `The component is for the collection ${focus.name}. Its fields:` : "The collections and their fields:",
    known || "(no collections yet)",
    ...(current?.code.trim()
      ? [
          "",
          "The component as it is now (change it as asked, then describe the whole result in the description, not just the change):",
          JSON.stringify({ name: current.name, description: current.description, output: current.output }),
          `<code>\n${current.code}\n</code>`,
        ]
      : []),
    "",
    "What the component should do:",
    request.trim(),
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** The model's answer as a suggestion, or why it is none. */
export function parseComponentReply(reply: string): ComponentSuggestion | { error: string } {
  // The code between the first <code> and the last </code> (an HTML component may hold code tags
  // of its own), without the line breaks around it; the JSON before it.
  const open = reply.indexOf("<code>");
  const close = reply.lastIndexOf("</code>");
  const tagged = open >= 0 && close > open ? reply.slice(open + "<code>".length, close).replace(/^\r?\n/, "").replace(/\r?\n$/, "") : null;
  const head = tagged === null ? reply : reply.slice(0, open);
  const start = head.indexOf("{");
  const end = head.lastIndexOf("}");
  if (start < 0 || end <= start) return { error: "The model did not answer with a component." };
  let data: unknown;
  try {
    data = JSON.parse(head.slice(start, end + 1));
  } catch {
    return { error: "The model's answer could not be read." };
  }
  const o = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  // A model that put the code in the JSON after all: taken from there.
  const code = tagged ?? (typeof o.code === "string" ? o.code : "");
  if (!code.trim()) return { error: "The model's answer has no code." };
  return {
    name: typeof o.name === "string" ? o.name.trim() : "",
    description: typeof o.description === "string" ? o.description.trim() : "",
    output: isComponentOutput(o.output) ? o.output : "markdown",
    code,
  };
}
