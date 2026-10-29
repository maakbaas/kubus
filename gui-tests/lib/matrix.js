// Shared by the pages-matrix suites (01, 35-39): every page of the app, in every content style, at
// every window size: the layout audit must pass on each, and a page must load without layout shifts
// (CLS) once it shows.

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
    ["remotes", "/remotes"],
    ["components", "/components"],
    ["component editor", `/components/${ids.components.double}`],
    ["new component", "/components/new"],
    ["spaces", "/spaces"],
    ["bookmarks", "/bookmarks"],
    ["search", "/search?q=e"],
    ["settings: server", "/settings?section=server"],
    ["settings: sync", "/settings?section=sync"],
    ["settings: connections", "/settings?section=connections"],
    ["settings: AI", "/settings?section=ai"],
    ["settings: API tokens", "/settings?section=tokens"],
    ["help", "/help"],
    ["not found", "/no/such/page"],
  ];
}

/** Registers one test per window size (default: all) of every page in this content style. */
function matrixTests(style, viewports = MATRIX_VIEWPORTS) {
  for (const vp of viewports) {
    test(`${style} content @ ${vp}`, async (t) => {
      await t.boot();
      // Long content has long field names too (table headers, card labels, item pages, editors).
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
