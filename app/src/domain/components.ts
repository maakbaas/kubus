// Components (stored as "components"): Markdown with {{ … }} sections of JavaScript over the
// built-in $ names, e.g.  **{{ $item.Title }}** has {{ $item.Pages }} pages. A field of kind
// "component" (shown as "Component") shows one; a component that is just {{ … }} works as a computed
// value. A block shows one too: static content, or a summary of the block's items. Results are
// computed whenever items are shown and never stored, except an AI component's (`ai`): its rendered
// text is a prompt, and the model's reply is the value of an AI field, stored per item (domain/ai.ts).
// Code lives only here: item values are data, never rendered.
//
// A component is shared (a row of the components table, picked by name in many places) or local:
// written in place, owned by that one place and stored with it (a field's `code`, a component
// block's `local`, a Markdown block's text). Local ones are listed with the shared ones, by where
// they are used (componentPlaces), and can be promoted to shared.
//
// These $ names are built in (there are no others):
//   $now    the current Date
//   $item   the item itself (like n8n's $json): its fields by name, $item.Pages or
//           $item["Read at"] (case-insensitive), plus $item.id / createdAt / updatedAt.
//   $items  a block's items (filtered, sorted), each like $item
//   $groups a block's groups: [{ key, label, items }] (one with key "" when not grouped)
//   $fields a block's shown fields: [{ id, name, kind }]
//   $all    every item of the block's collection (in the shown space), unfiltered
// What a component uses decides its kind and so where it can go (componentUses): with $item it
// is a field component (a component field); with $items / $groups / $fields / $all a block
// component (a block, whose filter, sort and fields then apply); with neither it is static
// (content that is the same everywhere: a block, or a Markdown block's text; not a field, where
// it would be the same for every item). One component never
// uses both $item and a block's names (`mixed`): it fits nowhere.
//
// The code runs in the app itself (new Function), with the user's own rights. That's fine for a
// personal, local app. On the server (the headless
// device computing values for the API) it runs in a separate V8 context with a time limit
// (headless/compiler.ts, through setCompiler).

import { checklistItems } from "./checklist";
import { fileSrc } from "./files";
import type { AiOutput, FieldDef, FieldKind, FieldValue, Item, Collection } from "./model";

/**
 * What a component's result is, and so how it shows: Markdown (rendered), plain text, a number
 * (sorts and filters as one), an image (the result is its URL) or HTML (rendered in a sandboxed
 * frame, scripts allowed: maps, charts, …).
 */
export type ComponentOutput = "markdown" | "string" | "number" | "image" | "html";
export const COMPONENT_OUTPUTS: { value: ComponentOutput; text: string }[] = [
  { value: "markdown", text: "Markdown" },
  { value: "string", text: "Text" },
  { value: "number", text: "Number" },
  { value: "image", text: "Image (URL)" },
  { value: "html", text: "HTML" },
];
export const isComponentOutput = (v: unknown): v is ComponentOutput => COMPONENT_OUTPUTS.some((o) => o.value === v);

/** What a component is, shared or local: its code and how its result shows. */
export interface ComponentCode {
  /** The component: Markdown (or HTML) with {{ … }} JavaScript sections. */
  code: string;
  output: ComponentOutput;
  /** HTML that fills its box (a map, a chart): that box's shape on pages, e.g. "4/3"; null = 16:9. */
  frameRatio: string | null;
  /**
   * "AI prompt": the rendered text is a prompt, and the model's reply is the value (only for AI
   * fields, stored per item; outputs text, a number or Markdown). Fixed once a field uses it.
   */
  ai: boolean;
}

/** A shared component: one row of the components table, picked by name wherever it fits. */
export interface Component extends ComponentCode {
  id: string;
  name: string;
  /** What it is for, shown in the components list; empty when unset. */
  description: string;
  createdAt: string;
  updatedAt: string;
}

/** The outputs an AI component's value can have (what an AI field stores). */
export const AI_COMPONENT_OUTPUTS: ComponentOutput[] = ["string", "number", "markdown"];
export const isAiOutput = (o: ComponentOutput): o is AiOutput => AI_COMPONENT_OUTPUTS.includes(o);

/**
 * A field's component: its own (local) one, else the shared one it picks (undefined: none chosen,
 * or gone). An AI field's output is its own, also with a shared component (fixed once saved).
 */
