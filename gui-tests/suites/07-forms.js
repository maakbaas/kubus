// Forms and management pages: creating a collection with every field type through the UI, the
// new item form, components (with failing code), spaces, bookmarks, settings, the collections
// overview's inline editing, the icon picker.

// "AI" is a Component field with "Ask AI" on (no field type of its own).
const FIELD_TYPES = ["String", "Markdown", "HTML", "Number", "Date", "Date & time", "Checkbox", "Image", "Item", "List of strings", "Checklist", "List of items", "Component", "AI"];

for (const vp of ["desktop", "phone", "laptop"]) {
  test(`create a collection with every field type @ ${vp}`, async (t) => {
    await t.boot();
    await t.seed({ collections: [{ key: "authors", name: "Author", plural: "Authors", fields: [{ key: "name", name: "Name", kind: "string" }], items: [{ values: { name: "Ursula" } }] }], components: [{ key: "c", name: "Echo", code: "{{ $item.Name }}" }] });
    await t.open("/collections/new");
    await t.audit("new collection form");
    const name = t.page.getByRole("textbox", { name: "Name" }).first();
    await name.fill("Publication with a long singular name");
    await t.settle();
    await t.check("plural is suggested", (await t.page.getByRole("textbox", { name: "Plural name" }).inputValue()).length > 0);
    await t.page.getByRole("textbox", { name: "Description (optional)" }).fill(TEXT.long[0]);
    for (const [i, type] of FIELD_TYPES.entries()) {
      await t.page.getByRole("button", { name: "Add field" }).click();
      await t.settle(100);
      const rows = t.page.locator(".field-row");
      const row = rows.last();
      await row.getByRole("textbox", { name: "Field name" }).fill(i % 4 === 0 ? `${type} field with an unusually long name to wrap` : `${type} ${i}`);
      const kind = row.locator(".cds--dropdown, .cds--list-box").first();
      await kind.click();
      await t.settle(100);
      if (i === 0) await t.audit("field type menu");
      await t.page.getByRole("option", { name: type === "AI" ? "Component" : type, exact: true }).first().click().catch(async () => {
        await t.fail(`field type "${type}" can be chosen`, "option not found");
        await t.page.keyboard.press("Escape");
      });
      await t.settle(100);
      // Reference fields ask for more: pick the first choice.
      const choose = row.getByRole("combobox").nth(1);
      if (["Item", "List of items"].includes(type) && (await choose.count())) {
        await choose.click().catch(() => {});
        await t.settle(80);
        await t.page.getByRole("option").first().click().catch(() => {});
      }
      // A component field starts with its own component, written here; AI turns "Ask AI" on.
      if (type === "Component") {
        await row.getByRole("textbox", { name: "Code" }).fill("{{ 6 * 7 }}");
        await t.settle(80);
      }
      if (type === "AI") {
        await row.locator(".cds--toggle__switch").first().click();
        await t.settle(80);
        await row.getByRole("textbox", { name: "Prompt" }).fill("Summarise {{ $item.Title }}");
        await t.settle(80);
      }
    }
    await t.audit("every field type added");
    await t.page.locator(".ws-pane--active .ws-pane__body").evaluate((el) => (el.scrollTop = el.scrollHeight));
    await t.audit("bottom of the form");
    await t.page.getByRole("button", { name: "Create collection" }).click();
    await t.settle();
    await t.until("the collection is created and opened", async () => (await t.page.locator(".page-header__title").first().innerText()).includes("Publication") || (await t.page.locator(".page-header__title").first().innerText().catch(() => "")));
    await t.audit("new collection's page");
    // New item form with every field.
    await t.page.getByRole("button", { name: /^New Publication/ }).first().click();
    await t.settle();
    await t.audit("new item form");
    const inputs = t.page.locator(".item-fields--form input.cds--text-input:visible");
    const n = await inputs.count();
    for (let i = 0; i < n; i++) await inputs.nth(i).fill(i === 0 ? TEXT.long[1] : `value ${i}`).catch(() => {});
    await t.audit("new item form filled");
    await t.page.locator(".form-actions").getByRole("button").last().click();
    await t.settle();
    await t.audit("created item");
  }, { viewport: vp });
}

