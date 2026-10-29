// ---------------------------------------------------------------------------------------------
// Test data: content of every shape (short, long, unbroken, unicode, …) and a seeding function
// that stores a spec through the dev build's repository (window.kubus.repo).
//
// A spec: {
//   spaces: [{ key, name }],
//   components: [{ key, name, code, output?, description?, ai? }],          // shared components
//   images: [{ key, w, h }],                      // generated PNGs (putFile)
//   collections: [{ key, name, plural?, icon?, description?, spaces?: [spaceKey],
//                   fields: [{ key, name, kind, target?: collectionKey, component?: key (a shared one),
//                              code?, output? (its own component: a component field's code, an AI field's prompt),
//                              toggleIcon?, strikeThrough?,
//                              choiceFilter?: [{ field: targetFieldKey, operator, value }] }],
//                   items: [{ key?, space?: spaceKey, values: { fieldKey: value } }],
//                   views?: [{ name, blocks: [partial ViewBlock with kind/options/layout/groupBy/sort;
//                              componentKey (a shared component) or local: code (its own)], filters?, isDefault?, filterBar? (Show filter bar), fullWidth? (Full width) }],
//                   (a block filter value "$item.@key": the page item's field by key)
//                   (a block's `collection` is a collection key, or the id of a virtual collection: "$backlinks")
//                   itemViews?: [{ name, layout, fullWidth? }] }],
//   bookmarks: [{ kind: "item"|"view", collection, item?, view?, label }],
//   prefs: { localStorageKey: value },
// }
// Values: plain values as stored; { ref: "collKey/itemKey" } for an item field, { refs: [...] }
// for a list of items, { image: "imageKey" } for an image field.
// ---------------------------------------------------------------------------------------------