export function fieldComponent(field: FieldDef, components: Component[]): ComponentCode | undefined {
  if (field.code !== null) return { code: field.code, output: field.output ?? "markdown", frameRatio: field.frameRatio, ai: field.kind === "ai" };
  const shared = field.componentId ? components.find((c) => c.id === field.componentId) : undefined;
  return shared && field.kind === "ai" ? { ...shared, output: field.output ?? shared.output } : shared;
}

/** Shown instead of a value when a component fails (and used to recognise such results). */
export const ERROR_PREFIX = "⚠ ";

/**
 * Brackets a failing section's warning inside a longer result (an invisible separator on both
 * sides), so it can be shown as a warning there too; a result that is only a warning starts
 * with ERROR_PREFIX instead.
 */
export const WARNING_MARK = "⁣";

/** A text as [plain, warning, plain, warning, …]: the warnings without their "⚠ ". */
export function splitWarnings(text: string): string[] {
  if (text.startsWith(ERROR_PREFIX)) return ["", text.slice(ERROR_PREFIX.length), ""];
  if (!text.includes(WARNING_MARK)) return [text];
  return text.split(new RegExp(`${WARNING_MARK}(?:${ERROR_PREFIX})?`));
}

const BUILT_IN = new Set(["now", "item", "items", "groups", "fields", "all"]);

/** The $ names the code uses that aren't built in (there are no variables: fields are read through $item). */
export const unknownNames = (component: string): string[] => dollarNames(component).filter((n) => !BUILT_IN.has(n));

/**
 * A component's kind, by the built-ins it uses: "field" ($item) shows one item, as a component
 * field; "block" ($items / $groups / $fields / $all) shows a block's items; "static" (neither)
 * goes in either place.
 */
export type ComponentKind = "field" | "block" | "static";
export const COMPONENT_KINDS: Record<ComponentKind, string> = { field: "Field", block: "Block", static: "Static" };

/**
 * Where a component is shown: as a component field, as a block, or as a Markdown block's text
 * (static only: the same content wherever it is).
 */
export type ComponentPlace = "field" | "block" | "static";

const BLOCK_NAMES = ["items", "groups", "fields", "all"];

/**
 * What a component's code uses: its kind; `mixed` when it uses $item and a block's names together
 * (fits nowhere); of a block: its items (filter and sort apply), their groups (grouping applies)
 * and its fields.
 */
export function componentUses(code: string): { kind: ComponentKind; mixed: boolean; items: boolean; groups: boolean; fields: boolean } {
  const names = new Set(dollarNames(code));
  const groups = names.has("groups");
  const items = names.has("items") || groups;
  const fields = names.has("fields");
  const block = BLOCK_NAMES.some((n) => names.has(n));
  const item = names.has("item");
  return { kind: item ? "field" : block ? "block" : "static", mixed: item && block, items, groups, fields };
}

/**
 * Whether a component of this kind fits the place: a field component a field, a block component a
 * block, a static one a block or a Markdown block's text (as a field it would be the same for every
 * item).
 */
export const fitsPlace = (kind: ComponentKind, place: ComponentPlace) => kind === place || (kind === "static" && place !== "field");

/** The components that fit a place (the one already chosen stays offered, so it still shows); for a field, only AI ones or only others. */
export const componentsFor = (components: Component[], place: ComponentPlace, chosen?: string | null, ai = false): Component[] =>
  components.filter((c) => c.id === chosen || (c.ai === ai && placeProblem(c, place) === null));

/** Why code can't be a component at all (an unknown $ name, or $item with a block's names), or null. */
export function codeProblem(code: string): string | null {
  const unknown = unknownNames(code)[0];
  if (unknown) return `$${unknown} isn't known: read a field as $item.Name (there are no other variables)`;
  if (componentUses(code).mixed) return "This component uses both $item and a block's $ names: use one or the other";
  return null;
}

/**
 * Why a component can't be shown in the place (its code's kind doesn't fit, or it asks AI where
 * nothing stores a reply), or null when it can.
 */
