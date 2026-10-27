// Every page of the app, in every content style, at every window size: the layout audit must
// pass on each, and a page must load without layout shifts (CLS) once it shows.

const MATRIX_STYLES = ["typical", "long", "unbroken", "unicode", "short"];
const MATRIX_VIEWPORTS = ["phone", "phone-small", "tablet", "laptop", "desktop", "short", "wide"];

/** The pages to visit, given the seeded ids. */
function matrixPages(ids) {
  const books = ids.collections.books;
  const authors = ids.collections.authors;
  return [
    ["collections overview", "/collections"],
    ["collection table", `/collections/${books}/items`],
    ["collection cards", `/collections/${books}/items?view=${ids.views["books/Cards"]}`],
    ["collection grouped", `/collections/${books}/items?view=${ids.views["books/Grouped"]}`],
    ["collection blocks", `/collections/${books}/items?view=${ids.views["books/Blocks"]}`],
    ["item page", `/collections/${books}/items/${ids.items["books/i0"]}`],
    ["item page (other item)", `/collections/${books}/items/${ids.items["books/i1"]}`],
    ["author page", `/collections/${authors}/items/${ids.items["authors/t0"]}`],
    ["new item form", `/collections/${books}/items/new`],
    ["collection editor", `/collections/${books}/edit`],
    ["new collection", "/collections/new"],
    ["components", "/components"],
    ["component editor", `/components/${ids.components.double}`],
    ["new component", "/components/new"],
    ["spaces", "/spaces"],
    ["bookmarks", "/bookmarks"],
    ["search", "/search?q=e"],
    ["settings: sync", "/settings?section=sync"],
    ["settings: AI", "/settings?section=ai"],
    ["help", "/help"],
    ["not found", "/no/such/page"],
  ];
}

for (const style of MATRIX_STYLES) {
  for (const vp of MATRIX_VIEWPORTS) {
    test(`${style} content @ ${vp}`, async (t) => {
      await t.boot();
      // Long content has long field names too (labels of stacked tables, item pages, editors).
      const ids = await t.seed(matrixSpec(style, { items: style === "short" ? 3 : 14, longNames: style === "long" }));
      for (const [label, path] of matrixPages(ids)) {
        await t.open(path);
        await t.audit(label);
        const cls = await t.shifts();
        const biggest = cls <= 0.02 ? [] : await t.shiftSources();
        await t.check(`${label}: no layout shift while loading (CLS ${cls.toFixed(3)})`, cls <= 0.02, [`CLS ${cls.toFixed(3)} > 0.02. Biggest shifts:`, ...biggest].join(String.fromCharCode(10)));
      }
    }, { viewport: vp, smoke: style === "typical" && (vp === "phone" || vp === "desktop") });
  }
}

// Dark theme: same pages, two sizes.
for (const vp of ["desktop", "phone"]) {
  test(`typical content, dark theme @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(matrixSpec("typical"));
    for (const [label, path] of matrixPages(ids)) {
      await t.open(path);
      await t.audit(label);
    }
  }, { viewport: vp, dark: true });
}

// Empty database: every page without any data.
for (const vp of ["desktop", "phone"]) {
  test(`empty database @ ${vp}`, async (t) => {
    await t.boot();
    for (const [label, path] of [["collections", "/collections"], ["components", "/components"], ["spaces", "/spaces"], ["bookmarks", "/bookmarks"], ["search", "/search"], ["search, no hits", "/search?q=zzzz"], ["new collection", "/collections/new"], ["new component", "/components/new"], ["settings", "/settings"], ["help", "/help"], ["missing collection", "/collections/nope/items"], ["missing item", "/collections/nope/items/nope"]]) {
      await t.open(path);
      await t.audit(label);
    }
  }, { viewport: vp });
}

// A collection with no items and only a title field, and one with items but no values at all.
for (const vp of ["desktop", "phone"]) {
  test(`empty collection and empty items @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed({
      images: IMAGES,
      components: [{ key: "double", name: "Double", code: "{{ ($item.Count ?? 0) * 2 }}" }],
      collections: [
        { key: "bare", name: "Thing", plural: "Things", fields: [{ key: "name", name: "Name", kind: "string" }], items: [] },
        { key: "blank", name: "Blank", plural: "Blanks", fields: allKindFields({ target: "bare", component: "double" }), items: allKindItems(4, "typical", { empty: true }) },
        { key: "nofields", name: "Fieldless", plural: "Fieldless", fields: [], items: [{ values: {} }, { values: {} }] },
      ],
    });
    for (const [label, path] of [
      ["no items: table", t.listPath(ids.collections.bare)],
      ["empty items: table", t.listPath(ids.collections.blank)],
      ["empty item page", t.itemPath(ids.collections.blank, ids.items["blank/i0"])],
      ["no fields: table", t.listPath(ids.collections.nofields)],
      ["no fields: item page", t.itemPath(ids.collections.nofields, ids.items["nofields/i0"])],
      ["no fields: editor", `/collections/${ids.collections.nofields}/edit`],
      ["no fields: new item", `/collections/${ids.collections.nofields}/items/new`],
    ]) {
      await t.open(path);
      await t.audit(label);
    }
  }, { viewport: vp });
}
