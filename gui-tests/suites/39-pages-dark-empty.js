// The rest of the pages matrix: long content on the wide window, the dark theme, an empty database, empty collections and items.
// (the pages and the test are in lib/matrix.js)

matrixTests("long", ["wide"]);

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
        { key: "nofields", name: "Fieldless", plural: "Fieldless", fields: [{ key: "gone", name: "Gone", kind: "string" }], items: [{ values: {} }, { values: {} }] },
      ],
    });
    // The app saves no collection without fields, but one can arrive so from another device (its
    // last field deleted there): its field is deleted underneath, as a sync would.
    await t.page.evaluate(async (id) => {
      const { repo } = window.kubus;
      await repo.db.write([{ sql: "UPDATE fields SET deleted_at = ?1 WHERE collection_id = ?2", bind: [new Date().toISOString(), id] }]);
      repo.emit({ scope: "collections" });
    }, ids.collections.nofields);
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