export function placeProblem(component: Pick<ComponentCode, "code" | "ai">, place: ComponentPlace): string | null {
  const problem = codeProblem(component.code);
  if (problem) return problem;
  if (component.ai) {
    if (place !== "field") return "An AI component fills a field: its reply is stored per item";
    const names = dollarNames(component.code);
    if (names.includes("now")) return "$now isn't available in an AI prompt: it changes all the time, so the value would never be up to date";
  }
  const { kind } = componentUses(component.code);
  if (fitsPlace(kind, place)) return null;
  if (place === "static") return kind === "field" ? "Text here is the same everywhere: $item isn't available" : "Text here is the same everywhere: a block's $ names aren't available";
  if (place === "field") return kind === "block" ? "This component lists items: use it as a block" : "This component doesn't read the item ($item): it would be the same for every item, so use it as a block";
  return "This component shows one item ($item): use it as a field";
}

/**
 * Why a component or AI field's component can't be used (none chosen, nothing written, code that
 * doesn't fit a field, a prompt that can't be one), or null; null for other fields.
 */
export function fieldComponentProblem(
  field: Pick<FieldDef, "kind" | "componentId" | "code" | "output" | "frameRatio">,
  components: Component[],
): string | null {
  if (field.kind !== "component" && field.kind !== "ai") return null;
  const ai = field.kind === "ai";
  if (field.code === null && !field.componentId) return ai ? "Choose a prompt, or write it here" : "Choose a component, or write it here";
  const component = fieldComponent(field as FieldDef, components);
  if (!component) return "The component is gone: choose another";
  if (!component.code.trim()) return ai ? "Write the prompt" : "Write the component";
  if (ai && !isAiOutput(component.output)) return "An AI value is text, a number or Markdown";
  return placeProblem({ ...component, ai }, "field");
}

/** What a component of this kind does and where it goes, as the component editor says it (mixed: why it can't be saved). */
export function kindText(code: string, ai = false): string {
  const uses = componentUses(code);
  if (uses.mixed) return "Uses $item and a block's $ names together: one item ($item, a field) or a block's items ($items, $groups, $fields, $all), not both.";
  if (ai) return "AI component: its text is the prompt, sent to the language model for each item; the reply is an AI field's value, stored.";
  switch (uses.kind) {
    case "field":
      return "Field component: uses $item, so it shows one item, as a component field of a collection.";
    case "block":
      return "Block component: uses a block's items ($items, $groups, $fields or $all), so it is a block on a collection view or an item page.";
    default:
      return "Static component: uses neither $item nor a block's items, so it is the same everywhere: a block (a field reads its item with $item).";
  }
}

/** What a block gives its component: the built-ins beyond $item and $now. */
export interface BlockInputs {
  items: unknown[];
  groups: { key: string; label: string; items: unknown[] }[];
  fields: { id: string; name: string; kind: FieldKind }[];
  all: unknown[];
}

