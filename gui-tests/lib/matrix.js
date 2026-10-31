// Shared by the pages-matrix suites (01, 35, 36): every page of the app, in a content style, at some window sizes:
// the layout audit must pass on each, and a page must load without layout shifts (CLS) once it shows.

/** The pages to visit, given the seeded ids. */
function matrixPages(ids) {
  const books = ids.collections.books;
  const authors = ids.collections.authors;
  return [
    ["home", "/"],
    ["collections overview", "/collections"],
    ["collection table", `/collections/${books}/items`],
    ["collection cards", `/collections/${books}/items?view=${ids.views["books/Cards"]}`],
    ["collection grouped", `/collections/${books}/items?view=${ids.views["books/Grouped"]}`],
    ["collection blocks", `/collections/${books}/items?view=${ids.views["books/Blocks"]}`],
    // The filter bar (Show filter bar) with a date period: its Filter button, ‹ label ›, "this one" and the kind.
    ["collection filter bar", `/collections/${books}/items?view=${ids.views["books/Filter bar"]}`],
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
    // Dashboards (seeded with `dashboard`): the list, a tab of blocks of two collections, a tab with the filter bar and a merged block.
    ...(ids.dashboards && ids.dashboards.overview
      ? [
          ["dashboards", "/dashboards"],
          ["dashboard", `/dashboards/${ids.dashboards.overview}`],
          ["dashboard filter bar", `/dashboards/${ids.dashboards.overview}?view=${ids.dashboardViews["overview/This month"]}`],
        ]
      : []),
    ["search", "/search?q=e"],
    ["settings: display", "/settings?section=display"],
    ["settings: server", "/settings?section=server"],
    ["settings: sync", "/settings?section=sync"],
    ["settings: connections", "/settings?section=connections"],
    ["settings: AI", "/settings?section=ai"],
    ["settings: API tokens", "/settings?section=tokens"],
    ["help", "/help"],
    ["not found", "/no/such/page"],
  ];
}

/** Registers one test per window size of every page in this content style. */
function matrixTests(style, viewports) {
  for (const vp of viewports) {
    test(`${style} content @ ${vp}`, async (t) => {
      await t.boot();
      // The map blocks' style comes from OpenFreeMap: a blank one, so the pages load offline.
      const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
      await t.page.route("https://tiles.openfreemap.org/**", (route) => {
        if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
        if (route.request().url().includes("/styles/")) return route.fulfill({ status: 200, headers: CORS, json: { version: 8, name: "stub", sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#ffffff" } }] } });
        return route.fulfill({ status: 404, headers: CORS, body: "" });
      });
      // Long content has long field names too (table headers, card labels, item pages, editors).
      const ids = await t.seed(matrixSpec(style, { drawn: true, items: style === "short" ? 3 : 14, longNames: style === "long", filterBar: true, dashboard: true }));

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