/** Runs in the page: stores `spec`, returns the ids by key. */
async function __seedInPage(spec) {
  const repo = window.kubus.repo;
  const uid = () => crypto.randomUUID();
  const stamp = () => new Date().toISOString();
  const ids = { spaces: { default: "default" }, collections: {}, fields: {}, items: {}, components: {}, images: {}, views: {} };

  for (const s of spec.spaces || []) {
    ids.spaces[s.key] = s.key === "default" ? "default" : uid();
    await repo.saveSpace({ id: ids.spaces[s.key], name: s.name, icon: s.icon || null });
  }
  for (const c of spec.components || []) {
    ids.components[c.key] = uid();
    await repo.saveComponent({ id: ids.components[c.key], name: c.name, description: c.description || "", code: c.code, output: c.output || (c.ai ? "string" : "markdown"), frameRatio: c.frameRatio || null, ai: !!c.ai, createdAt: stamp(), updatedAt: stamp() });
  }
  for (const img of spec.images || []) {
    const canvas = document.createElement("canvas");
    canvas.width = img.w;
    canvas.height = img.h;
    const g = canvas.getContext("2d");
    const grad = g.createLinearGradient(0, 0, img.w, img.h);
    grad.addColorStop(0, img.from || "#0f62fe");
    grad.addColorStop(1, img.to || "#a6c8ff");
    g.fillStyle = grad;
    g.fillRect(0, 0, img.w, img.h);
    g.fillStyle = "#ffffff";
    g.font = `${Math.max(10, Math.min(img.w, img.h) / 5)}px sans-serif`;
    g.fillText(`${img.w}×${img.h}`, 4, Math.min(img.h - 4, Math.max(12, img.h / 2)));
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    ids.images[img.key] = await repo.putFile(new Uint8Array(await blob.arrayBuffer()), "image/png");
  }
  // Ids first, so fields can point at collections defined later.
  for (const c of spec.collections || []) {
    ids.collections[c.key] = uid();
    for (const f of c.fields || []) ids.fields[`${c.key}.${f.key}`] = uid();
  }
  // Twice: first without references (their targets may not exist yet), then complete.
  for (const pass of [1, 2]) for (const c of spec.collections || []) {
    if (pass === 2 && !(c.fields || []).some((f) => f.target)) continue;
    const fields = (c.fields || []).filter((f) => pass === 2 || !f.target).map((f) => ({
      id: ids.fields[`${c.key}.${f.key}`],
      name: f.name,
      kind: f.kind,
      targetCollectionId: f.target ? ids.collections[f.target] : null,
      componentId: f.component ? ids.components[f.component] : null,
      // Its own component (written in place): a component field's code, an AI field's prompt.
      code: f.code ?? null,
      output: f.output || (f.kind === "ai" ? "string" : f.code != null ? "markdown" : null),
      frameRatio: null,
      // { field: a field key of the target collection, operator, value }: which items it offers.
      choiceFilter: (f.choiceFilter || []).map((r) => ({ id: uid(), fieldId: ids.fields[`${f.target}.${r.field}`], operator: r.operator, value: r.value })),
      toggleIcon: f.toggleIcon || null,
      strikeThrough: !!f.strikeThrough,
    }));
    const plural = c.plural || c.name + "s";
    const draft = { id: ids.collections[c.key], name: c.name, pluralName: plural, icon: c.icon === undefined ? "Cube" : c.icon, description: c.description || "", spaceIds: c.spaces ? c.spaces.map((s) => ids.spaces[s]) : null, fields };
    await repo.saveCollection(draft, ids.spaces[c.space || "default"]);
  }
  const collections = await repo.listCollections();
  const byKey = (key) => collections.find((x) => x.id === ids.collections[key]);
  const convert = (c, values) => {
    const out = {};
    for (const [fk, v] of Object.entries(values || {})) {
      const fid = ids.fields[`${c.key}.${fk}`];
      if (!fid) continue;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        if ("image" in v) out[fid] = ids.images[v.image];
        else if ("ref" in v) out[fid] = ids.items[v.ref] || null;
        else if ("refs" in v) out[fid] = v.refs.map((r) => ids.items[r]).filter(Boolean);
      } else out[fid] = v;
    }
    return out;
  };
  // Every item in one change set (references between them resolve inside it).
  const entries = [];
  for (const c of spec.collections || []) {
    let n = 0;
    for (const it of c.items || []) {
      const key = `${c.key}/${it.key || "i" + n++}`;
      ids.items[key] = uid();
      entries.push([c, key, it]);
    }
  }
  if (entries.length) await repo.createItems(entries.map(([c, key, it]) => ({ collection: byKey(c.key), id: ids.items[key], values: convert(c, it.values), spaceId: ids.spaces[it.space || "default"] })));
  for (const c of spec.collections || []) {
    const fieldId = (k) => (k && k.startsWith("$") ? k : ids.fields[`${c.key}.${k}`] || k);
    const mapLayout = (l) => (l ? { fields: l.fields ? l.fields.map(fieldId) : null, editable: l.editable !== false, hiddenLabels: (l.hiddenLabels || []).map(fieldId), hideEmpty: !!l.hideEmpty } : { fields: null, editable: true, hiddenLabels: [], hideEmpty: false });
    const mapBlock = (b) => ({
      id: b.id || uid(), title: b.title || "", kind: b.kind || "table", filters: b.filters ? b.filters.map((r) => ({ id: uid(), fieldId: fieldId(r.field), operator: r.operator, value: String(r.value).replace(/@([a-z0-9_]+)/gi, (_, k) => fieldId(k)) })) : null,
      sort: b.sort ? b.sort.map((s) => ({ fieldId: fieldId(s.field), direction: s.direction || "asc" })) : [{ fieldId: "$title", direction: "asc" }],
      groupBy: b.groupBy ? fieldId(b.groupBy) : null, layout: mapLayout(b.layout), collectionId: b.collection ? (ids.collections[b.collection] ?? b.collection) : null,
      options: b.options ? JSON.parse(JSON.stringify(b.options).replace(/"@([a-z0-9_]+)"/gi, (_, k) => JSON.stringify(fieldId(k)))) : b.kind === "cards" ? { coverFieldId: null, cardWidth: 16, coverRatio: "auto", showTitle: true, coverBeside: false } : b.kind === "markdown" ? { text: "" } : { titleLink: true, editable: true },
      ...(b.hideHeader ? { hideHeader: true } : {}),
      ...(b.componentKey ? { kind: "component", options: { componentId: ids.components[b.componentKey], local: null } } : {}),
      ...(b.local != null ? { kind: "component", options: { componentId: null, local: { code: b.local, output: b.output || "markdown", frameRatio: null, ai: false } } } : {}),
    });
    const existing = c.views ? await repo.listViews(ids.collections[c.key], ids.spaces[c.space || "default"]) : [];
    for (const [i, v] of (c.views || []).entries()) {
      const id = i === 0 && existing[0] && v.replaceAll !== false ? existing[0].id : uid();
      ids.views[`${c.key}/${v.name}`] = id;
      await repo.saveView({ id, collectionId: ids.collections[c.key], spaceId: ids.spaces[c.space || "default"], name: v.name, position: i, isDefault: !!v.isDefault, filters: v.filters || [], blocks: v.blocks.map(mapBlock), collapsed: { blocks: [], groups: {} }, ...(v.filterBar ? { filterBar: true } : {}), ...(typeof v.fullWidth === "boolean" ? { fullWidth: v.fullWidth } : {}), createdAt: stamp(), updatedAt: stamp() });
    }
    if (c.itemViews) {
      await repo.saveItemViews(ids.collections[c.key], c.itemViews.map((v, i) => ({ id: uid(), name: v.name, isDefault: i === 0, collapsed: { blocks: [], groups: {} }, ...(typeof v.fullWidth === "boolean" ? { fullWidth: v.fullWidth } : {}), layout: { ...mapLayout(v.layout), blocks: (v.layout && v.layout.blocks || []).map(mapBlock) } })));
    }
  }
  for (const b of spec.bookmarks || []) {
    const target = b.kind === "item" ? ids.items[b.item] : ids.views[b.view];
    await repo.addBookmark(b.kind, ids.collections[b.collection], target, b.label, "default");
  }
  for (const [k, v] of Object.entries(spec.prefs || {})) localStorage.setItem(k, JSON.stringify(v));
  return ids;
}

