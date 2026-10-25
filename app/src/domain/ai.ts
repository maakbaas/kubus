// AI fields: a field whose value a language model writes from a prompt, once per item, and that
// is regenerated only when what the prompt says about the item changes.
//
// The prompt is Markdown with {{ }} sections over $item, exactly like a component (domain/
// components.ts): "Artist: {{ $item.Artist }}. If these albums were sorted by artist last name in a
// record store, give that last name." The prompt is rendered for the item, and the result is both
// what the model is asked and the fingerprint of the stored value: an item's value is stale when
// the fingerprint of today's rendered prompt differs from the one it was generated from (stored
// next to it, so synced devices agree). So dependencies need no tracking: a prompt that reads
// $item.Artist but not $item.Title is the same text, and so not stale, when only the title changes.
//
// What follows from that:
//  - A prompt must render the same text for the same data: $now, random numbers and the like
//    would make every value stale at once. Only $item is available (no $variables, no $items).
//  - A prompt cannot read AI fields (its own value would feed back into it, and two AI fields
//    reading each other would never settle); they are left out of $item for AI prompts.
//  - Changing a prompt makes every item's value stale: what that costs is for the caller to
//    weigh (app/ai.ts asks before generating a large batch).
//
// The layer in between: the model is told which field it fills and what shape the value has, and
// whatever it replies is made to fit (a number is parsed out, text is put on one line, a code
// fence around Markdown is removed); a reply that does not fit is an error, never stored.

import { dollarNames, fieldLookup, render, splitWarnings, type FieldLookup, type RefLabel } from "./components";
import type { AiOutput, Collection, FieldDef, Item } from "./model";

export const AI_OUTPUTS: { value: AiOutput; text: string }[] = [
  { value: "string", text: "Text" },
  { value: "number", text: "Number" },
  { value: "markdown", text: "Markdown" },
];

/** The prompt of an AI field is stored as it is typed; this is the output a field without one gets. */
export const DEFAULT_AI_OUTPUT: AiOutput = "string";

/** Why a prompt can't be used (shown where it is edited), or undefined when it can. */
export function aiPromptProblem(prompt: string | null | undefined): string | undefined {
  if (!prompt?.trim()) return "Write a prompt";
  const unavailable = dollarNames(prompt).find((n) => n !== "item");
  if (unavailable === "now") return "$now isn't available: it changes all the time, so the value would never be up to date";
  if (unavailable) return `$${unavailable} isn't available in an AI prompt, only $item`;
  return undefined;
}

/** What to ask the model for one item's value; `hash` fingerprints it (and the output type). */
export interface AiRequest {
  system: string;
  prompt: string;
  hash: string;
}

/**
 * The request for an item's AI field, or why there is none. `item` is the item with its computed
 * values (what its page shows), so the prompt reads what the user sees.
 */
export function aiRequest(collection: Collection, field: FieldDef, item: Item, refLabel: RefLabel): AiRequest | { problem: string } {
  const problem = aiPromptProblem(field.aiPrompt);
  if (problem) return { problem };
  const output = field.aiOutput ?? DEFAULT_AI_OUTPUT;
  const text = String(render({ params: [], code: field.aiPrompt!, output: "string" }, [], item, lookupWithoutAi(collection, item, refLabel)) ?? "");
  const warnings = splitWarnings(text);
  if (warnings.length > 1) return { problem: warnings[1] };
  const prompt = text.trim();
  if (!prompt) return { problem: "The prompt is empty for this item" };
  return { system: systemPrompt(collection, field, output), prompt, hash: hashText(`${output}\n${prompt}`) };
}

/** The item's fields as an AI prompt sees them: all but the AI fields. */
function lookupWithoutAi(collection: Collection, item: Item, refLabel: RefLabel): FieldLookup {
  const all = fieldLookup(collection, item, refLabel);
  const ai = new Set(collection.fields.filter((f) => f.kind === "ai").map((f) => f.name));
  return { names: all.names.filter((n) => !ai.has(n)), get: (name) => (ai.has(name) ? undefined : all.get(name)) };
}

const SHAPES: Record<AiOutput, string> = {
  string: "The value is plain text on a single line.",
  number: "The value is a single number: digits with an optional minus sign and decimal point, no units, no thousands separators.",
  markdown: "The value is GitHub Flavored Markdown, without a code fence around it.",
};

