import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codeProblem,
  componentsFor,
  dollarNames,
  ERROR_PREFIX,
  evaluate,
  fieldComponent,
  fieldComponentProblem,
  fieldLookup,
  fitsPlace,
  isComponentError,
  isComponentOutput,
  itemsInput,
  kindText,
  localComponents,
  outputOf,
  placeProblem,
  render,
  setCompiler,
  splitWarnings,
  WARNING_MARK,
  withComputed,
  type Component,
} from "./components";
import { blankField, type Collection, type FieldDef, type Item } from "./model";

const component = (id: string, code: string, extra: Partial<Component> = {}): Component => ({ id, name: id, description: "", code, output: "markdown", frameRatio: null, ai: false, createdAt: "", updatedAt: "", ...extra });
const item = (values: Item["values"], id = "i1"): Item => ({ id, collectionId: "c", spaceId: "s", values, createdAt: "2026-01-01", updatedAt: "2026-01-02" });
const collection = (fields: FieldDef[], extra: Partial<Collection> = {}): Collection => ({ id: "c", name: "Book", pluralName: "Books", icon: null, description: "", itemViews: [], spaceIds: null, createdAt: "", updatedAt: "", fields, ...extra });
const refLabel = (_f: FieldDef, id: string) => ({ a1: "Ann", a2: "Bob" })[id] ?? "";

describe("warnings", () => {
  it("a result that is only a warning, one inside text, and plain text", () => {
    expect(splitWarnings(`${ERROR_PREFIX}boom`)).toEqual(["", "boom", ""]);
    expect(splitWarnings("fine")).toEqual(["fine"]);
    expect(splitWarnings(`a ${WARNING_MARK}${ERROR_PREFIX}boom${WARNING_MARK} b`)).toEqual(["a ", "boom", " b"]);
  });
});

describe("outputs", () => {
  it("know their names", () => {
    expect(isComponentOutput("html")).toBe(true);
    expect(isComponentOutput("pdf")).toBe(false);
    expect(isComponentOutput(null)).toBe(false);
  });

  it("a number output is a number, an error when it isn't, nothing when empty", () => {
    expect(render({ code: "{{ 2 * 3 }}", output: "number" })).toBe(6);
    expect(render({ code: "{{ '4.5' }}", output: "number" })).toBe(4.5);
    expect(render({ code: "{{ ' ' }}", output: "number" })).toBeNull();
    expect(render({ code: "{{ 'abc' }}", output: "number" })).toBe(`${ERROR_PREFIX}Not a number: abc`);
    expect(render({ code: "{{ null }}", output: "number" })).toBeNull();
  });

  it("an image output is the trimmed URL, none when blank", () => {
    expect(render({ code: "{{ ' files/x ' }}", output: "image" })).toBe("files/x");
    expect(render({ code: "{{ '' }}", output: "image" })).toBeNull();
  });

  it("text outputs make text of the result; markdown keeps a lone value as it is", () => {
    expect(render({ code: "{{ 1 + 1 }}", output: "string" })).toBe("2");
    expect(render({ code: "{{ 1 + 1 }}", output: "html" })).toBe("2");
    expect(render({ code: "{{ 1 + 1 }}" })).toBe(2);
    expect(render({ code: "n = {{ 1 + 1 }}" })).toBe("n = 2");
  });

  it("an error stays an error whatever the output", () => {
    expect(render({ code: "{{ nope() }}", output: "number" })).toMatch(/^⚠ /);
  });

  it("an empty component is nothing; a section's error shows inside the text", () => {
    expect(render({ code: "   " })).toBeNull();
    const out = render({ code: "a {{ nope() }} b" }) as string;
    expect(out).toContain(WARNING_MARK);
    expect(splitWarnings(out)[0]).toBe("a ");
  });

  it("a lone section holding braces in a string is still one", () => {
    expect(render({ code: "{{ '}}' }}" })).not.toBe(null);
  });

  it("an unknown name is reported before anything runs", () => {
    expect(render({ code: "{{ $foo }}" })).toBe(`${ERROR_PREFIX}$foo isn't known: read a field as $item.Name`);
  });
});