// ---- content --------------------------------------------------------------------------------

const TEXT = {
  short: ["Dune", "Ada", "Kafka", "Zola", "Io", "Oz", "Ra", "Ulm"],
  typical: ["The Left Hand of Darkness", "A Wizard of Earthsea", "Foundation and Empire", "Neuromancer", "The Dispossessed", "Hyperion", "Solaris", "Kindred"],
  long: [
    "An extraordinarily long title that keeps going well past what any column, card or tab was designed to hold, to see where it wraps and where it is cut",
    "Proceedings of the International Symposium on Exceedingly Verbose Naming Conventions in Personal Knowledge Management Systems, Volume Twelve",
  ],
  unbroken: [
    "Pneumonoultramicroscopicsilicovolcanoconiosis_and_then_some_more_characters_without_any_break_opportunity_at_all",
    "https://example.com/a/very/long/path/that/never/breaks/because/it/is/a/url/with/no/spaces/whatsoever?query=string&and=more",
  ],
  unicode: ["日本語のタイトルと長い説明文", "مرحبا بالعالم – نص من اليمين إلى اليسار", "Ünïcödé çhàrâctérs ñ ß Æ Ø Å", "Emoji 🚀📚🧪👩‍💻🏳️‍🌈", "Zalgo z̷̢̛a̴l̸g̶o̵ t̴e̷x̸t̶", "Tab\tand nbsp​zero-width", "<b>not bold</b> &amp; \"quotes\" 'single'"],
};

const MARKDOWN = {
  typical: "A paragraph with **bold**, *italic*, `code` and a [link](https://example.com).\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n- [x] done\n- [ ] todo\n",
  long:
    "# Heading one\n\n## Heading two\n\n### Heading three\n\n" +
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(12) +
    "\n\n> A quote that is long enough to wrap over several lines in most panes, to see the quote bar along it. ".repeat(2) +
    "\n\n| Column A | Column B | Column C | Column D | Column E | Column F | Column G | Column H |\n|---|---|---|---|---|---|---|---|\n" +
    "| a value | another value | 123456789 | x | y | z | a long cell value that wraps | end |\n".repeat(5) +
    "\n```js\nconst aVeryLongLineOfCode = someFunction(withArguments, andMoreArguments, andEvenMoreArguments, untilTheLineIsWayTooLongToFit);\nfunction f() { return 1; }\n```\n\n" +
    "- [x] task one\n- [ ] task two with a long description that wraps over the end of the line in narrow panes\n\n" +
    "https://example.com/a/very/long/path/that/never/breaks/because/it/is/a/url/with/no/spaces/whatsoever\n\n---\n\nThe end.\n",
  unbroken: "Supercalifragilisticexpialidocious".repeat(8),
  unicode: "## 日本語の見出し\n\nمرحبا بالعالم 🚀 emoji and Ünïcödé\n\n- 列表项目\n- عنصر\n",
};

const HTML = {
  typical: "<p>Some <strong>HTML</strong> content with a <a href='https://example.com'>link</a>.</p><ul><li>one</li><li>two</li></ul>",
  long: "<div style='display:flex;gap:8px;flex-wrap:wrap'>" + "<span style='padding:4px 8px;border:1px solid #888'>chip</span>".repeat(40) + "</div>",
};

