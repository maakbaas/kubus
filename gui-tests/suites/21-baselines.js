// Screenshot baselines: key states of the app compared pixel by pixel with the screenshots in
// gui-tests/baselines/ (run.mjs; --update-baselines stores new ones, a deliberate commit). The
// pages of typical content at a desktop and a phone size, light and dark, a popover and a dialog
// open. Only states without the time of day or "now" in them: seeded data, fixed sizes, bundled
// fonts, no animations, the pointer out of the way.

/** The key states; `smoke` ones are in the quick smoke run too. */
async function baselineStates(t, ids) {
  const books = ids.collections.books;
  const states = [
    ["collections", "/collections"],
    ["table", `/collections/${books}/items`],
    ["cards", `/collections/${books}/items?view=${ids.views["books/Cards"]}`],
    ["blocks", `/collections/${books}/items?view=${ids.views["books/Blocks"]}`],
    ["item", `/collections/${books}/items/${ids.items["books/i0"]}`],
    ["collection-editor", `/collections/${books}/edit`],
    ["help", "/help"],
  ];
  for (const [name, path] of states) {
    await t.open(path);
    await t.baseline(name);
  }
  // A popover and a dialog.
  await t.open(`/collections/${books}/items`);
  await t.openPanel(t.page.locator(".ws-pane--active .block").first().locator(".section-header").first(), "Block settings");
  await t.baseline("block-settings");
  await t.page.keyboard.press("Escape");
  await t.open(`/collections/${books}/items/${ids.items["books/i0"]}`);
  await t.page.getByRole("button", { name: "Delete Book" }).filter({ visible: true }).first().click().catch(async () => {
    await t.page.getByRole("button", { name: "More actions" }).filter({ visible: true }).first().click();
    await t.page.getByRole("button", { name: "Delete Book" }).filter({ visible: true }).first().click();
  });
  await t.page.locator(".cds--modal.is-visible").waitFor();
  await t.baseline("delete-dialog");
}

for (const vp of ["desktop", "phone"]) {
  for (const dark of [false, true]) {
    test(`baselines @ ${vp}${dark ? ", dark" : ""}`, async (t) => {
      await t.boot();
      const ids = await t.seed(matrixSpec("typical", { items: 6 }));
      await baselineStates(t, ids);
    }, { viewport: vp, dark, smoke: !dark });
  }
}