/** Every $name the sections use, in order of first use. Quoted strings are skipped, so "costs $5" or '$x' don't count. */
export function dollarNames(component: string): string[] {
  const names = sections(component).flatMap((code) => {
    // Text in quotes doesn't count, but the ${…} parts of a `template literal` are code.
    const unquoted = code
      .replace(/`(?:\\.|[^`\\])*`/g, (literal) => [...literal.matchAll(/\$\{([^}]*)\}/g)].map((m) => ` ${m[1]} `).join(""))
      .replace(/(["'])(?:\\.|(?!\1)[^\\])*\1/g, "");
    return [...unquoted.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  });
  return [...new Set(names)];
}

/** The `{{ … }}` sections of a component: the JavaScript between the braces. */
const SECTION = /\{\{([\s\S]*?)\}\}/g;
const sections = (component: string) => [...component.matchAll(SECTION)].map((m) => m[1]);

/**
 * Renders a component: Markdown with `{{ … }}` sections, each a JavaScript expression over the
 * built-in $ names. A component that is a single section returns that
 * section's value as is (a number stays a number, so it sorts as one); otherwise each section's
 * result is put into the text. A failing section shows as "⚠ message".
 */
export function render(component: { code: string; output?: ComponentOutput }, item?: Item, fields?: FieldLookup, block?: BlockInputs): FieldValue {
  return asOutput(component.output ?? "markdown", renderRaw(component.code, item, fields, block));
}

function renderRaw(text: string, item?: Item, fields?: FieldLookup, block?: BlockInputs): FieldValue {
  const unknown = unknownNames(text)[0];
  if (unknown) return `${ERROR_PREFIX}$${unknown} isn't known: read a field as $item.Name`;
  const whole = /^\s*\{\{([\s\S]*?)\}\}\s*$/.exec(text);
  if (whole && !whole[1].includes("}}")) return evaluate(whole[1], item, fields, block);
  if (!text.trim()) return null;
  return text.replace(SECTION, (_, code: string) => {
    const v = evaluate(code, item, fields, block);
    return v == null ? "" : isComponentError(v) ? `${WARNING_MARK}${v}${WARNING_MARK}` : String(v);
  });
}

/**
 * The item's fields by name, as $item shows them: `names` for listing, `get` for one field's
 * value (looked up only when a section reads it, and current: it sees results computed so far).
 */
export interface FieldLookup {
  names: string[];
  get(name: string): unknown;
}

/**
 * $item: the item's fields by name plus id / createdAt / updatedAt; a name that isn't found
 * as written is looked up case-insensitively ($item.pages finds "Pages"). Fields are resolved
 * on access, so a section reading one field doesn't compute all of them.
 */
function itemValue(item: Item | undefined, fields: FieldLookup | undefined): Record<string, unknown> {
  const meta: Record<string, unknown> = item ? { id: item.id, createdAt: item.createdAt, updatedAt: item.updatedAt } : {};
  const names = fields?.names ?? [];
  const exact = new Set(names);
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const resolve = (key: string) => (exact.has(key) ? key : lower.get(key.toLowerCase()));
  return new Proxy(meta, {
    get: (t, key) => {
      if (typeof key !== "string") return Reflect.get(t, key);
      const name = resolve(key);
      if (name !== undefined && fields) return fields.get(name);
      return Reflect.get(t, key);
    },
    has: (t, key) => (typeof key === "string" && resolve(key) !== undefined) || Reflect.has(t, key),
    // Listing it (Object.keys, JSON.stringify) shows the fields as well.
    ownKeys: (t) => [...new Set([...Reflect.ownKeys(t), ...names])],
    getOwnPropertyDescriptor: (t, key) =>
      typeof key === "string" && exact.has(key) && fields
        ? { value: fields.get(key), enumerable: true, configurable: true, writable: false }
        : Reflect.getOwnPropertyDescriptor(t, key),
  });
}

/** Whether a result is an error text ("⚠ message"). */
export const isComponentError = (v: FieldValue | undefined) => typeof v === "string" && v.startsWith(ERROR_PREFIX);

/** A result as the component's output type: a number for "number" (else an error), text otherwise. */
function asOutput(output: ComponentOutput, v: FieldValue): FieldValue {
  if (v == null || isComponentError(v)) return v;
  const text = String(v).trim();
  switch (output) {
    case "number": {
      if (typeof v === "number") return v;
      if (text === "") return null;
      const n = Number(text);
      return Number.isFinite(n) ? n : `${ERROR_PREFIX}Not a number: ${text}`;
    }
    case "image":
      return text || null;
    case "markdown":
      return v; // a lone {{ }} keeps its value (numbers sort as numbers)
    default:
      return String(v);
  }
}

/** The output type of a component field's component (Markdown when it has none). */
export const outputOf = (field: FieldDef, components: Component[]): ComponentOutput => fieldComponent(field, components)?.output ?? "markdown";

type Compiled = (...args: unknown[]) => unknown;
/** Turns a function body with these parameter names into a function; throws on a syntax error. */
export type Compiler = (params: string[], body: string) => Compiled;
let compiler: Compiler = (params, body) => new Function(...params, body) as Compiled;

/** Replaces how section code is compiled (the server's headless device: a separate context). */
export function setCompiler(next: Compiler) {
  compiler = next;
  compiled.clear();
}

/** Compiled sections by code; bounded (the component editor compiles on every keystroke). */
const compiled = new Map<string, Compiled | Error>();
const COMPILED_MAX = 500;

function compile(code: string): Compiled | Error {
  const key = code;
  let fn = compiled.get(key);
  if (!fn) {
    try {
      fn = compiler(["$item", "$now", "$items", "$groups", "$fields", "$all"], `"use strict"; return (${code});`);
    } catch (e) {
      fn = e instanceof Error ? e : new Error(String(e));
    }
    if (compiled.size >= COMPILED_MAX) compiled.delete(compiled.keys().next().value!);
    compiled.set(key, fn);
  }
  return fn;
}

/** A result as a field value: numbers, booleans and strings stay; other values become text. */
function toValue(result: unknown): FieldValue {
  if (result == null || (typeof result === "number" && !Number.isFinite(result))) return null;
  if (typeof result === "number" || typeof result === "boolean" || typeof result === "string") return result;
  if (result instanceof Date) return Number.isNaN(result.getTime()) ? null : result.toISOString();
  if (Array.isArray(result)) return result.map((x) => (x != null && typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ");
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/** Runs a section (one expression); $item is the item with its fields (from `fields`). Errors become an error text. */
export function evaluate(code: string, item?: Item, fields?: FieldLookup, block?: BlockInputs): FieldValue {
  if (!code.trim()) return null;
  const fn = compile(code);
  if (fn instanceof Error) return ERROR_PREFIX + fn.message;
  try {
    // Outside a block its built-ins are empty, not undefined: `$items.length` reads 0.
    const b = block ?? NO_BLOCK;
    return toValue(fn(itemValue(item, fields), new Date(), b.items, b.groups, b.fields, b.all));
  } catch (e) {
    return ERROR_PREFIX + (e instanceof Error ? e.message : String(e));
  }
}

/** Label of a referenced item, as $item shows a reference field. */
export type RefLabel = (field: FieldDef, itemId: string) => string;

/**
 * A field's value as a component sees it: references as the linked items' labels, images as
 * their src (`files/<sha256>`), usable as is in Markdown, <img src> and an image output,
 * checklists as their items ({ text, done }[]).
 */
function inputOf(field: FieldDef | undefined, value: FieldValue | undefined, refLabel: RefLabel): unknown {
  if (!field || value == null) return null;
  if (field.kind === "image" && typeof value === "string") return fileSrc(value);
  if (field.kind === "checklist") return checklistItems(value);
  if (field.kind === "item" && typeof value === "string") return refLabel(field, value);
  if (field.kind === "item_list" && Array.isArray(value)) return value.map((id) => refLabel(field, id));
  return value;
}

/** The item's fields by name, read from `values` when asked (so results computed so far count). */
function lookupIn(collection: Collection, values: Record<string, FieldValue>, refLabel: RefLabel): FieldLookup {
  const byName = new Map(collection.fields.map((f) => [f.name, f]));
  return {
    names: [...byName.keys()],
    get: (name) => {
      const f = byName.get(name);
      return f ? inputOf(f, values[f.id], refLabel) : undefined;
    },
  };
}

const NO_BLOCK: BlockInputs = { items: [], groups: [], fields: [], all: [] };

/**
 * Items as a block's component sees them, each like $item (fields by name, computed results
 * included): made once per item, so an item in $items, a group and $all is the same object.
 */
export function itemsInput(collection: Collection, refLabel: RefLabel): (item: Item) => unknown {
  const made = new Map<Item, unknown>();
  return (item) => {
    let v = made.get(item);
    if (v === undefined) made.set(item, (v = itemValue(item, lookupIn(collection, item.values, refLabel))));
    return v;
  };
}

/** The item's fields by name, as $item shows them (the component editor's preview item). */
export const fieldLookup = (collection: Collection, item: Item, refLabel: RefLabel): FieldLookup => lookupIn(collection, item.values, refLabel);

/** A component field's value: the component rendered for the item, or a warning when it doesn't fit a field. */
function renderField(component: ComponentCode, item: Item, fields: FieldLookup): FieldValue {
  const problem = placeProblem(component, "field");
  return problem ? ERROR_PREFIX + problem : render(component, item, fields);
}

/**
 * Items with their component fields filled in, computed in field order (so a component can use the
 * result of an earlier one). Without component fields the items are returned as they are.
 *
 * `memo` keeps each item's result: pass the same map for as long as the collection, the components and
 * the reference labels are the same, and only items that changed (a new instance) are computed
 * again. Its entries are keyed by item, so they go with the items.
 */
export function withComputed(
  collection: Collection,
  items: Item[],
  components: Component[],
  refLabel: RefLabel,
  memo?: WeakMap<Item, Item>,
): Item[] {
  const computed = collection.fields.flatMap((f) => (f.kind === "component" ? [[f, fieldComponent(f, components)] as const] : []));
  if (computed.length === 0) return items;
  const compute = (item: Item): Item => {
    const values = { ...item.values };
    const lookup = lookupIn(collection, values, refLabel);
    for (const [f, x] of computed) values[f.id] = x ? renderField(x, item, lookup) : null;
    return { ...item, values };
  };
  if (!memo) return items.map(compute);
  return items.map((item) => {
    let result = memo.get(item);
    if (!result) memo.set(item, (result = compute(item)));
    return result;
  });
}

/** Where a local component lives: a field of a collection, or a block of a collection view or an item view. */
export type LocalOwner =
  | { type: "field"; collectionId: string; fieldId: string }
  | { type: "view"; collectionId: string; viewId: string; blockId: string; markdown: boolean }
  | { type: "itemView"; collectionId: string; itemViewId: string; blockId: string; markdown: boolean };

/** A local component (written in place), as the Components page lists it: by where it is used. */
export interface LocalComponent {
  /** Unique among them (the owner's ids). */
  key: string;
  component: ComponentCode;
  owner: LocalOwner;
  /** Where it is used, for people: "Books › Reading time", "Books › All › Notes". */
  where: string;
  /** Where to edit it (its collection's settings, its view), or null when there is no one place. */
  href: string | null;
}

/** The parts of a view this needs (domain/views.ts's CollectionView, without importing views here). */
interface ViewLike {
  id: string;
  collectionId: string;
  name: string;
  blocks: { id: string; title: string; kind: string; options: unknown }[];
}

/**
 * Every local component: the code of component and AI fields written in place, of component blocks
 * with their own component, and of Markdown blocks whose text holds {{ }} sections (plain text
 * isn't code), in collection views and item views. `views` are all collection views (every space).
 */
export function localComponents(collections: Collection[], views: ViewLike[]): LocalComponent[] {
  const out: LocalComponent[] = [];
  const byId = new Map(collections.map((c) => [c.id, c]));
  const blockLocal = (block: ViewLike["blocks"][number]): { component: ComponentCode; markdown: boolean } | null => {
    const o = (block.options ?? {}) as { local?: Partial<ComponentCode> | null; text?: unknown };
    if (block.kind === "component" && o.local && typeof o.local.code === "string") {
      return { component: { code: o.local.code, output: isComponentOutput(o.local.output) ? o.local.output : "markdown", frameRatio: o.local.frameRatio ?? null, ai: false }, markdown: false };
    }
    if (block.kind === "markdown" && typeof o.text === "string" && /\{\{[\s\S]*?\}\}/.test(o.text)) {
      return { component: { code: o.text, output: "markdown", frameRatio: null, ai: false }, markdown: true };
    }
    return null;
  };
  const blockName = (block: ViewLike["blocks"][number], markdown: boolean) => block.title || (markdown ? "Markdown" : "Component");
  for (const c of collections) {
    for (const f of c.fields) {
      if ((f.kind === "component" || f.kind === "ai") && f.code !== null) {
        out.push({
          key: `field:${f.id}`,
          component: { code: f.code, output: f.output ?? (f.kind === "ai" ? "string" : "markdown"), frameRatio: f.frameRatio, ai: f.kind === "ai" },
          owner: { type: "field", collectionId: c.id, fieldId: f.id },
          where: `${c.pluralName} › ${f.name}`,
          href: `#/collections/${c.id}/edit?field=${encodeURIComponent(f.id)}`,
        });
      }
    }
    for (const v of c.itemViews) {
      for (const b of v.layout.blocks) {
        const local = blockLocal(b);
        if (!local) continue;
        out.push({
          key: `itemView:${v.id}:${b.id}`,
          component: local.component,
          owner: { type: "itemView", collectionId: c.id, itemViewId: v.id, blockId: b.id, markdown: local.markdown },
          where: `${c.name} pages › ${v.name} › ${blockName(b, local.markdown)}`,
          href: null,
        });
      }
    }
  }
  for (const v of views) {
    const c = byId.get(v.collectionId);
    if (!c) continue;
    for (const b of v.blocks) {
      const local = blockLocal(b);
      if (!local) continue;
      out.push({
        key: `view:${v.id}:${b.id}`,
        component: local.component,
        owner: { type: "view", collectionId: c.id, viewId: v.id, blockId: b.id, markdown: local.markdown },
        where: `${c.pluralName} › ${v.name} › ${blockName(b, local.markdown)}`,
        href: `#/collections/${c.id}/items?view=${encodeURIComponent(v.id)}&block=${encodeURIComponent(b.id)}`,
      });
    }
  }
  return out;
}