const pick = (list, i) => list[i % list.length];

/** A value of a field kind in a content style ("short" | "typical" | "long" | "unbroken" | "unicode"). */
function contentValue(kind, style, i, extra = {}) {
  const words = TEXT[style] || TEXT.typical;
  switch (kind) {
    case "string": return pick(words, i) + (style === "typical" ? ` ${i + 1}` : "");
    case "markdown": return MARKDOWN[style] || MARKDOWN.typical;
    case "html": return style === "long" || style === "unbroken" ? HTML.long : HTML.typical;
    case "number": return style === "long" ? 12345678901234.567 * (i + 1) : style === "short" ? i : Math.round((i * 37.5 + 3) * 100) / 100;
    case "date": return `20${String(10 + (i % 15)).padStart(2, "0")}-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`;
    case "datetime": return new Date(Date.UTC(2020, i % 12, (i % 28) + 1, i % 24, (i * 7) % 60)).toISOString();
    case "checkbox": return i % 2 === 0;
    case "string_list": {
      const n = style === "long" ? 40 : style === "short" ? 1 : 4;
      return Array.from({ length: n }, (_, k) => pick(words, i + k) + (style === "long" ? "" : ` ${k}`));
    }
    case "checklist": {
      const n = style === "long" ? 30 : style === "short" ? 1 : 5;
      return Array.from({ length: n }, (_, k) => `[${k % 3 === 0 ? "x" : " "}] ${pick(words, i + k)}`);
    }
    default: return extra.value ?? null;
  }
}

/** Every stored field kind once (component and AI fields only when asked). */
function allKindFields({ target = null, component = null, ai = false, namePrefix = "", longNames = false } = {}) {
  const n = (s) => namePrefix + (longNames ? `${s} with a field name that is much longer than usual to test label wrapping` : s);
  const f = [
    { key: "title", name: n("Title"), kind: "string" },
    { key: "notes", name: n("Notes"), kind: "markdown" },
    { key: "html", name: n("Snippet"), kind: "html" },
    { key: "count", name: n("Count"), kind: "number" },
    { key: "date", name: n("Date"), kind: "date" },
    { key: "when", name: n("When"), kind: "datetime" },
    { key: "done", name: n("Done"), kind: "checkbox" },
    { key: "fav", name: n("Favourite"), kind: "checkbox", toggleIcon: "star" },
    { key: "cover", name: n("Cover"), kind: "image" },
    { key: "tags", name: n("Tags"), kind: "string_list" },
    { key: "todo", name: n("Todo"), kind: "checklist" },
  ];
  if (target) {
    f.push({ key: "ref", name: n("Related"), kind: "item", target });
    f.push({ key: "refs", name: n("Links"), kind: "item_list", target });
  }
  if (component) f.push({ key: "comp", name: n("Computed"), kind: "component", component });
  if (ai) f.push({ key: "ai", name: n("Summary"), kind: "ai", code: `Summarise {{ $item[${JSON.stringify(n("Title"))}] }}`, output: "string" });
  return f;
}

/** Items with a value for every field of allKindFields in a content style. */
function allKindItems(count, style, { target = null, targetCount = 0, image = "img0", empty = false, keyPrefix = "i" } = {}) {
  return Array.from({ length: count }, (_, i) => {
    if (empty) return { key: `${keyPrefix}${i}`, values: {} };
    const values = {};
    for (const k of ["string", "markdown", "html", "number", "date", "datetime", "checkbox", "string_list", "checklist"]) {
      const key = { string: "title", markdown: "notes", html: "html", number: "count", date: "date", datetime: "when", checkbox: "done", string_list: "tags", checklist: "todo" }[k];
      values[key] = contentValue(k, style, i);
    }
    values.fav = i % 3 === 0;
    if (image) values.cover = { image: Array.isArray(image) ? pick(image, i) : image };
    if (target && targetCount) {
      values.ref = { ref: `${target}/t${i % targetCount}` };
      const n = style === "long" ? Math.min(targetCount, 25) : Math.min(targetCount, 3);
      values.refs = { refs: Array.from({ length: n }, (_, k) => `${target}/t${(i + k) % targetCount}`) };
    }
    return { key: `${keyPrefix}${i}`, values };
  });
}

