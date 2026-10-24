// Templates (stored as "templates"): Markdown with {{ … }} sections of JavaScript over $variables,
// e.g.  **{{ $title }}** has {{ $pages }} pages, about {{ Math.round($pages / 40) }} h of reading.
// A field of kind "template" (shown as "Template") picks one and maps each $variable to a field
// of its type, so one template serves any type; a template that is just {{ … }} works as a
// computed value. Later the same templates render whole objects or query results. Results are
// computed whenever objects are shown and never stored.
//
// Two $ names are built in rather than variables:
//   $now    the current Date
//   $object  the object itself (like n8n's $json): its fields by name, $object.Pages or
//           $object["Read at"] (case-insensitive), plus $object.id / createdAt / updatedAt.
// $object needs no mapping, so it also works in {{ }} sections typed into an object's own text,
// markdown or number values (rendered when shown, the typed source kept for editing).
//
// The code runs in the app itself (new Function), with the user's own rights. That's fine for a
// personal, local app; once templates can come from someone else (sync, sharing) they must run
// in a sandbox (a worker or an iframe without access to the app).

import { checklistItems } from "./checklist";
import { fileSrc } from "./files";
import type { FieldDef, FieldKind, FieldValue, ObjectInstance, ObjectType, TemplateArg } from "./model";

/**
 * What a template's result is, and so how it shows: Markdown (rendered), plain text, a number
 * (sorts and filters as one), an image (the result is its URL) or HTML (rendered in a sandboxed
 * frame, scripts allowed: maps, charts, …).
 */
export type TemplateOutput = "markdown" | "string" | "number" | "image" | "html";
export const TEMPLATE_OUTPUTS: { value: TemplateOutput; text: string }[] = [
  { value: "markdown", text: "Markdown" },
  { value: "string", text: "Text" },
  { value: "number", text: "Number" },
  { value: "image", text: "Image (URL)" },
  { value: "html", text: "HTML" },
];
export const isTemplateOutput = (v: unknown): v is TemplateOutput => TEMPLATE_OUTPUTS.some((o) => o.value === v);