describe("results as values", () => {
  it("dates, lists, objects and odd numbers", () => {
    expect(evaluate("new Date(0)")).toBe("1970-01-01T00:00:00.000Z");
    expect(evaluate("new Date('x')")).toBeNull();
    expect(evaluate("[1, 'a', {b: 2}, null]")).toBe('1, a, {"b":2}, null');
    expect(evaluate("({a: 1})")).toBe('{"a":1}');
    expect(evaluate("1 / 0")).toBeNull();
    expect(evaluate("NaN")).toBeNull();
    expect(evaluate("true")).toBe(true);
    expect(evaluate("undefined")).toBeNull();
    expect(evaluate("(() => { const o = {}; o.o = o; return o; })()")).toBe("[object Object]");
  });

  it("empty code is nothing; errors are reported with their message", () => {
    expect(evaluate("  ")).toBeNull();
    expect(evaluate("(() => { throw new Error('bad'); })()")).toBe(`${ERROR_PREFIX}bad`);
    expect(evaluate("1 +")).toMatch(/^⚠ /);
    expect(isComponentError(evaluate("nope()"))).toBe(true);
    expect(isComponentError("fine")).toBe(false);
    expect(isComponentError(3)).toBe(false);
  });

  it("outside a block the block's names are empty", () => {
    expect(evaluate("$items.length + $groups.length + $fields.length + $all.length")).toBe(0);
  });

  it("reads $item's fields by name in any case, and its id and dates", () => {
    const c = collection([blankField("t", "Read at", "string")]);
    const row = item({ t: "yes" });
    const lookup = fieldLookup(c, row, refLabel);
    expect(evaluate("$item['Read at']", row, lookup)).toBe("yes");
    expect(evaluate("$item['read at']", row, lookup)).toBe("yes");
    expect(evaluate("$item.id + $item.createdAt", row, lookup)).toBe("i12026-01-01");
    expect(evaluate("'Read at' in $item", row, lookup)).toBe(true);
    expect(evaluate("Object.keys($item).includes('Read at')", row, lookup)).toBe(true);
    expect(evaluate("$item.missing", row, lookup)).toBeNull();
  });
});

describe("what the code can read of fields", () => {
  const fields = [
    blankField("img", "Photo", "image"),
    blankField("chk", "Steps", "checklist"),
    blankField("ref", "Author", "item", { targetCollectionId: "a" }),
    blankField("refs", "Authors", "item_list", { targetCollectionId: "a" }),
    blankField("tags", "Tags", "string_list"),
    blankField("n", "N", "number"),
  ];
  const c = collection(fields);
  const row = item({ img: "abc", chk: ["[x] one", "[ ] two"], ref: "a1", refs: ["a1", "a2"], tags: ["x", "y"], n: 3 });
  const read = (code: string) => evaluate(code, row, fieldLookup(c, row, refLabel));

  it("images as their src, checklists as items, references as labels", () => {
    expect(read("$item.Photo")).toBe("files/abc");
    expect(read("$item.Steps.filter(s => s.done).map(s => s.text)")).toBe("one");
    expect(read("$item.Author")).toBe("Ann");
    expect(read("$item.Authors")).toBe("Ann, Bob");
    expect(read("$item.Tags.length")).toBe(2);
    expect(read("$item.N + 1")).toBe(4);
  });

  it("an empty value is null; a name that isn't a field is undefined", () => {
    const empty = item({});
    const lookup = fieldLookup(c, empty, refLabel);
    expect(evaluate("$item.Photo === null", empty, lookup)).toBe(true);
    expect(evaluate("$item.Nothing === undefined", empty, lookup)).toBe(true);
  });

  it("a block's items are made once each, and are the same object in $items and a group", () => {
    const make = itemsInput(c, refLabel);
    expect(make(row)).toBe(make(row));
    expect(evaluate("$items[0] === $groups[0].items[0] && $items[0].Author === 'Ann'", undefined, undefined, { items: [make(row)], groups: [{ key: "", label: "", items: [make(row)] }], fields: [], all: [make(row)] })).toBe(true);
  });
});