const IMAGES = [
  { key: "img0", w: 320, h: 200 },
  { key: "tall", w: 120, h: 900, from: "#24a148", to: "#a7f0ba" },
  { key: "wide", w: 1600, h: 120, from: "#da1e28", to: "#ffb3b8" },
  { key: "square", w: 64, h: 64, from: "#8a3ffc", to: "#d4bbff" },
];

/**
 * A complete data set in one content style: a "Books" collection with every field kind
 * (referencing "Authors"), a component, and `items` books. Keys: books / authors, items
 * books/i0…, authors/t0….
 */
function profileSpec(style, { items = 12, authors = 6, fieldsExtra = 0, longNames = false, collectionsExtra = 0, ai = false } = {}) {
  const name = style === "long" ? "Book with an exceptionally long collection name for testing" : style === "unicode" ? "書籍 📚" : style === "unbroken" ? "Bookkeepingrecordsandmorewordswithoutspaces" : "Book";
  const plural = style === "long" ? "Books with an exceptionally long collection name for testing" : style === "unicode" ? "書籍コレクション 📚" : style === "unbroken" ? "Bookkeepingrecordsandmorewordswithoutspacess" : "Books";
  const extra = Array.from({ length: fieldsExtra }, (_, k) => ({ key: `x${k}`, name: longNames ? `Extra field number ${k} with a long name` : `Extra ${k}`, kind: pick(["string", "number", "date", "checkbox", "string"], k) }));
  const books = {
    key: "books", name, plural, icon: "Book",
    description: style === "long" ? TEXT.long.join(" ") : style === "unicode" ? TEXT.unicode.join(" · ") : "Books I have read or want to read.",
    fields: [...allKindFields({ target: "authors", component: "double", longNames, ai }), ...extra],
    items: allKindItems(items, style, { target: "authors", targetCount: authors, image: ["img0", "tall", "wide", "square"] }).map((it, i) => {
      for (const e of extra) it.values[e.key] = contentValue(e.kind, style, i + 1);
      return it;
    }),
  };
  const authorsColl = {
    key: "authors", name: "Author", plural: "Authors", icon: "User",
    fields: [{ key: "name", name: "Name", kind: "string" }, { key: "bio", name: "Bio", kind: "markdown" }, { key: "born", name: "Born", kind: "date" }],
    items: Array.from({ length: authors }, (_, i) => ({ key: `t${i}`, values: { name: contentValue("string", style, i + 3), bio: contentValue("markdown", style === "long" ? "typical" : style, i), born: contentValue("date", style, i) } })),
  };
  const more = Array.from({ length: collectionsExtra }, (_, k) => ({
    key: `c${k}`, name: style === "long" ? `Collection number ${k} with a long name to fill the side navigation` : `Collection ${k}`, plural: style === "long" ? `Collections number ${k} with a long name to fill the side navigation` : `Collection ${k}s`,
    icon: pick(["Book", "User", "Calendar", "Music", "Location", "Task", "Folder", "Star"], k),
    fields: [{ key: "name", name: "Name", kind: "string" }],
    items: Array.from({ length: k % 4 }, (_, i) => ({ values: { name: `Item ${i}` } })),
  }));
  return {
    images: IMAGES,
    // Reads the books' Count field by its name (which the long-names variant makes long).
    components: [{ key: "double", name: style === "long" ? "Double the count component with a long name" : "Double", code: `{{ ($item[${JSON.stringify(allKindFields({ longNames }).find((f) => f.key === "count").name)}] ?? 0) * 2 }}`, output: "markdown" }],
    collections: [books, authorsColl, ...more],
  };
}

/** A chart and a map block for the matrix (the map has no location field: it shows its message on the stubbed style). */
const MATRIX_CHART = { kind: "chart", title: "Chart", options: { chart: "bar", x: { by: "field", field: "@done" }, series: [{ id: "a", value: "sum", field: "@count", label: "", style: null, axis: "left", transform: "none", window: 3 }] } };
const MATRIX_MAP = { kind: "map", title: "Map", options: { locationFieldId: null, longitudeFieldId: null, height: 20, aspect: "none", route: false } };

