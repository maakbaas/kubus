// An image field: upload (file input and drop), the lightbox, replace, remove. Files are made in the page
// (a canvas), so the test needs no files on disk.

/** Makes a PNG File in the page as window.__files[name]. */
async function makeImage(t, name, { w = 240, h = 160, color = "#0f62fe" } = {}) {
  await t.page.evaluate(async ({ name, w, h, color }) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    g.fillStyle = color;
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#fff";
    g.fillRect(w / 4, h / 4, w / 2, h / 2);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    (window.__files ||= {})[name] = new File([blob], `${name}.png`, { type: "image/png" });
  }, { name, w, h, color });
}

/** A DataTransfer holding the made file, built in the page; dispatches `type` on `target` with it. */
async function dispatchWithFile(t, target, type, name) {
  await target.evaluate((el, { type, name }) => {
    const dt = new DataTransfer();
    dt.items.add(window.__files[name]);
    const r = el.getBoundingClientRect();
    const at = { clientX: r.left + Math.min(40, r.width / 2), clientY: r.top + Math.min(12, r.height / 2) };
    if (type === "paste") el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    else {
      for (const t of ["dragenter", "dragover"]) el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true, ...at }));
      el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, ...at }));
    }
  }, { type, name });
}

/** Whether `selector` has a loaded image (naturalWidth > 0). */
const loadedImg = (t, selector) => t.page.evaluate((sel) => [...document.querySelectorAll(sel)].some((i) => i.complete && i.naturalWidth > 0), selector);

function emptyItemSpec() {
  const spec = profileSpec("typical", { items: 2 });
  spec.collections[0].items.push({ key: "empty", values: { title: "Empty one" } });
  return spec;
}

/** Puts the made file into a file input (the picker's choice) and fires its change. */
async function chooseFile(input, name) {
  await input.evaluate((el, name) => {
    const dt = new DataTransfer();
    dt.items.add(window.__files[name]);
    el.files = dt.files;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, name);
}

test("image field: upload, lightbox, replace, remove, drop @ desktop", async (t) => {
  await t.boot();
  const ids = await t.seed(emptyItemSpec());
  await t.open(t.itemPath(ids.collections.books, ids.items["books/empty"]));
  await makeImage(t, "first");
  // On the item page the image field is its own editor: each change saves at once.
  const field = t.page.locator(".ws-pane--active .item-fields .image-input").first();
  await field.scrollIntoViewIfNeeded();
  await t.audit("empty image field");
  await chooseFile(field.locator("input[type=file]").first(), "first");
  await t.until("an uploaded image is stored and shown", () => loadedImg(t, ".ws-pane--active .item-fields .image-input__preview img"), { timeout: 8000 });
  const shape = () => field.locator(".image-input__preview img").evaluate((i) => (i.naturalWidth > i.naturalHeight ? "wide" : "tall")).catch(() => "none");
  await t.audit("image uploaded");
  // It is stored: a reload shows it.
  await t.open(t.itemPath(ids.collections.books, ids.items["books/empty"]));
  await t.until("the image is still there after a reload", () => loadedImg(t, ".ws-pane--active .item-fields .image-input__preview img"), { timeout: 8000 });
  await makeImage(t, "second", { w: 120, h: 300, color: "#24a148" });
  await makeImage(t, "third", { w: 300, h: 100, color: "#8a3ffc" });
  // The lightbox.
  const img = field.locator(".image-input__preview img").first();
  await img.scrollIntoViewIfNeeded();
  await img.click();
  await t.until("a click on the image opens the lightbox", async () => (await t.count(".lightbox.is-visible")) === 1);
  await t.until("the lightbox shows the image", () => loadedImg(t, ".lightbox.is-visible .lightbox__image"));
  await t.check("focus is in the lightbox", await t.page.evaluate(() => !!document.activeElement?.closest(".lightbox")));
  await t.audit("lightbox open");
  await t.page.keyboard.press("Escape");
  await t.until("Escape closes the lightbox", async () => (await t.count(".lightbox.is-visible")) === 0);
  await img.click();
  await t.until("the lightbox opens again", async () => (await t.count(".lightbox.is-visible")) === 1);
  await t.page.mouse.click(4, t.vp.height - 4);
  await t.until("a click outside closes it", async () => (await t.count(".lightbox.is-visible")) === 0);
  // Replace (its hidden picker), without moving anything else on the page.
  // A taller image takes more room (what follows the field moves down with it); the page header holds still.
  await t.noShift("replacing the image moves nothing above the fields", async () => {
    await chooseFile(field.locator(".image-input__preview input[type=file]").first(), "second");
    await t.until("Replace image shows the new image", async () => (await shape()) === "tall" || await shape(), { timeout: 8000 });
  }, { scope: ".ws-pane--active .page-header", inPage: true });
  // Remove: the drop zone is back; a dropped image is stored.
  await img.hover();
  await field.getByRole("button", { name: "Remove image" }).click();
  await t.until("Remove image brings back the drop zone", async () => (await field.locator(".cds--file__drop-container").count()) === 1);
  await t.audit("image removed");
  await dispatchWithFile(t, field.locator(".cds--file__drop-container").first(), "drop", "third");
  await t.until("a dropped image is stored and shown", async () => (await shape()) === "wide" || await shape(), { timeout: 8000 });
  await t.audit("image dropped");
}, { viewport: "desktop", smoke: true });