function systemPrompt(collection: Collection, field: FieldDef, output: AiOutput): string {
  return [
    `You fill in one field of an item in a personal knowledge base. The item is a ${collection.name}; the field is "${field.name}".`,
    "Reply with the field's value only: no introduction, no explanation, no quotes around it.",
    SHAPES[output],
    output === "number"
      ? "If the value cannot be determined from what you are given, reply with nothing at all (an empty reply)."
      : "If the value cannot be determined from what you are given, reply with exactly: Unknown",
  ].join("\n");
}

/**
 * What is stored next to an AI value (JSON): the fingerprint of the prompt it answers, and whether the
 * user typed it. A typed value whose fingerprint is "" was just typed: the next look at its item
 * takes the item as it is as the state it was typed for (`aiStaleness`: "adopt").
 */
export const encodeAiInput = (hash: string, edited = false): string => JSON.stringify(edited ? { hash, edited: true } : { hash });

export function decodeAiInput(json: unknown): { hash: string; edited: boolean } | null {
  if (typeof json !== "string") return null;
  try {
    const data: unknown = JSON.parse(json);
    if (typeof data === "string") return { hash: data, edited: false }; // as first stored: just the fingerprint
    if (data && typeof data === "object" && typeof (data as { hash?: unknown }).hash === "string") {
      return { hash: (data as { hash: string }).hash, edited: (data as { edited?: unknown }).edited === true };
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/**
 * What an AI value needs, given the prompt as it reads today (`hash`):
 *  - "current": nothing;
 *  - "generate": no value, or one the model made from another prompt: make it (by itself);
 *  - "adopt": the user just typed it: it is right for the item as it is now (remember that);
 *  - "ask": the user typed it, and the prompt has changed since: never replaced by itself, the user is asked.
 */
export type AiNeed = "current" | "generate" | "adopt" | "ask";
export function aiStaleness(item: Item, field: FieldDef, hash: string): AiNeed {
  const stored = item.aiInputs?.[field.id];
  if (item.aiEdited?.[field.id]) return stored === "" ? "adopt" : stored === hash ? "current" : "ask";
  return stored === hash ? "current" : "generate";
}

/** A short fingerprint of a text (cyrb53): to tell texts apart, not to protect anything. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** A model's reply as the field's value (null: it found none), or why it doesn't fit. */
export function parseAiReply(output: AiOutput, reply: string): { value: string | number | null } | { error: string } {
  let text = reply.trim();
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(text);
  if (fenced) text = fenced[1].trim();
  // A number that can't be told stays empty (also when the model says "Unknown" anyway).
  if (text === "" || (output === "number" && /^(unknown|n\/a|none|null)\.?$/i.test(text))) return { value: null };
  switch (output) {
    case "number": {
      const n = parseNumber(text);
      return n === null ? { error: `Not a number: ${text.length > 60 ? `${text.slice(0, 59)}…` : text}` } : { value: n };
    }
    case "string":
      return { value: text.replace(/\s*\n+\s*/g, " ").replace(/^["“'](.*)["”']$/, "$1").trim() };
    case "markdown":
      return { value: text };
  }
}

/** The first number in a text, with either "," or "." as decimal separator and the other as thousands separator. */
export function parseNumber(text: string): number | null {
  const token = /-?\d[\d.,]*/.exec(text.replace(/−/g, "-"))?.[0].replace(/[.,]$/, "");
  if (!token) return null;
  const dots = token.split(".").length - 1;
  const commas = token.split(",").length - 1;
  let plain = token;
  if (dots > 0 && commas > 0) {
    // The separator that comes last is the decimal one.
    const decimal = token.lastIndexOf(".") > token.lastIndexOf(",") ? "." : ",";
    plain = token.split(decimal === "." ? "," : ".").join("").replace(decimal, ".");
  } else if (commas > 0) {
    plain = commas === 1 && !/^-?\d{1,3},\d{3}$/.test(token) ? token.replace(",", ".") : token.split(",").join("");
  } else if (dots > 1) {
    plain = token.split(".").join("");
  }
  const n = Number(plain);
  return Number.isFinite(n) ? n : null;
}
