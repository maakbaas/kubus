// Window-size sweeps (resized live, no reload: responsive breakpoints must hold at every width
// and height), scale (many collections, fields, views, items), dark theme popovers and rapid
// interaction.

const SWEEP_WIDTHS = [320, 360, 390, 430, 480, 560, 640, 672, 700, 768, 820, 900, 1000, 1055, 1056, 1100, 1151, 1152, 1280, 1366, 1440, 1600, 1920, 2560];
const SWEEP_HEIGHTS = [360, 480, 568, 700, 900, 1200];

for (const [label, pathOf] of [
  ["collection table", (ids) => `/collections/${ids.collections.books}/items`],
  ["collection blocks", (ids) => `/collections/${ids.collections.books}/items?view=${ids.views["books/Blocks"]}`],
  ["item page", (ids) => `/collections/${ids.collections.books}/items/${ids.items["books/i0"]}`],
  ["collection editor", (ids) => `/collections/${ids.collections.books}/edit`],
  ["collections overview", () => "/collections"],
]) {
  test(`width sweep 320–2560px: ${label}`, async (t) => {
    await t.boot();
    const ids = await t.seed(matrixSpec("long", { items: 8 }));
    await t.open(pathOf(ids));
    for (const w of SWEEP_WIDTHS) {
      await t.page.setViewportSize({ width: w, height: 800 });
      await t.settle(150);
      await t.audit(`${w}px wide`, { shotOnFail: true });
    }
    // And back down quickly (a resize storm), then a final check.
    for (const w of [...SWEEP_WIDTHS].reverse()) await t.page.setViewportSize({ width: w, height: 800 });
    await t.page.setViewportSize({ width: 1280, height: 800 });
    await t.audit("after a resize storm");
  }, { heavy: true });
}

test("height sweep: popovers stay in the window", async (t) => {
  await t.boot();
  const ids = await t.seed(matrixSpec("typical", { items: 8 }));
  await t.open(t.listPath(ids.collections.books));
  for (const h of SWEEP_HEIGHTS) {
    await t.page.setViewportSize({ width: 1280, height: h });
    await t.settle(150);
    for (const label of ["Filter", "View settings"]) {
      await t.page.locator(".views-bar").getByRole("button", { name: label, exact: true }).first().click().catch(() => {});
      await t.settle(150);
      await t.audit(`${label} at ${h}px high`, { shotOnFail: true });
      await t.closeAll();
    }
    await t.page.locator(".block .section-header").first().getByRole("button", { name: "Fields", exact: true }).click().catch(() => {});
    await t.settle(150);
    await t.audit(`block fields at ${h}px high`, { shotOnFail: true });
    await t.closeAll();
  }
});

for (const vp of ["desktop", "phone"]) {
  test(`scale: 60 collections, 80 fields, 30 views @ ${vp}`, async (t) => {
    await t.boot();
    // The same pages of an ordinary collection (15 fields) first: they set the machine's pace.
    const plain = await t.seed(matrixSpec("typical", { items: 20 }));
    const spec = matrixSpec("typical", { items: 20, fieldsExtra: 66, collectionsExtra: 58 });
    for (let i = 0; i < 26; i++) spec.collections[0].views.push({ name: `View ${i}`, blocks: [{ kind: i % 2 ? "cards" : "table" }] });
    const ids = await t.seed(spec);
    const pages = (ids) => [
      ["overview of 60 collections", "/collections"],
      ["collection with 80 fields and 30 views", t.listPath(ids.collections.books)],
      ["item page with 80 fields", t.itemPath(ids.collections.books, ids.items["books/i0"])],
      ["editor with 80 fields", `/collections/${ids.collections.books}/edit`],
      ["new item form with 80 fields", `/collections/${ids.collections.books}/items/new`],
    ];
    const timed = async (path) => {
      const started = Date.now();
      await t.open(path);
      return Date.now() - started;
    };
    const pace = [];
    for (const [, path] of pages(plain)) pace.push(await timed(path));
    for (const [i, [label, path]] of pages(ids).entries()) {
      const ms = await timed(path);
      // 80 fields are ~5× the 15: at most that much longer, with slack (settling has a floor).
      const limit = Math.max(pace[i] * 6, 3000);
      await t.check(`${label}: opens within ${(limit / 1000).toFixed(1)}s, 6× the 15-field page (${(ms / 1000).toFixed(1)}s)`, ms <= limit, `${ms}ms; the 15-field page took ${pace[i]}ms`);
      await t.audit(label);
    }
  }, { viewport: vp, heavy: true });
}

for (const vp of ["desktop", "phone"]) {
  test(`dark theme: popovers, menus and dialogs @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(matrixSpec("typical", { items: 6 }));
    await t.open(t.listPath(ids.collections.books));
    for (const label of ["Filter", "View settings"]) {
      const b = t.page.locator(".views-bar").getByRole("button", { name: label, exact: true }).first();
      if (await b.count()) {
        await b.click();
        await t.audit(`dark: ${label}`);
        await t.closeAll();
      }
    }
    await t.page.locator(".items-table tbody").getByRole("button", { name: "Delete", exact: true }).first().click({ force: true }).catch(() => {});
    await t.settle();
    await t.audit("dark: confirmation dialog");
    await t.closeAll();
    await t.open(t.itemPath(ids.collections.books, ids.items["books/i0"]));
    await t.audit("dark: item page");
  }, { viewport: vp, dark: true });
}

test("rapid interaction: switching tabs, views and pages quickly", async (t) => {
  await t.boot();
  const ids = await t.seed(matrixSpec("typical", { items: 10 }));
  await t.seed({ prefs: { "kubus.workspace.default": wsLayout([["/collections", t.listPath(ids.collections.books), t.itemPath(ids.collections.books, ids.items["books/i0"]), "/components", "/help"]]) } });
  await t.open("/help", { keepTabs: true });
  const tabs = t.page.locator(".ws-pane__tabs .cds--tabs__nav-item");
  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < (await tabs.count()); i++) await tabs.nth(i).click({ timeout: 2000 }).catch(() => {});
  }
  await t.audit("after switching tabs 30 times");
  await tabs.nth(1).click();
  await t.settle();
  const views = t.page.locator(".views-bar .views-tabs [role=tab]");
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < (await views.count()); i++) await views.nth(i).click({ timeout: 2000 }).catch(() => {});
  }
  await t.audit("after switching views 20 times");
  // Double clicks everywhere shouldn't break anything either.
  await t.page.locator(".items-table tbody tr td").first().dblclick().catch(() => {});
  await t.page.locator(".page-header__title").first().dblclick().catch(() => {});
  await t.audit("after double clicks");
});