describe("components in places", () => {
  it("know where they fit", () => {
    expect(fitsPlace("field", "field")).toBe(true);
    expect(fitsPlace("block", "field")).toBe(false);
    expect(fitsPlace("static", "block")).toBe(true);
    expect(fitsPlace("static", "static")).toBe(true);
    expect(fitsPlace("static", "field")).toBe(false);
    expect(fitsPlace("field", "static")).toBe(false);
  });

  it("each misfit says why", () => {
    expect(placeProblem({ code: "{{ $item.A }}", ai: false }, "field")).toBeNull();
    expect(placeProblem({ code: "{{ $items.length }}", ai: false }, "field")).toBe("This component lists items: use it as a block");
    expect(placeProblem({ code: "{{ 1 }}", ai: false }, "field")).toMatch(/would be the same for every item/);
    expect(placeProblem({ code: "{{ $item.A }}", ai: false }, "block")).toBe("This component shows one item ($item): use it as a field");
    expect(placeProblem({ code: "{{ $item.A }}", ai: false }, "static")).toMatch(/\$item isn't available/);
    expect(placeProblem({ code: "{{ $items.length }}", ai: false }, "static")).toMatch(/block's \$ names aren't available/);
    expect(placeProblem({ code: "{{ $nope }}", ai: false }, "block")).toMatch(/isn't known/);
    expect(placeProblem({ code: "{{ $item.A + $items.length }}", ai: false }, "field")).toMatch(/both \$item and a block/);
  });

  it("an AI prompt fills a field, without $now", () => {
    expect(placeProblem({ code: "Say {{ $item.A }}", ai: true }, "field")).toBeNull();
    expect(placeProblem({ code: "Say {{ $item.A }}", ai: true }, "block")).toMatch(/fills a field/);
    expect(placeProblem({ code: "{{ $now }} {{ $item.A }}", ai: true }, "field")).toMatch(/\$now isn't available/);
  });

  it("code problems: unknown names and mixed kinds, nothing else", () => {
    expect(codeProblem("{{ $item.A }}")).toBeNull();
    expect(codeProblem("{{ $x }}")).toMatch(/\$x isn't known/);
    expect(codeProblem("{{ $item }}{{ $all }}")).toMatch(/both/);
    expect(codeProblem("plain")).toBeNull();
  });

  it("names of the quoted kind aren't $ names, but template parts are code", () => {
    expect(dollarNames("{{ 'costs $5' }}{{ \"$x\" }}")).toEqual([]);
    expect(dollarNames("{{ `${$item.A} $y` }}")).toEqual(["item"]);
    expect(dollarNames("{{ $item.A }}{{ $item.B + $now }}")).toEqual(["item", "now"]);
  });

  it("the components offered for a place: those that fit, AI or not, and the one chosen", () => {
    const list = [component("f", "{{ $item.A }}"), component("b", "{{ $items.length }}"), component("s", "hello"), component("ai", "Say {{ $item.A }}", { ai: true })];
    expect(componentsFor(list, "field").map((c) => c.id)).toEqual(["f"]);
    expect(componentsFor(list, "field", null, true).map((c) => c.id)).toEqual(["ai"]);
    expect(componentsFor(list, "block").map((c) => c.id)).toEqual(["b", "s"]);
    expect(componentsFor(list, "static").map((c) => c.id)).toEqual(["s"]);
    expect(componentsFor(list, "block", "f").map((c) => c.id)).toEqual(["f", "b", "s"]);
  });

  it("describe themselves for the editor", () => {
    expect(kindText("{{ $item.A }}")).toMatch(/^Field component/);
    expect(kindText("{{ $items.length }}")).toMatch(/^Block component/);
    expect(kindText("hello")).toMatch(/^Static component/);
    expect(kindText("{{ $item }}{{ $all }}")).toMatch(/together/);
    expect(kindText("Say {{ $item.A }}", true)).toMatch(/^AI component/);
  });
});

describe("a field's component", () => {
  const field = (extra: Partial<FieldDef>) => blankField("f", "F", "component", extra);
  const shared = [component("k", "{{ $item.A }}"), component("blank", "  "), component("blocky", "{{ $all.length }}"), component("aiout", "Say {{ $item.A }}", { ai: true, output: "html" })];

  it("its own code wins over a shared one; a shared one is looked up", () => {
    expect(fieldComponent(field({ code: "own", output: "string" }), shared)).toMatchObject({ code: "own", output: "string", ai: false });
    expect(fieldComponent(field({ code: "own" }), shared)?.output).toBe("markdown");
    expect(fieldComponent(field({ componentId: "k" }), shared)).toBe(shared[0]);
    expect(fieldComponent(field({ componentId: "gone" }), shared)).toBeUndefined();
    expect(fieldComponent(field({}), shared)).toBeUndefined();
  });

  it("an AI field keeps its own output with a shared prompt", () => {
    const ai = blankField("f", "F", "ai", { componentId: "aiout", output: "number" });
    expect(fieldComponent(ai, shared)).toMatchObject({ id: "aiout", output: "number" });
    expect(fieldComponent(blankField("f", "F", "ai", { componentId: "aiout" }), shared)?.output).toBe("html");
    expect(fieldComponent(blankField("f", "F", "ai", { code: "x" }), shared)).toMatchObject({ ai: true, output: "markdown" });
  });

  it("the output of a component field", () => {
    expect(outputOf(field({ componentId: "aiout" }), shared)).toBe("html");
    expect(outputOf(field({}), shared)).toBe("markdown");
  });

  it("problems, in the order they'd be fixed", () => {
    expect(fieldComponentProblem(blankField("f", "F", "string"), [])).toBeNull();
    expect(fieldComponentProblem(field({}), shared)).toBe("Choose a component, or write it here");
    expect(fieldComponentProblem(blankField("f", "F", "ai"), shared)).toBe("Choose a prompt, or write it here");
    expect(fieldComponentProblem(field({ componentId: "gone" }), shared)).toBe("The component is gone: choose another");
    expect(fieldComponentProblem(field({ componentId: "blank" }), shared)).toBe("Write the component");
    expect(fieldComponentProblem(blankField("f", "F", "ai", { code: " " }), shared)).toBe("Write the prompt");
    expect(fieldComponentProblem(blankField("f", "F", "ai", { code: "x", output: "image" }), shared)).toBe("An AI value is text, a number or Markdown");
    expect(fieldComponentProblem(field({ componentId: "blocky" }), shared)).toMatch(/use it as a block/);
    expect(fieldComponentProblem(field({ componentId: "k" }), shared)).toBeNull();
    expect(fieldComponentProblem(blankField("f", "F", "ai", { code: "Say {{ $item.A }}", output: "string" }), shared)).toBeNull();
  });
});

describe("withComputed", () => {
  const fields = [blankField("a", "A", "string"), blankField("b", "B", "number"), blankField("calc", "Calc", "component", { code: "{{ $item.A }}!" }), blankField("sum", "Sum", "component", { code: "{{ $item.B * 2 }}", output: "number" }), blankField("again", "Again", "component", { code: "{{ $item.Calc }}?" })];
  const c = collection(fields);

  it("is the very items when no field computes", () => {
    const plain = collection([blankField("a", "A", "string")]);
    const items = [item({ a: "x" })];
    expect(withComputed(plain, items, [], refLabel)).toBe(items);
  });

  it("fills component fields in field order, so a later one can use an earlier result", () => {
    const [out] = withComputed(c, [item({ a: "hi", b: 4 })], [], refLabel);
    expect(out.values).toMatchObject({ a: "hi", calc: "hi!", sum: 8, again: "hi!?" });
  });

  it("leaves the stored item alone", () => {
    const stored = item({ a: "hi" });
    withComputed(c, [stored], [], refLabel);
    expect(stored.values.calc).toBeUndefined();
  });

  it("a field without a component is empty, one that doesn't fit shows why", () => {
    const withMisfit = collection([blankField("a", "A", "string"), blankField("none", "None", "component", { componentId: "gone" }), blankField("bad", "Bad", "component", { code: "{{ $items.length }}" })]);
    const [out] = withComputed(withMisfit, [item({})], [], refLabel);
    expect(out.values.none).toBeNull();
    expect(out.values.bad).toBe(`${ERROR_PREFIX}This component lists items: use it as a block`);
  });

  it("with a memo only an item that is new is computed again", () => {
    const calls = vi.fn(() => "x");
    const memo = new WeakMap<Item, Item>();
    const spyLabel = (f: FieldDef, id: string) => (calls(), refLabel(f, id));
    const withRef = collection([blankField("r", "R", "item", { targetCollectionId: "a" }), blankField("calc", "Calc", "component", { code: "{{ $item.R }}" })]);
    const one = item({ r: "a1" });
    const first = withComputed(withRef, [one], [], spyLabel, memo);
    const second = withComputed(withRef, [one], [], spyLabel, memo);
    expect(second[0]).toBe(first[0]);
    expect(calls).toHaveBeenCalledTimes(1);
    const changed = withComputed(withRef, [{ ...one }], [], spyLabel, memo);
    expect(changed[0]).not.toBe(first[0]);
    expect(calls).toHaveBeenCalledTimes(2);
  });
});

describe("local components", () => {
  const block = (id: string, kind: string, options: unknown, title = "") => ({ id, kind, title, options, filters: null, sort: [], groupBy: null, layout: { fields: null, editable: true, hiddenLabels: [], hideEmpty: false }, collectionId: null }) as never;
  const c = collection(
    [blankField("calc", "Calc", "component", { code: "{{ $item.A }}", output: "number" }), blankField("ai", "Ask", "ai", { code: "Say {{ $item.A }}" }), blankField("shared", "Shared", "component", { componentId: "k" }), blankField("plain", "Plain", "string")],
    {
      itemViews: [{ id: "iv", name: "Page", isDefault: true, collapsed: { blocks: [], groups: {} }, layout: { fields: null, editable: true, hiddenLabels: [], hideEmpty: false, filters: [], blocks: [block("ib", "markdown", { text: "hi {{ 1 }}" }), block("plainmd", "markdown", { text: "just text" })] } }],
    },
  );
  const views = [
    { id: "v", collectionId: "c", name: "All", blocks: [block("cb", "component", { local: { code: "{{ $all.length }}", output: "bogus", frameRatio: "4/3" } }, "Count"), block("nolocal", "component", { componentId: "k", local: null }), block("tbl", "table", null), block("md", "markdown", { text: "{{ $now }}" })] },
    { id: "orphan", collectionId: "gone", name: "Orphan", blocks: [block("x", "markdown", { text: "{{ 1 }}" })] },
  ];

  it("lists the code written in place, by where it is", () => {
    const list = localComponents([c], views);
    expect(list.map((l) => l.key)).toEqual(["field:calc", "field:ai", "itemView:iv:ib", "view:v:cb", "view:v:md"]);
    const byKey = Object.fromEntries(list.map((l) => [l.key, l]));
    expect(byKey["field:calc"]).toMatchObject({ where: "Books › Calc", component: { code: "{{ $item.A }}", output: "number", ai: false }, owner: { type: "field", fieldId: "calc" } });
    expect(byKey["field:calc"].href).toBe("#/collections/c/edit?field=calc");
    expect(byKey["field:ai"].component).toMatchObject({ ai: true, output: "string" });
    expect(byKey["itemView:iv:ib"]).toMatchObject({ where: "Book pages › Page › Markdown", href: null, owner: { markdown: true }, component: { code: "hi {{ 1 }}" } });
    expect(byKey["view:v:cb"]).toMatchObject({ where: "Books › All › Count", component: { output: "markdown", frameRatio: "4/3" }, owner: { markdown: false } });
    expect(byKey["view:v:cb"].href).toBe("#/collections/c/items?view=v&block=cb");
    expect(byKey["view:v:md"].where).toBe("Books › All › Markdown");
  });
});

describe("compiling", () => {
  afterEach(() => setCompiler((params, body) => new Function(...params, body) as never));

  it("can be replaced (the server runs code in a context of its own), and the replacement is used at once", () => {
    expect(evaluate("1 + 1")).toBe(2);
    const compiler = vi.fn((_params: string[], _body: string) => () => "from elsewhere");
    setCompiler(compiler as never);
    expect(evaluate("1 + 1")).toBe("from elsewhere"); // not the compiled code kept from before
    expect(compiler).toHaveBeenCalledTimes(1);
    evaluate("1 + 1");
    expect(compiler).toHaveBeenCalledTimes(1); // compiled once
    expect(compiler.mock.calls[0][0]).toEqual(["$item", "$now", "$items", "$groups", "$fields", "$all"]);
  });

  it("a replacement that throws gives the message, and is kept so it isn't tried again", () => {
    const compiler = vi.fn(() => {
      throw new Error("not allowed");
    });
    setCompiler(compiler as never);
    expect(evaluate("anything")).toBe(`${ERROR_PREFIX}not allowed`);
    expect(evaluate("anything")).toBe(`${ERROR_PREFIX}not allowed`);
    expect(compiler).toHaveBeenCalledTimes(1);
    setCompiler(() => {
      throw "plain string";
    });
    expect(evaluate("other")).toBe(`${ERROR_PREFIX}plain string`);
  });

  it("keeps a bounded number of compiled sections", () => {
    const compiler = vi.fn(() => () => 1);
    setCompiler(compiler as never);
    for (let i = 0; i < 520; i++) evaluate(`${i}`);
    expect(compiler).toHaveBeenCalledTimes(520);
    evaluate("519");
    expect(compiler).toHaveBeenCalledTimes(520); // recent: kept
    evaluate("0");
    expect(compiler).toHaveBeenCalledTimes(521); // oldest: let go
  });
});

