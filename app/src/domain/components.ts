// Components (stored as "components"): Markdown with {{ … }} sections of JavaScript over $variables,
// e.g.  **{{ $title }}** has {{ $pages }} pages, about {{ Math.round($pages / 40) }} h of reading.
// A field of kind "component" (shown as "Component") picks one and maps each $variable to a field
// of its collection, so one component serves any collection; a component that is just {{ … }} works as a
// computed value. A block shows one too: static content, or a summary of the block's items.
// Results are computed whenever items are shown and never stored. Code lives only here (and in
// AI prompts, domain/ai.ts): item values are data, never rendered.
//
// These $ names are built in rather than variables:
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
// (either place: content that is the same everywhere, or a value from its variables). One
// component never uses both $item and a block's names (`mixed`): it fits nowhere.
//
// The code runs in the app itself (new Function), with the user's own rights. That's fine for a
// personal, local app; once components can come from someone else (sync, sharing) they must run
// in a sandbox (a worker or an iframe without access to the app). On the server (the headless
// device computing values for the API) it runs in a separate V8 context with a time limit
// (headless/compiler.ts, through setCompiler).

import { checklistItems } from "./checklist";
import { fileSrc } from "./files";
import type { FieldDef, FieldKind, FieldValue, Item, Collection, ComponentArg } from "./model";

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

