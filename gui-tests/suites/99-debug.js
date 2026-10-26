test("md sizes", async (t) => {
  await t.boot();
  const spec = profileSpec("typical", { items: 1 });
  spec.collections[0].items.push({ key: "same", values: { title: "Same", notes: "Plain text, **bold**." } });
  const ids = await t.seed(spec);
  await t.open(t.itemPath(ids.collections.books, ids.items["books/same"]));
  const r = await t.page.locator(".item-fields .md-view").first().evaluate((root) => {
    const out = [];
    for (let n = root.querySelector("p"); n && n !== document.body; n = n.parentElement) { const s = getComputedStyle(n); out.push(`${n.tagName}.${[...n.classList].slice(0, 3).join(".")} ${s.fontSize}/${s.lineHeight}/${s.letterSpacing} var=${s.getPropertyValue("--cds-body-01-font-size")}`); }
    return out.slice(0, 8);
  });
  await t.check("sizes", false, r.join("\n"));
});