export interface Template {
  id: string;
  name: string;
  /** The variables the code uses, without their $ (found from the code: parseParams). */
  params: string[];
  /** The template: Markdown with {{ … }} JavaScript sections. */
  code: string;
  output: TemplateOutput;
  /** HTML that fills its box (a map, a chart): that box's shape on pages, e.g. "4/3"; null = 16:9. */
  frameRatio: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Shown instead of a value when a template fails (and used to recognise such results). */
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

const BUILT_IN = new Set(["now", "object"]);

/**
 * The variables of a formula, in order of first use: every $name except the built-ins $now and
 * $object. Quoted strings are skipped, so "costs $5" or '$x' don't count.
 */
export function parseParams(template: string): string[] {
  const names = sections(template).flatMap((code) => {
    // Text in quotes doesn't count, but the ${…} parts of a `template literal` are code.
    const unquoted = code
      .replace(/`(?:\\.|[^`\\])*`/g, (literal) => [...literal.matchAll(/\$\{([^}]*)\}/g)].map((m) => ` ${m[1]} `).join(""))
      .replace(/(["'])(?:\\.|(?!\1)[^\\])*\1/g, "");
    return [...unquoted.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]).filter((n) => !BUILT_IN.has(n));
  });
  return [...new Set(names)];
}

/** The `{{ … }}` sections of a template: the JavaScript between the braces. */
const SECTION = /\{\{([\s\S]*?)\}\}/g;
const sections = (template: string) => [...template.matchAll(SECTION)].map((m) => m[1]);

/**
 * Renders a template: Markdown with `{{ … }}` sections, each a JavaScript expression over the
 * template's $variables (in `params` order). A template that is a single section returns that
 * section's value as is (a number stays a number, so it sorts as one); otherwise each section's
 * result is put into the text. A failing section shows as "⚠ message".
 */
export function render(
  template: Pick<Template, "params" | "code"> & { output?: TemplateOutput },
  args: unknown[],
  object?: ObjectInstance,
  fields?: FieldLookup,
): FieldValue {
  return asOutput(template.output ?? "markdown", renderRaw(template, args, object, fields));
}

function renderRaw(template: Pick<Template, "params" | "code">, args: unknown[], object?: ObjectInstance, fields?: FieldLookup): FieldValue {
  const whole = /^\s*\{\{([\s\S]*?)\}\}\s*$/.exec(template.code);
  if (whole && !whole[1].includes("}}")) return evaluate({ params: template.params, code: whole[1] }, args, object, fields);
  if (!template.code.trim()) return null;
  return template.code.replace(SECTION, (_, code: string) => {
    const v = evaluate({ params: template.params, code }, args, object, fields);
    return v == null ? "" : isTemplateError(v) ? `${WARNING_MARK}${v}${WARNING_MARK}` : String(v);
  });
}

/**
 * The object's fields by name, as $object shows them: `names` for listing, `get` for one field's
 * value (looked up only when a section reads it, and current: it sees results computed so far).
 */
export interface FieldLookup {
  names: string[];
  get(name: string): unknown;
}

/**
 * $object: the object's fields by name plus id / createdAt / updatedAt; a name that isn't found
 * as written is looked up case-insensitively ($object.pages finds "Pages"). Fields are resolved
 * on access, so a section reading one field doesn't compute all of them.
 */
function objectValue(object: ObjectInstance | undefined, fields: FieldLookup | undefined): Record<string, unknown> {
  const meta: Record<string, unknown> = object ? { id: object.id, createdAt: object.createdAt, updatedAt: object.updatedAt } : {};
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
export const isTemplateError = (v: FieldValue | undefined) => typeof v === "string" && v.startsWith(ERROR_PREFIX);

/** A result as the template's output type: a number for "number" (else an error), text otherwise. */
function asOutput(output: TemplateOutput, v: FieldValue): FieldValue {
  if (v == null || isTemplateError(v)) return v;
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

/** The output type of a template field's template (Markdown when it has none). */
export const outputOf = (field: FieldDef, templates: Template[]): TemplateOutput =>
  templates.find((t) => t.id === field.templateId)?.output ?? "markdown";

type Compiled = (...args: unknown[]) => unknown;
/** Compiled sections by parameters and code; bounded (the template editor compiles on every keystroke). */
const compiled = new Map<string, Compiled | Error>();
const COMPILED_MAX = 500;

function compile(params: string[], code: string): Compiled | Error {
  const key = `${params.join(",")}|${code}`;
  let fn = compiled.get(key);
  if (!fn) {
    try {
      fn = new Function(...params.map((p) => `$${p}`), "$object", "$now", `"use strict"; return (${code});`) as Compiled;
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
 * Runs a section with values for its variables (in `params` order); $object is the object with its
 * fields (from `fields`). Errors become an error text.
 */
export function evaluate(template: Pick<Template, "params" | "code">, args: unknown[], object?: ObjectInstance, fields?: FieldLookup): FieldValue {
  if (!template.code.trim()) return null;
  const fn = compile(template.params, template.code);
  if (fn instanceof Error) return ERROR_PREFIX + fn.message;
  try {
    return toValue(fn(...args, objectValue(object, fields), new Date()));
  } catch (e) {
    return ERROR_PREFIX + (e instanceof Error ? e.message : String(e));
  }
}

/** Label of a referenced object, for reference fields feeding a variable. */
export type RefLabel = (field: FieldDef, objectId: string) => string;

/**
 * A field's value as a template sees it: references as the linked objects' labels, images as
 * their src (`files/<sha256>`), usable as is in Markdown, <img src> and an image output,
 * checklists as their items ({ text, done }[]).
 */
function inputOf(field: FieldDef | undefined, value: FieldValue | undefined, refLabel: RefLabel): unknown {
  if (!field || value == null) return null;
  if (field.kind === "image" && typeof value === "string") return fileSrc(value);
  if (field.kind === "checklist") return checklistItems(value);
  if (field.kind === "object" && typeof value === "string") return refLabel(field, value);
  if (field.kind === "object_list" && Array.isArray(value)) return value.map((id) => refLabel(field, id));
  return value;
}

/** The object's fields by name, read from `values` when asked (so results computed so far count). */
function lookupIn(type: ObjectType, values: Record<string, FieldValue>, refLabel: RefLabel): FieldLookup {
  const byName = new Map(type.fields.map((f) => [f.name, f]));
  return {
    names: [...byName.keys()],
    get: (name) => {
      const f = byName.get(name);
      return f ? inputOf(f, values[f.id], refLabel) : undefined;
    },
  };
}

/** A variable's value: its field's (as a template sees it), or its fixed value (a number when it reads as one). */
function argValue(arg: TemplateArg | undefined, fieldsById: Map<string, FieldDef>, values: Record<string, FieldValue>, refLabel: RefLabel): unknown {
  if (!arg) return null;
  if ("field" in arg) return inputOf(fieldsById.get(arg.field), values[arg.field], refLabel);
  const s = arg.value.trim();
  return s === "" ? null : Number.isFinite(Number(s)) ? Number(s) : arg.value;
}

/** Field kinds whose values may hold {{ }} sections themselves, and what those render as. */
const INLINE_OUTPUT: Partial<Record<FieldKind, TemplateOutput>> = { string: "string", markdown: "markdown", html: "html", number: "number" };

/** Whether a value holds a {{ }} section (and is then rendered when shown). */
export const hasSections = (v: unknown): v is string => typeof v === "string" && /\{\{[\s\S]*?\}\}/.test(v);

/** Markdown escapes inside sections undone: the editor stores a typed `a[0] * 2` as `a\[0] \* 2`. */
const unescapeSections = (markdown: string) =>
  markdown.replace(SECTION, (_, code: string) => `{{${code.replace(/\\([!-/:-@[-`{-~])/g, "$1")}}}`);

/** A value with {{ }} sections, rendered as its field kind shows it. */
function renderInline(source: string, kind: FieldKind, object: ObjectInstance, fields: FieldLookup): FieldValue {
  // Sections in a value have no variable mapping (the built-ins $object and $now still work): a
  // section using another $name shows a short warning instead of quietly rendering it empty.
  const code = (kind === "markdown" ? unescapeSections(source) : source).replace(SECTION, (section, inner: string) => {
    const usesVariable = parseParams(`{{${inner}}}`).length > 0;
    return usesVariable ? `{{ ${JSON.stringify(`${ERROR_PREFIX}variables aren't supported here`)} }}` : section;
  });
  return render({ params: [], code, output: INLINE_OUTPUT[kind] }, [], object, fields);
}

/**
 * Objects with their template fields filled in and {{ }} sections in their own values rendered,
 * computed in field order (so a template can use the result of an earlier one). A variable gets
 * its mapped field's value (references as the linked objects' labels), or null when unmapped.
 * A rendered value's source is kept in `sources`, for editing. Objects with neither are
 * returned as is.
 *
 * `memo` keeps each object's result: pass the same map for as long as the type, the templates and
 * the reference labels are the same, and only objects that changed (a new instance) are computed
 * again. Its entries are keyed by object, so they go with the objects.
 */
export function withComputed(
  type: ObjectType,
  objects: ObjectInstance[],
  templates: Template[],
  refLabel: RefLabel,
  memo?: WeakMap<ObjectInstance, ObjectInstance>,
): ObjectInstance[] {
  const hasTemplates = type.fields.some((f) => f.kind === "template");
  const inline = type.fields.filter((f) => INLINE_OUTPUT[f.kind]);
  if (!hasTemplates && inline.length === 0) return objects;
  const byId = new Map(templates.map((x) => [x.id, x]));
  const fieldsById = new Map(type.fields.map((f) => [f.id, f]));
  const compute = (object: ObjectInstance): ObjectInstance => {
    if (!hasTemplates && !inline.some((f) => hasSections(object.values[f.id]))) return object;
    const values = { ...object.values };
    const sources: Record<string, FieldValue> = {};
    const lookup = lookupIn(type, values, refLabel);
    for (const f of type.fields) {
      if (f.kind === "template") {
        const x = f.templateId ? byId.get(f.templateId) : undefined;
        values[f.id] = x
          ? render(x, x.params.map((p) => argValue(f.templateArgs[p], fieldsById, values, refLabel)), object, lookup)
          : null;
      } else if (INLINE_OUTPUT[f.kind] && hasSections(values[f.id])) {
        const source = values[f.id] as string;
        sources[f.id] = source;
        values[f.id] = renderInline(source, f.kind, object, lookup);
      }
    }
    return Object.keys(sources).length > 0 ? { ...object, values, sources } : { ...object, values };
  };
  if (!memo) return objects.map(compute);
  return objects.map((object) => {
    let result = memo.get(object);
    if (!result) memo.set(object, (result = compute(object)));
    return result;
  });
}