/** The profile plus views that exercise every block type. */
function matrixSpec(style, opts = {}) {
  const spec = profileSpec(style, opts);
  const books = spec.collections[0];
  // `opts.filterBar`: one more view with the filter bar shown and a date period (this month, by Updated: everything seeded now).
  const filterBarView = opts.filterBar ? [{ name: "Filter bar", filterBar: true, filters: [{ id: "fb-period", fieldId: "$updated", operator: "between", value: "month+0" }], blocks: [{ kind: "table" }] }] : [];
  books.views = [
    { name: "All", blocks: [{ kind: "table" }] },
    { name: "Cards", blocks: [{ kind: "cards", options: { coverFieldId: "@cover", cardWidth: 14, coverRatio: "auto", showTitle: true, coverBeside: false } }] },
    { name: "Grouped", blocks: [{ kind: "table", groupBy: "done" }] },
    {
      name: "Blocks",
      blocks: [
        { kind: "markdown", title: "Notes", options: { text: MARKDOWN[style] || MARKDOWN.typical } },
        { kind: "table", title: style === "long" ? TEXT.long[0] : "Table", layout: { fields: ["title", "count", "date", "done", "tags"] } },
        { kind: "cards", title: "Cards", options: { coverFieldId: "@cover", cardWidth: 10, coverRatio: "1/1", showTitle: true, coverBeside: false } },
        { kind: "component", local: "{{ 21 * 2 }}" },
        ...(opts.drawn ? [MATRIX_CHART, MATRIX_MAP] : []),
      ],
    },
    ...filterBarView,
  ];
  // `drawn`: the item page with one block of every kind that draws itself (chart, map) next to table,
  // cards and markdown, all of which must fit the pane and share its right edge (design.js, edge-align).
  if (opts.drawn) books.itemViews = [{
    name: "Everything",
    layout: {
      fields: ["title", "notes", "count", "chartB", "mapB", "tableB", "cardsB", "mdB"],
      blocks: [
        { id: "chartB", collection: "books", ...MATRIX_CHART },
        { id: "mapB", collection: "books", ...MATRIX_MAP },
        { id: "tableB", kind: "table", collection: "books", title: "Table", layout: { fields: ["title", "count", "date", "done", "tags"] } },
        { id: "cardsB", kind: "cards", collection: "books", title: "Cards", options: { coverFieldId: "@cover", cardWidth: 10, coverRatio: "1/1", showTitle: true, coverBeside: false } },
        { id: "mdB", kind: "markdown", title: "Notes", options: { text: MARKDOWN[style] || MARKDOWN.typical } },
      ],
    },
  }];
  spec.bookmarks = [
    { kind: "item", collection: "books", item: "books/i0", label: style === "long" ? TEXT.long[1] : "First book" },
    { kind: "view", collection: "books", view: "books/Cards", label: "Books / Cards" },
  ];
  return spec;
}

/** A workspace layout for localStorage: panes of tabs (paths), side by side or stacked. */
function wsLayout(panesPaths, { direction = "row", active = 0, sizes } = {}) {
  let n = 0;
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const panes = panesPaths.map((paths) => {
    const tabs = paths.map((path) => ({ id: id(), path, nav: 0 }));
    return { kind: "pane", id: id(), tabs, activeTabId: tabs.length ? tabs[tabs.length - 1].id : "" };
  });
  if (panes.length === 1) return { root: panes[0], activePaneId: panes[0].id };
  return {
    root: { kind: "split", id: id(), direction, children: panes, sizes: sizes || panes.map(() => 1 / panes.length) },
    activePaneId: panes[active].id,
  };
}

// ---- the suite's own calendar (local days; the app's is not used to expect rows) ----

const pad2 = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/** Noon, `n` days from today (local): its day is the same whatever the time of the run. */
const dayAt = (n) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d;
};
const dayStr = (n) => ymd(dayAt(n));
const sundayOf = (d) => {
  const s = new Date(d);
  s.setDate(s.getDate() - s.getDay());
  return s;
};

/** [first, last] day ("yyyy-mm-dd") of the day / week / month / year `offset` units from today's (the suite's own calendar, not the app's). */
function periodDays(kind, offset = 0) {
  const t = dayAt(0);
  if (kind === "day") return [dayStr(offset), dayStr(offset)];
  if (kind === "week") {
    const s = sundayOf(t);
    s.setDate(s.getDate() + 7 * offset);
    const e = new Date(s);
    e.setDate(e.getDate() + 6);
    return [ymd(s), ymd(e)];
  }
  if (kind === "month") return [ymd(new Date(t.getFullYear(), t.getMonth() + offset, 1)), ymd(new Date(t.getFullYear(), t.getMonth() + offset + 1, 0))];
  return [`${t.getFullYear() + offset}-01-01`, `${t.getFullYear() + offset}-12-31`];
}