for (const vp of ["desktop", "phone"]) {
  test(`collection editor: reorder, remove, icon picker @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(profileSpec("long", { items: 3, longNames: true }));
    await t.open(`/collections/${ids.collections.books}/edit`);
    await t.audit("editor with long names");
    // Icon picker: open, search, pick.
    await t.page.locator(".title-edit").getByRole("button").first().click();
    await t.settle();
    await t.audit("icon picker open");
    await t.page.keyboard.type("arrow");
    await t.settle(300);
    await t.audit("icon picker filtered");
    await t.page.keyboard.press("Control+A");
    await t.page.keyboard.type("zzzznothing");
    await t.settle(300);
    await t.audit("icon picker without matches");
    await t.page.keyboard.press("Escape");
    await t.settle();
    // Remove a field and add one: no jumps in the rows above.
    const rows = t.page.locator(".field-row");
    const before = await rows.count();
    await rows.last().scrollIntoViewIfNeeded();
    await t.noShift("removing the last field moves the rows above nothing", async () => {
      await rows.last().getByRole("button", { name: /Remove field/ }).click();
    }, { scope: ".form-page", except: [".field-row:last-of-type", ".add-field", ".form-actions"], inPage: true });
    await t.check("a field was removed", (await rows.count()) === before - 1, `${before} → ${await rows.count()}`);
    // Drag the first field below the second (reorder handle).
    const handle = rows.first().locator("[data-reorder-handle]").first();
    if (await handle.count()) {
      const target = await rows.nth(2).boundingBox();
      await handle.dragTo(rows.nth(2), { targetPosition: { x: 20, y: target.height - 4 } }).catch(() => {});
      await t.settle();
      await t.audit("after reordering");
    }
    await t.page.getByRole("button", { name: "Save changes" }).click();
    await t.settle();
    await t.audit("saved");
  }, { viewport: vp });

  test(`components: list, editor, failing code, write with AI box @ ${vp}`, async (t) => {
    await t.boot();
    const spec = profileSpec("typical", { items: 3 });
    spec.components.push(
      { key: "broken", name: "Broken component", code: "{{ $item.nope.deeper }} and {{ throw new Error('boom') }}" },
      { key: "html", name: "HTML output", code: "{{ '<div style=\"height:900px;width:3000px\">wide</div>' }}", output: "html" },
      ...Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, name: i % 4 ? `Component ${i}` : `Component ${i} with a very long name that goes on`, description: i % 3 ? "" : TEXT.long[0], code: `{{ ${i} }}`, ai: i === 5 })),
    );
    spec.collections[0].fields.push({ key: "broken", name: "Broken", kind: "component", component: "broken" }, { key: "htmlc", name: "Wide HTML", kind: "component", component: "html" });
    const ids = await t.seed(spec);
    await t.open("/components");
    await t.audit("22 components");
    await t.open(`/components/${ids.components.broken}`);
    await t.audit("editor of a failing component");
    await t.open(`/components/${ids.components.html}`);
    await t.audit("editor of an HTML component");
    await t.open(t.itemPath(ids.collections.books, ids.items["books/i0"]));
    await t.audit("item page with failing and wide HTML components");
    await t.open("/components/new");
    const code = t.page.getByRole("textbox", { name: /Component|JavaScript/ }).first();
    await code.click().catch(() => {});
    await t.page.keyboard.type("**{{ $item.Title }}**: {{ Math.round($pages / 40) }} h {{ syntax error ( }}");
    await t.settle(400);
    await t.audit("typing code with a syntax error");
    await t.page.getByRole("textbox", { name: "Name" }).first().fill("A new component with a long name for the header");
    await t.settle();
    await t.audit("new component filled");
  }, { viewport: vp });

  test(`spaces and bookmarks pages with many long entries @ ${vp}`, async (t) => {
    await t.boot();
    const spec = matrixSpec("long", { items: 6 });
    spec.spaces = Array.from({ length: 12 }, (_, i) => ({ key: `s${i}`, name: i % 3 ? `Space ${i}` : `Space ${i} with an extraordinarily long name that keeps going` }));
    spec.bookmarks = Array.from({ length: 6 }, (_, i) => ({ kind: "item", collection: "books", item: `books/i${i}`, label: i % 2 ? `Bookmark ${i}` : TEXT.long[i % 2] })).concat([{ kind: "view", collection: "books", view: "books/Cards", label: "Cards view" }]);
    await t.seed(spec);
    await t.open("/spaces");
    await t.audit("12 spaces");
    await t.page.getByRole("button", { name: "New space" }).first().click();
    await t.settle();
    await t.audit("new space");
    await t.page.keyboard.type("Typed space name");
    await t.page.keyboard.press("Enter");
    await t.settle();
    await t.audit("space added");
    const rename = t.page.getByRole("button", { name: /^Rename / }).first();
    if (await rename.count()) {
      await rename.click();
      await t.settle();
      await t.audit("renaming a space");
      await t.page.keyboard.press("Escape");
    }
    await t.open("/bookmarks");
    await t.audit("bookmarks");
    await t.page.getByRole("button", { name: "New bookmark" }).first().click();
    await t.settle();
    await t.audit("new bookmark dialog");
    await t.closeAll();
    const remove = t.page.getByRole("button", { name: /^Remove bookmark/ }).first();
    if (await remove.count()) {
      await remove.click();
      await t.settle();
      await t.audit("after removing a bookmark");
    }
    // The side nav lists them (bookmarks branch with long labels).
    if (t.phone) await t.page.getByRole("button", { name: "Show menu" }).first().click();
    await t.settle();
    await t.audit("side nav with bookmarks and many spaces");
  }, { viewport: vp });

  test(`settings: sync and AI forms with long values @ ${vp}`, async (t) => {
    await t.boot();
    await t.open("/settings?section=sync");
    await t.audit("sync settings");
    const fill = async (name, value) => {
      const box = t.page.getByRole("textbox", { name }).first();
      if (await box.count()) await box.fill(value);
    };
    await fill(/URL|Server|Address/, "https://a-very-long-subdomain-name.example-hosting-provider.com/path/to/kubus/server/instance");
    await fill(/Token/, "x".repeat(120));
    await t.audit("sync settings filled");
    await t.open("/settings?section=ai");
    await t.audit("AI settings");
    await fill(/Address/, "https://openrouter.ai/api/v1/and/a/long/path/that/does/not/exist");
    await fill(/API key/, "sk-" + "y".repeat(100));
    await t.audit("AI settings filled");
    // The tabs of the settings page.
    const tabs = t.page.locator(".ws-tab-slot:not([hidden]) [role=tab]");
    for (let i = 0; i < (await tabs.count()); i++) {
      await tabs.nth(i).click();
      await t.settle();
      await t.audit(`settings tab ${i + 1}`);
    }
  }, { viewport: vp });

  test(`collections overview: inline description, duplicate, delete @ ${vp}`, async (t) => {
    await t.boot();
    await t.seed(profileSpec("long", { items: 2, collectionsExtra: 6 }));
    await t.open("/collections");
    await t.audit("overview");
    const desc = t.page.locator(".cell-editable[aria-label^='Edit description of']").first();
    if (await desc.count()) {
      await t.noShift("editing a description in place moves nothing", async () => {
        await desc.click();
        await t.wait(200);
      }, { scope: ".ws-pane--active .ws-pane__body", except: [".cell-inline-editor", ".cell-overlay"] });
      await t.page.keyboard.type(" — edited");
      await t.page.keyboard.press("Enter");
      await t.settle();
      await t.until("description saved", async () => (await t.page.locator(".ws-pane--active .ws-pane__body").innerText()).includes("— edited"));
    }
    await t.page.getByRole("button", { name: /^Duplicate .* collection$/ }).first().click().catch(() => {});
    await t.settle();
    await t.audit("after duplicating a collection");
    await t.page.getByRole("button", { name: /^Delete .* collection$/ }).first().click().catch(() => {});
    await t.settle();
    await t.audit("delete collection confirmation");
    await t.closeAll();
  }, { viewport: vp });
}