export interface Component {
  id: string;
  name: string;
  /** What it is for, shown in the components list; empty when unset. */
  description: string;
  /** The variables the code uses, without their $ (found from the code: parseParams). */
  params: string[];
  /** The component: Markdown with {{ … }} JavaScript sections. */
  code: string;
  output: ComponentOutput;
  /** HTML that fills its box (a map, a chart): that box's shape on pages, e.g. "4/3"; null = 16:9. */
  frameRatio: string | null;
  createdAt: string;
  updatedAt: string;
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

/** The variables of a formula, in order of first use: every $name except the built-ins ($now, $item, $items, …). */
export const parseParams = (component: string): string[] => dollarNames(component).filter((n) => !BUILT_IN.has(n));

/**
 * A component's kind, by the built-ins it uses: "field" ($item) shows one item, as a component
 * field; "block" ($items / $groups / $fields / $all) shows a block's items; "static" (neither)
 * goes in either place.
 */
export type ComponentKind = "field" | "block" | "static";
export const COMPONENT_KINDS: Record<ComponentKind, string> = { field: "Field", block: "Block", static: "Static" };

/** Where a component is shown: as a component field or as a block. */
export type ComponentPlace = "field" | "block";

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

/** Whether a component of this kind fits the place. */
export const fitsPlace = (kind: ComponentKind, place: ComponentPlace) => kind === "static" || kind === place;

/** The components that fit a place (the one already chosen stays offered, so it still shows). */
export const componentsFor = (components: Component[], place: ComponentPlace, chosen?: string | null): Component[] =>
  components.filter((c) => c.id === chosen || placeProblem(c.code, place) === null);

/** Why a component can't be shown in the place (its code's kind doesn't fit), or null when it can. */
export function placeProblem(code: string, place: ComponentPlace): string | null {
  const uses = componentUses(code);
  if (uses.mixed) return "This component uses both $item and a block's $ names: use one or the other";
  if (fitsPlace(uses.kind, place)) return null;
  return place === "field" ? "This component lists items: use it as a block" : "This component shows one item ($item): use it as a field";
}

/** What a component of this kind does and where it goes, as the component editor says it (mixed: why it can't be saved). */
export function kindText(code: string): string {
  const uses = componentUses(code);
  if (uses.mixed) return "Uses $item and a block's $ names together: one item ($item, a field) or a block's items ($items, $groups, $fields, $all), not both.";
  switch (uses.kind) {
    case "field":
      return "Field component: uses $item, so it shows one item, as a component field of a collection.";
    case "block":
      return "Block component: uses a block's items ($items, $groups, $fields or $all), so it is a block on a collection view or an item page.";
    default:
      return "Static component: uses neither $item nor a block's items, so it goes anywhere: a component field (from its variables) or a block.";
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
 * component's $variables (in `params` order). A component that is a single section returns that
 * section's value as is (a number stays a number, so it sorts as one); otherwise each section's
 * result is put into the text. A failing section shows as "⚠ message".
 */
export function render(
  component: Pick<Component, "params" | "code"> & { output?: ComponentOutput },
  args: unknown[],
  item?: Item,
  fields?: FieldLookup,
  block?: BlockInputs,
): FieldValue {
  return asOutput(component.output ?? "markdown", renderRaw(component, args, item, fields, block));
}

function renderRaw(component: Pick<Component, "params" | "code">, args: unknown[], item?: Item, fields?: FieldLookup, block?: BlockInputs): FieldValue {
  const whole = /^\s*\{\{([\s\S]*?)\}\}\s*$/.exec(component.code);
  if (whole && !whole[1].includes("}}")) return evaluate({ params: component.params, code: whole[1] }, args, item, fields, block);
  if (!component.code.trim()) return null;
  return component.code.replace(SECTION, (_, code: string) => {
    const v = evaluate({ params: component.params, code }, args, item, fields, block);
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

/** Shapes offered for HTML that fills its box. */
export const FRAME_RATIOS = ["16/9", "21/9", "3/2", "4/3", "1/1", "3/4"];

/** A stored ratio ("4/3") as a number; null when absent or unreadable. */
export function ratioValue(ratio: string | null | undefined): number | null {
  const m = /^\s*([\d.]+)\s*(?:\/\s*([\d.]+))?\s*$/.exec(ratio ?? "");
  const n = m ? Number(m[1]) / Number(m[2] ?? 1) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The output type of a component field's component (Markdown when it has none). */
export const outputOf = (field: FieldDef, components: Component[]): ComponentOutput =>
  components.find((t) => t.id === field.componentId)?.output ?? "markdown";

type Compiled = (...args: unknown[]) => unknown;
/** Turns a function body with these parameter names into a function; throws on a syntax error. */
export type Compiler = (params: string[], body: string) => Compiled;
let compiler: Compiler = (params, body) => new Function(...params, body) as Compiled;

/** Replaces how section code is compiled (the server's headless device: a separate context). */
export function setCompiler(next: Compiler) {
  compiler = next;
  compiled.clear();
}

/** Compiled sections by parameters and code; bounded (the component editor compiles on every keystroke). */
const compiled = new Map<string, Compiled | Error>();
const COMPILED_MAX = 500;

function compile(params: string[], code: string): Compiled | Error {
  const key = `${params.join(",")}|${code}`;
  let fn = compiled.get(key);
  if (!fn) {
    try {
      fn = compiler([...params.map((p) => `$${p}`), "$item", "$now", "$items", "$groups", "$fields", "$all"], `"use strict"; return (${code});`);
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

/**
 * Runs a section with values for its variables (in `params` order); $item is the item with its
 * fields (from `fields`). Errors become an error text.
 */
export function evaluate(
  component: Pick<Component, "params" | "code">,
  args: unknown[],
  item?: Item,
  fields?: FieldLookup,
  block?: BlockInputs,
): FieldValue {
  if (!component.code.trim()) return null;
  const fn = compile(component.params, component.code);
  if (fn instanceof Error) return ERROR_PREFIX + fn.message;
  try {
    // Outside a block its built-ins are empty, not undefined: `$items.length` reads 0.
    const b = block ?? NO_BLOCK;
    return toValue(fn(...args, itemValue(item, fields), new Date(), b.items, b.groups, b.fields, b.all));
  } catch (e) {
    return ERROR_PREFIX + (e instanceof Error ? e.message : String(e));
  }
}

/** Label of a referenced item, for reference fields feeding a variable. */
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
function renderField(component: Component, args: unknown[], item: Item, fields: FieldLookup): FieldValue {
  const problem = placeProblem(component.code, "field");
  return problem ? ERROR_PREFIX + problem : render(component, args, item, fields);
}

/** A block component's variable: a fixed value (a number when it reads as one), or a field's name (which field to use). */
export function blockArgValue(arg: ComponentArg | undefined, fieldsById: Map<string, { name: string }>): unknown {
  if (!arg) return null;
  if ("field" in arg) return fieldsById.get(arg.field)?.name ?? null;
  const s = arg.value.trim();
  return s === "" ? null : Number.isFinite(Number(s)) ? Number(s) : arg.value;
}

/** A variable's value: its field's (as a component sees it), or its fixed value (a number when it reads as one). */
function argValue(arg: ComponentArg | undefined, fieldsById: Map<string, FieldDef>, values: Record<string, FieldValue>, refLabel: RefLabel): unknown {
  if (!arg) return null;
  if ("field" in arg) return inputOf(fieldsById.get(arg.field), values[arg.field], refLabel);
  const s = arg.value.trim();
  return s === "" ? null : Number.isFinite(Number(s)) ? Number(s) : arg.value;
}

/**
 * Items with their component fields filled in, computed in field order (so a component can use the
 * result of an earlier one). A variable gets its mapped field's value (references as the linked
 * items' labels), or null when unmapped. Without component fields the items are returned as
 * they are.
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
  if (!collection.fields.some((f) => f.kind === "component")) return items;
  const byId = new Map(components.map((x) => [x.id, x]));
  const fieldsById = new Map(collection.fields.map((f) => [f.id, f]));
  const compute = (item: Item): Item => {
    const values = { ...item.values };
    const lookup = lookupIn(collection, values, refLabel);
    for (const f of collection.fields) {
      if (f.kind !== "component") continue;
      const x = f.componentId ? byId.get(f.componentId) : undefined;
      values[f.id] = x ? renderField(x, x.params.map((p) => argValue(f.componentArgs[p], fieldsById, values, refLabel)), item, lookup) : null;
    }
    return { ...item, values };
  };
  if (!memo) return items.map(compute);
  return items.map((item) => {
    let result = memo.get(item);
    if (!result) memo.set(item, (result = compute(item)));
    return result;
  });
}
