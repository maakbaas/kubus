// Map block and the block options of the other view types, each followed by what it did: the Map
// block (Location as text or Latitude / Longitude as numbers, Show as route, zoom, a dot hovered and
// clicked) against a stubbed OpenFreeMap; Cards (Show title, Cover beside the text, Card width, Cover,
// Cover shape); Table (Title links to the item, Items shown at a time, Show more); the Component and
// Markdown blocks; a block's Name, Hide empty fields, header; the Collection picker of an item page's block.
// Every change is read back from the stored view and shown again after a reload.

// ---- helpers --------------------------------------------------------------------------------

/**
 * Answers OpenFreeMap with a style of one white background and no tiles, so the map draws offline
 * (dots on white) and the test knows where they are. Returns the list of requested URLs.
 */
async function stubMap(t) {
  const requests = [];
  const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
  await t.page.route("https://tiles.openfreemap.org/**", async (route) => {
    const url = route.request().url();
    requests.push(url);
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (url.includes("/styles/")) {
      return route.fulfill({ status: 200, headers: CORS, json: { version: 8, name: "stub", sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#ffffff" } }] } });
    }
    return route.fulfill({ status: 404, headers: CORS, body: "" });
  });
  return requests;
}

/**
 * The dots on the map, found in a screenshot of its canvas (the style is white, the controls hidden):
 * { dots: [{ x, y }] (page coordinates of each blob's centre), ink: the count of drawn pixels }.
 * Blobs that touch (a route joining them) are one, so route tests use `ink`.
 */
async function mapDots(t, { block = 0 } = {}) {
  const canvas = t.page.locator(".map-block__canvas canvas.maplibregl-canvas").nth(block);
  const box = await canvas.boundingBox();
  const png = await canvas.screenshot({ type: "png", style: ".map-block__controls, .map-block__tip-layer, .map-block__message { visibility: hidden !important }" });
  const found = await t.page.evaluate(async (b64) => {
    const blob = await (await fetch("data:image/png;base64," + b64)).blob();
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d");
    g.drawImage(bmp, 0, 0);
    const { data, width, height } = g.getImageData(0, 0, bmp.width, bmp.height);
    const inked = new Uint8Array(width * height);
    let ink = 0;
    for (let i = 0; i < width * height; i++) {
      // Not the 2px along the edges: the block's border can fall into a fractional box.
      const x = i % width;
      const y = (i - x) / width;
      if (x < 2 || y < 2 || x >= width - 2 || y >= height - 2) continue;
      if (data[i * 4] < 225 || data[i * 4 + 1] < 225 || data[i * 4 + 2] < 225) {
        inked[i] = 1;
        ink++;
      }
    }
    const dots = [];
    const stack = [];
    for (let s = 0; s < inked.length; s++) {
      if (inked[s] !== 1) continue;
      let n = 0;
      let sx = 0;
      let sy = 0;
      inked[s] = 2;
      stack.push(s);
      while (stack.length) {
        const p = stack.pop();
        const x = p % width;
        const y = (p - x) / width;
        n++;
        sx += x;
        sy += y;
        for (const q of [p - 1, p + 1, p - width, p + width]) {
          if (q < 0 || q >= inked.length || inked[q] !== 1) continue;
          if ((q === p - 1 && x === 0) || (q === p + 1 && x === width - 1)) continue;
          inked[q] = 2;
          stack.push(q);
        }
      }
      if (n >= 12) dots.push({ x: sx / n, y: sy / n, n });
    }
    return { dots, ink, width, height };
  }, png.toString("base64"));
  const sx = box.width / found.width;
  const sy = box.height / found.height;
  return { dots: found.dots.map((d) => ({ x: box.x + d.x * sx, y: box.y + d.y * sy, n: d.n })), ink: found.ink, box };
}

/** Waits until the map shows `n` separate dots. */
async function dotsShown(t, label, n, opts = {}) {
  let last = null;
  await t.until(label, async () => {
    last = await mapDots(t, opts);
    return last.dots.length === n || `${last.dots.length} dots, expected ${n}: ${JSON.stringify(last.dots.map((d) => [Math.round(d.x), Math.round(d.y), d.n]))} in ${JSON.stringify(last.box)}`;
  }, { timeout: 15000, interval: 250 });
  return last;
}

/** The stored view: { blocks }. */
async function storedView(t, collectionId, viewId) {
  return t.page.evaluate(async ([c, v]) => (await window.kubus.repo.listViews(c, "default")).find((x) => x.id === v), [collectionId, viewId]);
}

/** The block's header and its Block settings (or other) popover opened. */
const header = (t, i = 0) => t.page.locator(".ws-pane--active .block").nth(i).locator(".section-header").first();
const openPopover = (t, label, i = 0) => t.openPanel(header(t, i), label);
/** Saves the view's unsaved changes (a filter, sort, grouping or fields change of a block). */
async function saveView(t) {
  await t.openPanel(t.page.locator(".views-bar").first(), "Save changes to view");
  await t.until("the view is saved", async () => !(await t.page.locator(".views-bar").first().innerText()).includes("*"));
}
/** The title of the item page in the active tab ("" on any other page). */
const itemTitle = (t) => t.page.locator(".ws-pane--active .item-title").first().innerText().then((s) => s.trim(), () => "");
const popover = (t) => t.page.locator(".cds--popover--open").last();

// ---- data -----------------------------------------------------------------------------------

/** Places with text locations in every notation, numbers for latitude and longitude, and some without. */
function placesSpec({ blocks = [] } = {}) {
  const rows = [
    ["Amsterdam", "52.37, 4.89", 52.37, 4.89, "Netherlands"],
    ["Paris", "geo:48.85,2.35", 48.85, 2.35, "France"],
    ["Berlin", "https://www.google.com/maps/@52.52,13.40,12z", 52.52, 13.4, "Germany"],
    ["Rome", "41.9 12.5", 41.9, 12.5, "Italy"],
    ["Nowhere", "no idea where", null, null, "Unknown"],
    ["Blank", "", null, null, "Unknown"],
  ];
  return {
    collections: [
      {
        key: "places", name: "Place", plural: "Places", icon: "Location",
        fields: [
          { key: "name", name: "Name", kind: "string" },
          { key: "where", name: "Position", kind: "string" },
          { key: "lat", name: "Latitude", kind: "number" },
          { key: "lng", name: "Longitude", kind: "number" },
          { key: "country", name: "Country", kind: "string" },
          { key: "note", name: "Note", kind: "string" },
        ],
        items: rows.map(([name, where, lat, lng, country], i) => ({ key: name.toLowerCase(), values: { name, where, lat, lng, country, note: i % 2 ? "" : `Visited in 20${10 + i}` } })),
        views: [{ name: "Map", blocks }],
      },
    ],
  };
}
const mapBlock = (options = {}, extra = {}) => ({ kind: "map", options: { locationFieldId: null, longitudeFieldId: null, height: 20, aspect: "none", route: false, ...options }, ...extra });

// ---- the Map block --------------------------------------------------------------------------

for (const vp of ["desktop", "phone"]) {
  test(`map: Location from a text field, dots, count of places without one @ ${vp}`, async (t) => {
    await t.boot();
    const requests = await stubMap(t);
    const ids = await t.seed(placesSpec({ blocks: [mapBlock()] }));
    const path = `${t.listPath(ids.collections.places)}?view=${ids.views["places/Map"]}`;
    await t.open(path);
    await t.until("a map with no field chosen says so", async () => (await t.page.locator(".map-block__message").innerText().catch(() => "")).includes("Choose the field with the location"));
    await t.until("the map asks OpenFreeMap for its style", async () => requests.some((u) => u.includes("/styles/")) || JSON.stringify(requests));
    await t.audit("map without a location field");
    // Block settings: Location lists the text fields and the number fields, and None.
    await openPopover(t, "Block settings");
    const location = popover(t).getByLabel("Location", { exact: true });
    const offered = await location.locator("option").allInnerTexts();
    await t.check("Location offers None and every text and number field", ["None", "Name", "Position", "Latitude", "Longitude", "Country", "Note"].every((n) => offered.includes(n)), offered.join(", "));
    await location.selectOption({ label: "Position" });
    await t.until("choosing Position stores it", async () => (await storedView(t, ids.collections.places, ids.views["places/Map"])).blocks[0].options.locationFieldId === ids.fields["places.where"]);
    await t.check("a text location has no Longitude select", (await popover(t).getByLabel("Longitude", { exact: true }).count()) === 0);
    await t.audit("map block settings: Location");
    await t.closeAll();
    await t.until("the message goes", async () => (await t.count(".map-block__message")) === 0);
    const shown = await dotsShown(t, "four places in four notations are four dots", 4);
    await t.check("two places have no location", (await t.page.locator(".map-block__legend").innerText()).includes("2 without a location"), await t.page.locator(".map-block__legend").innerText().catch(() => "no legend"));
    await t.check("the dots lie inside the map", shown.dots.every((d) => d.x > shown.box.x && d.x < shown.box.x + shown.box.width && d.y > shown.box.y && d.y < shown.box.y + shown.box.height));
    await t.audit("map with four dots");
    // Back to None: the dots and the legend go, the message is back.
    await openPopover(t, "Block settings");
    await popover(t).getByLabel("Location", { exact: true }).selectOption({ label: "None" });
    await t.closeAll();
    await t.until("None brings the message back", async () => (await t.page.locator(".map-block__message").innerText().catch(() => "")).includes("Choose the field"));
    await dotsShown(t, "no dots without a field", 0);
    await t.check("no legend without a field", (await t.count(".map-block__legend")) === 0);
  }, { viewport: vp, smoke: vp === "desktop" });
}

for (const vp of ["desktop", "phone"]) {
  test(`map: Latitude and Longitude from two number fields, kept after a reload @ ${vp}`, async (t) => {
    await t.boot();
    await stubMap(t);
    const ids = await t.seed(placesSpec({ blocks: [mapBlock()] }));
    const coll = ids.collections.places;
    const view = ids.views["places/Map"];
    const path = `${t.listPath(coll)}?view=${view}`;
    await t.open(path);
    await openPopover(t, "Block settings");
    await t.check("a map starts with the label Location", (await popover(t).getByLabel("Location", { exact: true }).count()) === 1);
    await popover(t).getByLabel("Location", { exact: true }).selectOption({ label: "Latitude" });
    await t.until("a number field turns Location into Latitude and offers a Longitude", async () => (await popover(t).getByLabel("Longitude", { exact: true }).count()) === 1 && (await popover(t).getByLabel("Latitude", { exact: true }).count()) === 1);
    const lngOptions = await popover(t).getByLabel("Longitude", { exact: true }).locator("option").allInnerTexts();
    await t.check("Longitude offers the other number fields but not the latitude", lngOptions.includes("Longitude") && !lngOptions.includes("Latitude") && !lngOptions.includes("Name"), lngOptions.join(", "));
    await t.audit("map block settings: Latitude and Longitude");
    await t.closeAll();
    await t.check("with only a latitude the map asks for the rest", (await t.page.locator(".map-block__message").innerText().catch(() => "")).includes("Choose the field"));
    await openPopover(t, "Block settings");
    await popover(t).getByLabel("Longitude", { exact: true }).selectOption({ label: "Longitude" });
    await t.until("the pair is stored", async () => {
      const o = (await storedView(t, coll, view)).blocks[0].options;
      return (o.locationFieldId === ids.fields["places.lat"] && o.longitudeFieldId === ids.fields["places.lng"]) || JSON.stringify(o);
    });
    await t.closeAll();
    const first = await dotsShown(t, "four places with both numbers are four dots", 4);
    await t.check("two places have no numbers", (await t.page.locator(".map-block__legend").innerText()).includes("2 without a location"));
    // After a reload: the same four dots in the same places.
    await t.open(path);
    const again = await dotsShown(t, "after a reload the map has its four dots", 4);
    const near = (a, b) => Math.abs(a.x - b.x) < 3 && Math.abs(a.y - b.y) < 3;
    const sorted = (r) => [...r.dots].sort((p, q) => p.x - q.x || p.y - q.y);
    await t.check("they are where they were", sorted(first).every((d, i) => near(d, sorted(again)[i])), JSON.stringify([sorted(first), sorted(again)].map((r) => r.map((d) => [Math.round(d.x), Math.round(d.y)]))));
    await t.audit("map from latitude and longitude");
    // Back to a text field: the Longitude select goes, the position text is read again.
    await openPopover(t, "Block settings");
    await popover(t).getByLabel("Latitude", { exact: true }).selectOption({ label: "Position" });
    await t.until("a text field has no Longitude select again", async () => (await popover(t).getByLabel("Longitude", { exact: true }).count()) === 0 && (await popover(t).getByLabel("Location", { exact: true }).count()) === 1);
    await t.closeAll();
    await dotsShown(t, "the text positions give four dots", 4);
  }, { viewport: vp });
}

/** Distance between the two farthest dots. */
const spread = (r) => Math.max(0, ...r.dots.flatMap((a) => r.dots.map((b) => Math.hypot(a.x - b.x, a.y - b.y))));

test("map: zoom in, zoom out and Show all Places", async (t) => {
  await t.boot();
  await stubMap(t);
  const spec = placesSpec({ blocks: [mapBlock({ locationFieldId: "@where" })] });
  spec.collections[0].items = spec.collections[0].items.filter((i) => ["amsterdam", "paris"].includes(i.key));
  const ids = await t.seed(spec);
  await t.open(`${t.listPath(ids.collections.places)}?view=${ids.views["places/Map"]}`);
  const fitted = await dotsShown(t, "two places are two dots", 2);
  const base = spread(fitted);
  await t.check("two places fill the map", base > 150, `${Math.round(base)}px apart`);
  const controls = t.page.locator(".map-block__controls");
  await t.check("zoom buttons are there, and no Show all with only two places? (it needs more than one: it is there)", (await controls.getByRole("button", { name: "Zoom in" }).count()) === 1 && (await controls.getByRole("button", { name: "Zoom out" }).count()) === 1 && (await controls.getByRole("button", { name: "Show all Places" }).count()) === 1);
  await t.audit("map with its controls");
  // Out: the dots come closer by half; in: back to where they were.
  await controls.getByRole("button", { name: "Zoom out" }).click();
  await t.until("Zoom out halves the distance between the dots", async () => {
    const r = await mapDots(t);
    return (r.dots.length === 2 && Math.abs(spread(r) / base - 0.5) < 0.06) || `${r.dots.length} dots, ${Math.round(spread(r))}px of ${Math.round(base)}`;
  }, { timeout: 8000, interval: 300 });
  await controls.getByRole("button", { name: "Zoom in" }).click();
  await t.until("Zoom in brings them back", async () => {
    const r = await mapDots(t);
    return (r.dots.length === 2 && Math.abs(spread(r) / base - 1) < 0.06) || `${r.dots.length} dots, ${Math.round(spread(r))}px of ${Math.round(base)}`;
  }, { timeout: 8000, interval: 300 });
  await controls.getByRole("button", { name: "Zoom in" }).click();
  await t.until("zooming in further moves the dots out of the map", async () => (await mapDots(t)).dots.length < 2, { timeout: 8000, interval: 300 });
  await t.audit("zoomed in");
  await controls.getByRole("button", { name: "Show all Places" }).click();
  await t.until("Show all Places fits them again", async () => {
    const r = await mapDots(t);
    return (r.dots.length === 2 && Math.abs(spread(r) / base - 1) < 0.06) || `${r.dots.length} dots, ${Math.round(spread(r))}px of ${Math.round(base)}`;
  }, { timeout: 8000, interval: 300 });
  // The wheel zooms too (no Ctrl needed).
  const box = (await mapDots(t)).box;
  await t.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await t.page.mouse.wheel(0, 300);
  await t.until("the wheel zooms the map out", async () => {
    const r = await mapDots(t);
    return (r.dots.length === 2 && spread(r) < base * 0.9) || `${r.dots.length} dots, ${Math.round(spread(r))}px of ${Math.round(base)}`;
  }, { timeout: 8000, interval: 300 });
});

test("map: Show as route joins the dots, a group has its own colour and line", async (t) => {
  await t.boot();
  await stubMap(t);
  const ids = await t.seed({
    ...placesSpec({ blocks: [mapBlock({ locationFieldId: "@where" })] }),
  });
  const coll = ids.collections.places;
  const view = ids.views["places/Map"];
  const path = `${t.listPath(coll)}?view=${view}`;
  await t.open(path);
  const plain = await dotsShown(t, "four separate dots", 4);
  await openPopover(t, "Block settings");
  const route = popover(t).getByLabel("Show as route", { exact: true });
  await t.check("Show as route starts off", !(await route.isChecked()));
  await t.audit("map block settings: Show as route (off)");
  await popover(t).getByText("Show as route", { exact: true }).click();
  await t.until("Show as route is stored", async () => (await storedView(t, coll, view)).blocks[0].options.route === true);
  await t.check("the box is checked", await route.isChecked());
  await t.closeAll();
  await t.until("a line joins the dots (more ink, the dots no longer separate)", async () => {
    const r = await mapDots(t);
    return (r.ink > plain.ink + 300 && r.dots.length < 4) || `${r.ink} vs ${plain.ink} ink, ${r.dots.length} dots`;
  }, { timeout: 10000, interval: 300 });
  await t.audit("map with a route");
  await t.open(path);
  await t.until("after a reload the route is still drawn", async () => (await mapDots(t)).ink > plain.ink + 300, { timeout: 10000, interval: 300 });
  await openPopover(t, "Block settings");
  await popover(t).getByText("Show as route", { exact: true }).click();
  await t.until("switching it off is stored", async () => (await storedView(t, coll, view)).blocks[0].options.route === false);
  await t.closeAll();
  await dotsShown(t, "without the route the dots stand apart again", 4);

  // Grouped by country: a legend with a colour per group; each group is a single place, so no line even with the route on.
  await openPopover(t, "Sort and group");
  await popover(t).getByLabel("Group by", { exact: true }).selectOption({ label: "Country" });
  await t.closeAll();
  await saveView(t);
  await t.until("grouping is stored", async () => (await storedView(t, coll, view)).blocks[0].groupBy === ids.fields["places.country"]);
  await t.until("the legend names the groups with a place", async () => {
    const text = await t.page.locator(".map-block__legend").innerText().catch(() => "");
    return ["Netherlands", "France", "Germany", "Italy"].every((c) => text.includes(c)) && !text.includes("Unknown") || text;
  });
  await t.check("the legend counts the places without one", (await t.page.locator(".map-block__legend").innerText()).includes("2 without a location"));
  const colours = await t.page.locator(".map-block__swatch").evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
  await t.check("each group has its own colour", colours.length === 4 && new Set(colours).size === 4, colours.join(" | "));
  await openPopover(t, "Block settings");
  await popover(t).getByText("Show as route", { exact: true }).click();
  await t.closeAll();
  const grouped = await dotsShown(t, "grouped, one place per group, there is no line to join them", 4);
  await t.audit("map grouped by country, with a legend");
});

test("map: hover a dot for its item, click it to open it", async (t) => {
  await t.boot();
  await stubMap(t);
  const spec = placesSpec({ blocks: [mapBlock({ locationFieldId: "@where" }, { layout: { fields: ["country", "note"] } })] });
  const ids = await t.seed(spec);
  const coll = ids.collections.places;
  const view = ids.views["places/Map"];
  const path = `${t.listPath(coll)}?view=${view}`;
  await t.open(path);
  const shown = await dotsShown(t, "four dots", 4);
  // Left to right: Paris (2.35), Amsterdam (4.89), Rome (12.5), Berlin (13.4).
  const [paris, amsterdam, rome, berlin] = [...shown.dots].sort((a, b) => a.x - b.x);
  const tip = t.page.locator(".map-block__tooltip");
  const hover = async (dot) => {
    await t.page.mouse.move(dot.x + 40, dot.y + 40);
    await t.page.mouse.move(dot.x, dot.y, { steps: 3 });
  };
  await hover(paris);
  await t.until("hovering a dot shows its item", async () => (await tip.count()) === 1 || "no tooltip");
  await t.until("the tooltip has the title, then the block's fields", async () => {
    const text = await tip.innerText();
    return (text.startsWith("Paris") && text.includes("Country") && text.includes("France") && text.includes("Note")) || text;
  });
  await t.check("the title is a link to the item", (await tip.locator("a.map-block__title").getAttribute("href")).endsWith(`/items/${ids.items["places/paris"]}`));
  await t.audit("a dot's tooltip");
  // Moving off the dot hides it (after a moment).
  await t.page.mouse.move(paris.x + 60, paris.y + 90);
  await t.until("moving away hides the tooltip", async () => (await tip.count()) === 0, { timeout: 4000 });
  // Hide empty fields (Fields popover): Paris has no Note, so its row goes; Amsterdam, which has one, keeps it.
  await openPopover(t, "Fields");
  await popover(t).getByText("Hide empty fields", { exact: true }).click();
  await t.closeAll();
  await saveView(t);
  await t.until("Hide empty fields is stored", async () => (await storedView(t, coll, view)).blocks[0].layout.hideEmpty === true);
  await dotsShown(t, "the dots are still there", 4);
  await hover(paris);
  await t.until("Paris's tooltip leaves out its empty Note", async () => {
    const text = await tip.innerText().catch(() => "");
    return (text.includes("France") && !text.includes("Note")) || text;
  });
  await t.page.mouse.move(paris.x + 60, paris.y + 90);
  await t.until("hidden again", async () => (await tip.count()) === 0, { timeout: 4000 });
  await hover(amsterdam);
  await t.until("Amsterdam's tooltip keeps its Note", async () => {
    const text = await tip.innerText().catch(() => "");
    return (text.startsWith("Amsterdam") && text.includes("Note") && text.includes("Visited in 2010")) || text;
  });
  // The pointer can move onto the tooltip and use its title link.
  const link = tip.locator("a.map-block__title");
  const lb = await link.boundingBox();
  await t.page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2, { steps: 4 });
  await t.page.mouse.click(lb.x + lb.width / 2, lb.y + lb.height / 2);
  await t.until("the title link opens Amsterdam", async () => (await itemTitle(t)) === "Amsterdam");
  await t.open(path);
  const fresh = [...(await dotsShown(t, "four dots again", 4)).dots].sort((a, b) => a.x - b.x);
  // A click on a dot opens its item.
  await t.page.mouse.click(fresh[2].x, fresh[2].y);
  await t.until("clicking a dot opens its item", async () => (await itemTitle(t)) === "Rome");
  await t.audit("the item opened from the map");
  // Clicking the empty map opens nothing.
  await t.open(path);
  const again = await dotsShown(t, "and again four", 4);
  await t.page.mouse.click(again.box.x + 6, again.box.y + again.box.height - 6);
  await t.settle();
  await t.check("a click beside the dots opens nothing", (await t.count(".map-block")) === 1 && (await t.count(".item-title")) === 0);
});

// ---- Cards ----------------------------------------------------------------------------------

/** Books as cards: every cover the same 320 x 200 image, a few light fields. */
function booksCardsSpec({ items = 8, blocks } = {}) {
  const spec = matrixSpec("typical", { items });
  const books = spec.collections[0];
  for (const it of books.items) it.values.cover = { image: "img0" };
  spec.bookmarks = [];
  books.views = [
    {
      name: "Cards",
      blocks: blocks || [{ kind: "cards", layout: { fields: ["count", "date"] }, options: { coverFieldId: "@cover", cardWidth: 16, coverRatio: "auto", showTitle: true, coverBeside: false } }],
    },
  ];
  return spec;
}
const CARD = ".ws-pane--active .item-card";
/** Every card's box. */
const cardBoxes = (t) => t.page.locator(CARD).evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
/** Cards in the first row. */
const columnsOf = (boxes) => boxes.filter((b) => Math.abs(b.y - boxes[0].y) < 2).length;
const coverShapes = (t) => t.page.locator(`${CARD} .item-card__cover`).evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return r.width / r.height; }));
const storedOptions = async (t, ids, collection, view, i = 0) => (await storedView(t, ids.collections[collection], ids.views[`${collection}/${view}`])).blocks[i].options;

for (const vp of ["desktop", "phone"]) {
  test(`cards: Show title, Cover beside the text, Cover and Cover shape @ ${vp}`, async (t) => {
    await t.boot();
    const ids = await t.seed(booksCardsSpec());
    const path = `${t.listPath(ids.collections.books)}?view=${ids.views["books/Cards"]}`;
    await t.open(path);
    await t.until("eight cards with eight covers", async () => (await t.count(CARD)) === 8 && (await t.count(`${CARD} .item-card__cover img`)) === 8);
    await t.check("a card shows its title", /^(A Wizard|The Left|Foundation|Neuromancer|The Dispos|Hyperion|Solaris|Kindred)/.test(await t.page.locator(`${CARD} .item-card__title`).first().innerText()));
    await t.audit("cards with covers");

    // Show title.
    await openPopover(t, "Block settings");
    const title = popover(t).getByText("Show title", { exact: true });
    await title.click();
    await t.until("without Show title no card has a title", async () => (await t.count(`${CARD} .item-card__title`)) === 0 && (await t.count(CARD)) === 8);
    await t.until("Show title off is stored", async () => (await storedOptions(t, ids, "books", "Cards")).showTitle === false);
    await t.check("the cards still show their fields", (await t.page.locator(`${CARD} .item-card__field`).count()) === 16);
    await title.click();
    await t.until("Show title on brings the titles back", async () => (await t.count(`${CARD} .item-card__title`)) === 8);

    // Cover beside the text.
    const cardsBefore = await cardBoxes(t);
    await popover(t).getByText("Cover beside the text", { exact: true }).click();
    await t.until("Cover beside the text puts every cover left of its text", async () => (await t.count(".ws-pane--active .item-card--cover-left")) === 8);
    await t.until("Cover beside the text is stored", async () => (await storedOptions(t, ids, "books", "Cards")).coverBeside === true);
    const beside = await t.page.locator(`${CARD}`).first().evaluate((card) => {
      const c = card.querySelector(".item-card__cover").getBoundingClientRect();
      const b = card.querySelector(".item-card__body").getBoundingClientRect();
      return { coverRight: c.right, bodyLeft: b.left, coverTop: c.top, bodyTop: b.top };
    });
    await t.check("the cover sits beside the text, not above it", beside.coverRight <= beside.bodyLeft + 1 && Math.abs(beside.coverTop - beside.bodyTop) < 40, JSON.stringify(beside));
    await t.audit("cards: cover beside the text");
    await popover(t).getByText("Cover beside the text", { exact: true }).click();
    await t.until("off again: covers above the text", async () => (await t.count(".ws-pane--active .item-card--cover-left")) === 0);
    await t.check("and the cards are the size they were", (await cardBoxes(t)).every((b, i) => Math.abs(b.h - cardsBefore[i].h) < 2 && Math.abs(b.w - cardsBefore[i].w) < 2));

    // Cover shape: each fixed shape gives that ratio to every cover.
    const shapes = { "Square (1:1)": 1, "Landscape (3:2)": 1.5, "Wide (16:9)": 16 / 9, "Portrait (2:3)": 2 / 3 };
    for (const [label, ratio] of Object.entries(shapes)) {
      await popover(t).getByLabel("Cover shape", { exact: true }).selectOption({ label });
      await t.until(`${label}: every cover has that shape`, async () => {
        const shapesNow = await coverShapes(t);
        return (shapesNow.length === 8 && shapesNow.every((s) => Math.abs(s / ratio - 1) < 0.04)) || shapesNow.map((s) => s.toFixed(2)).join(" ");
      });
      await t.check(`${label} is stored`, (await storedOptions(t, ids, "books", "Cards")).coverRatio === label.replace(/.*\((.*)\)/, "$1"));
    }
    await t.audit("cards: portrait covers");
    await popover(t).getByLabel("Cover shape", { exact: true }).selectOption({ label: "Automatic" });
    await t.until("Automatic: the covers take the shape of the images (320 x 200)", async () => {
      const s = await coverShapes(t);
      return (s.length === 8 && s.every((v) => Math.abs(v / 1.6 - 1) < 0.04)) || s.map((v) => v.toFixed(2)).join(" ");
    });

    // Cover: the fields that can be one, then None (the options that need a cover are disabled).
    const cover = popover(t).getByLabel("Cover", { exact: true });
    const offered = await cover.locator("option").allInnerTexts();
    await t.check("Cover offers images, Markdown, HTML and components giving them", ["None", "Cover", "Notes", "Snippet", "Computed"].every((n) => offered.includes(n)) && !offered.includes("Count") && !offered.includes("Date") && !offered.includes("Title"), offered.join(", "));
    await cover.selectOption({ label: "Notes" });
    await t.until("a Markdown field is shown as the cover", async () => (await t.count(`${CARD} .item-card__cover--markdown`)) === 8 && (await t.count(`${CARD} .item-card__cover img`)) === 0);
    await t.audit("cards with Markdown covers");
    await cover.selectOption({ label: "Snippet" });
    await t.until("an HTML field is shown as the cover", async () => (await t.count(`${CARD} .item-card__cover--html`)) === 8);
    await cover.selectOption({ label: "None" });
    await t.until("None: no covers", async () => (await t.count(`${CARD} .item-card__cover`)) === 0 && (await t.count(CARD)) === 8);
    await t.check("without a cover, Cover beside the text and Cover shape are off", (await popover(t).getByLabel("Cover shape", { exact: true }).isDisabled()) && (await popover(t).getByLabel("Cover beside the text", { exact: true }).isDisabled()));
    await t.audit("cards without covers");
    await cover.selectOption({ label: "Cover" });
    await t.until("the image field is the cover again", async () => (await t.count(`${CARD} .item-card__cover img`)) === 8);
    await t.closeAll();
    // Everything stayed.
    await t.open(path);
    await t.until("after a reload: the same options, the same cards", async () => {
      const o = await storedOptions(t, ids, "books", "Cards");
      return (o.coverFieldId === ids.fields["books.cover"] && o.coverRatio === "auto" && o.showTitle === true && o.coverBeside === false && (await t.count(`${CARD} .item-card__cover img`)) === 8) || JSON.stringify(o);
    });
  }, { viewport: vp, smoke: vp === "desktop" });
}

test("cards: Card width sets how many cards a row holds", async (t) => {
  await t.boot();
  const ids = await t.seed(booksCardsSpec({ items: 12 }));
  await t.open(`${t.listPath(ids.collections.books)}?view=${ids.views["books/Cards"]}`);
  await t.until("twelve cards", async () => (await t.count(CARD)) === 12);
  await openPopover(t, "Block settings");
  const thumb = popover(t).locator(".cds--slider__thumb").first();
  const widths = {};
  // Shift + arrow moves four rem (Carbon's slider has no Home / End); one step at a time, each stored before
  // the next (a long jump with many cards re-laid-out at once is a known crash, see the report).
  for (const [key, rem, presses] of [["Shift+ArrowLeft", 8, 2], ["Shift+ArrowRight", 32, 6]]) {
    await thumb.focus();
    for (let i = 0; i < presses; i++) {
      const before = (await storedOptions(t, ids, "books", "Cards")).cardWidth;
      await t.page.keyboard.press(key);
      await t.until(`${key}: ${before}rem becomes ${before + (key.endsWith("Left") ? -4 : 4)}rem`, async () => (await storedOptions(t, ids, "books", "Cards")).cardWidth === before + (key.endsWith("Left") ? -4 : 4));
    }
    await t.settle(300);
    const boxes = await cardBoxes(t);
    widths[rem === 8 ? "min" : "max"] = { columns: columnsOf(boxes), w: boxes[0].w };
    await t.audit(`card width ${rem}rem`);
  }
  await t.check("narrow cards: more to a row, each close to 8rem", widths.min.columns > widths.max.columns && Math.abs(widths.min.w / 16 - 8) < 4, JSON.stringify(widths));
  await t.check("wide cards: one or two to a row, each close to the pane's share of 32rem", widths.max.columns <= 2, JSON.stringify(widths));
  // A step by the arrow keys: one more rem.
  await thumb.focus();
  await t.page.keyboard.press("ArrowLeft");
  await t.until("an arrow key steps one rem", async () => (await storedOptions(t, ids, "books", "Cards")).cardWidth === 31);
  await t.check("the label tells the width", (await popover(t).innerText()).includes("31rem"));
  await t.closeAll();
});

test("cards: Hide empty fields, Name and the block header", async (t) => {
  await t.boot();
  const spec = placesSpec({
    blocks: [{ kind: "cards", layout: { fields: ["country", "note"] }, options: { coverFieldId: null, cardWidth: 14, coverRatio: "auto", showTitle: true, coverBeside: false } }],
  });
  const ids = await t.seed(spec);
  const coll = ids.collections.places;
  const view = ids.views["places/Map"];
  const path = `${t.listPath(coll)}?view=${view}`;
  await t.open(path);
  await t.until("six cards with two fields each", async () => (await t.count(CARD)) === 6 && (await t.count(`${CARD} .item-card__field`)) === 12);
  // Hide empty fields: the three places without a Note lose that line (a view change: saved with the view).
  await openPopover(t, "Fields");
  await t.audit("block fields popover");
  await popover(t).getByText("Hide empty fields", { exact: true }).click();
  await t.until("the empty Notes are left out", async () => (await t.count(`${CARD} .item-card__field`)) === 9);
  await t.check("the cards without a Note are the shorter ones", (await t.page.locator(`${CARD}:not(:has(.item-card__field:nth-of-type(2)))`).count()) === 3);
  await t.closeAll();
  await t.check("the view is marked as changed", (await t.page.locator(".views-bar").first().innerText()).includes("*"));
  await saveView(t);
  await t.until("Hide empty fields is stored", async () => (await storedView(t, coll, view)).blocks[0].layout.hideEmpty === true);
  await t.open(path);
  await t.until("after a reload still nine fields", async () => (await t.count(`${CARD} .item-card__field`)) === 9);
  await openPopover(t, "Fields");
  await popover(t).getByText("Hide empty fields", { exact: true }).click();
  await t.until("off again: twelve", async () => (await t.count(`${CARD} .item-card__field`)) === 12);
  await t.closeAll();
  await saveView(t);

  // Name: empty it is named after the type; a name is stored when left and shown in the header.
  const heading = () => header(t).innerText();
  await t.check("an unnamed block is named after its type", (await heading()).includes("Cards"), await heading());
  await openPopover(t, "Block settings");
  const name = popover(t).getByLabel("Name", { exact: true });
  await t.check("its placeholder is that name", (await name.getAttribute("placeholder")) === "Cards");
  await name.fill("Where we went");
  await name.press("Enter");
  await t.until("the name is stored", async () => (await storedView(t, coll, view)).blocks[0].title === "Where we went");
  await t.until("the header shows it", async () => (await heading()).includes("Where we went"));
  await t.closeAll();
  await t.open(path);
  await t.check("after a reload the name is there", (await heading()).includes("Where we went"));
  await openPopover(t, "Block settings");
  await popover(t).getByLabel("Name", { exact: true }).fill("");
  await popover(t).getByLabel("Name", { exact: true }).press("Enter");
  await t.until("an emptied name goes back to the type's", async () => (await storedView(t, coll, view)).blocks[0].title === "" && (await heading()).includes("Cards"));
  await t.closeAll();

  // Hide block header: View settings lists the blocks, each with a switch for its header.
  await t.check("the header is shown", (await t.page.locator(".ws-pane--active .block .section-header").filter({ visible: true }).count()) === 1);
  await t.openPanel(t.page.locator(".views-bar").first(), "View settings");
  await popover(t).getByRole("button", { name: "Hide block header", exact: true }).click();
  await t.until("the header is hidden", async () => (await t.page.locator(".ws-pane--active .block .section-header").filter({ visible: true }).count()) === 0);
  await t.until("hideHeader is stored", async () => (await storedView(t, coll, view)).blocks[0].hideHeader === true);
  await t.check("the cards stay", (await t.count(CARD)) === 6);
  await t.audit("a block without its header");
  await t.closeAll();
  await t.open(path);
  await t.check("after a reload there is still no header", (await t.page.locator(".ws-pane--active .block .section-header").filter({ visible: true }).count()) === 0 && (await t.count(CARD)) === 6);
  await t.openPanel(t.page.locator(".views-bar").first(), "View settings");
  await popover(t).getByRole("button", { name: "Show block header", exact: true }).click();
  await t.until("the header is back", async () => (await t.page.locator(".ws-pane--active .block .section-header").filter({ visible: true }).count()) === 1);
  await t.until("hideHeader is gone from the stored block", async () => !(await storedView(t, coll, view)).blocks[0].hideHeader);
  await t.closeAll();
});

// ---- Table ----------------------------------------------------------------------------------

function booksTableSpec({ items = 12 } = {}) {
  const spec = matrixSpec("typical", { items });
  spec.collections[0].views = [{ name: "Table", blocks: [{ kind: "table", layout: { fields: ["title", "count"] } }] }];
  spec.bookmarks = [];
  return spec;
}
const ROWS = ".ws-pane--active tbody tr:has(a[href*='/items/'])";
const TITLE_LINKS = ".ws-pane--active tbody a[href*='/items/']";

test("table: Title links to the item", async (t) => {
  await t.boot();
  const ids = await t.seed(booksTableSpec({ items: 6 }));
  const coll = ids.collections.books;
  const view = ids.views["books/Table"];
  const path = `${t.listPath(coll)}?view=${view}`;
  await t.open(path);
  await t.until("six rows, each title a link", async () => (await t.count(TITLE_LINKS)) === 6);
  const href = await t.page.locator(TITLE_LINKS).first().getAttribute("href");
  await t.check("a title links to its item", /\/items\/[0-9a-f-]{36}$/.test(href), href);
  await t.audit("table with title links");
  await t.page.locator(TITLE_LINKS).first().click();
  await t.until("a click on the title opens the item", async () => (await t.count(".ws-pane--active .item-title")) === 1);
  await t.open(path);
  await openPopover(t, "Block settings");
  const link = popover(t).getByLabel("Title links to the item", { exact: true });
  await t.check("the option is on", await link.isChecked());
  await popover(t).getByText("Title links to the item", { exact: true }).click();
  await t.until("off: no title is a link", async () => (await t.count(TITLE_LINKS)) === 0 && (await t.count(".ws-pane--active tbody tr")) >= 6);
  await t.until("Title links off is stored", async () => (await storedOptions(t, ids, "books", "Table")).titleLink === false);
  await t.closeAll();
  // The rows get an open button instead (shown on hover).
  const row = t.page.locator(".ws-pane--active tbody tr", { hasText: "Neuromancer" }).first();
  await row.hover();
  await t.until("a row has its own open button", async () => (await row.getByRole("button", { name: "Open Book", exact: true }).count()) === 1);
  await t.audit("table without title links");
  await row.getByRole("button", { name: "Open Book", exact: true }).click();
  await t.until("the open button opens the item", async () => (await itemTitle(t)).startsWith("Neuromancer"));
  await t.open(path);
  await t.until("after a reload still no title links", async () => (await t.count(".ws-pane--active tbody tr")) >= 6 && (await t.count(TITLE_LINKS)) === 0);
}, { smoke: true });

test("table and cards: Items shown at a time and Show more", async (t) => {
  await t.boot();
  const spec = booksTableSpec({ items: 14 });
  spec.collections[0].views.push({ name: "Cards", blocks: [{ kind: "cards", layout: { fields: ["count"] }, options: { coverFieldId: null, cardWidth: 14, coverRatio: "auto", showTitle: true, coverBeside: false } }] });
  const ids = await t.seed(spec);
  const coll = ids.collections.books;
  const rows = () => t.count(ROWS);
  const more = () => t.page.locator(".ws-pane--active .block-more");
  for (const [name, count] of [["Table", rows], ["Cards", () => t.count(CARD)]]) {
    const view = ids.views[`books/${name}`];
    const path = `${t.listPath(coll)}?view=${view}`;
    await t.open(path);
    await t.until(`${name}: all 14 are shown at first (no limit set)`, async () => (await count()) === 14 && (await t.count(".ws-pane--active .block-more")) === 0);
    await openPopover(t, "Filter");
    await t.audit(`${name}: filter popover with Items shown at a time`);
    const limit = popover(t).getByLabel("Items shown at a time", { exact: true });
    await limit.click();
    await limit.fill("5");
    await t.until(`${name}: a limit of 5 shows 5`, async () => (await count()) === 5 || `${await count()} shown`);
    await t.closeAll();
    await t.until(`${name}: Show more with 5 of 14`, async () => (await more().innerText()).includes("Show more") && (await more().innerText()).includes("5 of 14"));
    await t.audit(`${name}: Show more`);
    await more().getByRole("button", { name: "Show more" }).click();
    await t.until(`${name}: Show more adds five`, async () => (await count()) === 10 && (await more().innerText()).includes("10 of 14"));
    await more().getByRole("button", { name: "Show more" }).click();
    await t.until(`${name}: the last step shows the rest and the button goes`, async () => (await count()) === 14 && (await t.count(".ws-pane--active .block-more")) === 0);
    // The limit is a view change: marked, saved, and stored with the block.
    await t.check(`${name}: the view is marked as changed`, (await t.page.locator(".views-bar").first().innerText()).includes("*"));
    await saveView(t);
    await t.until(`${name}: the limit 5 is stored`, async () => (await storedView(t, coll, view)).blocks[0].limit === 5);
    await t.open(path);
    await t.until(`${name}: after a reload it starts with 5 again`, async () => (await count()) === 5 && (await more().innerText()).includes("5 of 14"));
    // Another step size, then empty = all.
    await openPopover(t, "Filter");
    await popover(t).getByLabel("Items shown at a time", { exact: true }).fill("20");
    await t.until(`${name}: a limit above the count shows everything, no button`, async () => (await count()) === 14 && (await t.count(".ws-pane--active .block-more")) === 0);
    await popover(t).getByLabel("Items shown at a time", { exact: true }).fill("");
    await t.until(`${name}: emptied: all of them`, async () => (await count()) === 14);
    await t.closeAll();
    await saveView(t);
    await t.until(`${name}: emptied, the stored limit is 0 (all)`, async () => (await storedView(t, coll, view)).blocks[0].limit === 0);
  }
});

// ---- Component and Markdown blocks ------------------------------------------------------------

test("component block: pick a shared component, switch, New component", async (t) => {
  await t.boot();
  const spec = matrixSpec("typical", { items: 5 });
  spec.components.push(
    { key: "count", name: "Book count", code: "{{ $items.length }} books listed", output: "markdown" },
    { key: "hello", name: "Hello block", code: "**Hello** from a static component", output: "markdown" },
    { key: "frame", name: "Framed", code: "<p id='framed'>inside a frame</p>", output: "html" },
  );
  spec.bookmarks = [];
  spec.collections[0].views = [{ name: "Component", blocks: [{ kind: "component", options: { componentId: null, local: null, height: 24, aspect: "4:3" } }] }];
  const ids = await t.seed(spec);
  const coll = ids.collections.books;
  const view = ids.views["books/Component"];
  const path = `${t.listPath(coll)}?view=${view}`;
  await t.open(path);
  const block = t.page.locator(".ws-pane--active .component-block");
  await t.until("no component chosen says so", async () => (await block.innerText()).includes("No component chosen"));
  await t.audit("component block without a component");
  await openPopover(t, "Block settings");
  const picker = popover(t).getByRole("combobox", { name: /Component/ });
  await picker.click();
  const offered = await t.page.getByRole("option").allInnerTexts();
  await t.check("the picker offers block and static components, not field components", ["Book count", "Hello block", "Framed"].every((n) => offered.includes(n)) && !offered.includes("Double"), offered.join(", "));
  await t.audit("component picker open");
  await t.page.getByRole("option", { name: "Book count", exact: true }).click();
  await t.until("the block shows the component's result", async () => (await block.innerText()).includes("5 books listed") || (await block.innerText()));
  await t.until("the pick is stored", async () => (await storedView(t, coll, view)).blocks[0].options.componentId === ids.components.count);
  await t.check("a block component uses a filter and sorting; Edit component is offered", (await header(t).getByRole("button", { name: "Filter" }).count()) + (await header(t).getByRole("button", { name: "More actions" }).count()) > 0 && (await popover(t).getByRole("link", { name: "Edit component" }).count()) + (await popover(t).getByRole("button", { name: "Edit component" }).count()) > 0);
  const edit = popover(t).locator("a", { hasText: "Edit component" });
  await t.check("Edit component goes to the component's page", ((await edit.getAttribute("href")) || "").endsWith(`/components/${ids.components.count}`), await edit.getAttribute("href"));
  await t.audit("component block settings");
  // Another one: the block now shows that.
  await picker.click();
  await t.page.getByRole("option", { name: "Hello block", exact: true }).click();
  await t.until("a static component replaces it", async () => (await block.innerText()).includes("Hello from a static component") && !(await block.innerText()).includes("books listed"));
  await t.until("the static pick is stored", async () => (await storedView(t, coll, view)).blocks[0].options.componentId === ids.components.hello);
  await t.check("Height and aspect only for HTML", (await popover(t).getByText("Height", { exact: true }).count()) === 0);
  await picker.click();
  await t.page.getByRole("option", { name: "Framed", exact: true }).click();
  await t.until("an HTML component shows in a frame", async () => (await t.count(".ws-pane--active .component-block iframe")) === 1);
  await t.until("an HTML component gets Height settings", async () => (await popover(t).getByText("Height", { exact: true }).count()) > 0);
  await t.audit("component block with HTML settings");
  // New component: a dialog asking for a name; Cancel makes none.
  const before = await t.page.evaluate(async () => (await window.kubus.repo.listComponents()).length);
  await popover(t).getByRole("button", { name: "New component" }).click();
  const dialog = t.page.locator(".cds--modal.is-visible");
  await t.until("New component asks for a name", async () => (await dialog.innerText()).includes("New component"));
  await t.audit("new component dialog");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await t.until("Cancel closes it", async () => (await t.count(".cds--modal.is-visible")) === 0);
  await t.check("and makes no component", (await t.page.evaluate(async () => (await window.kubus.repo.listComponents()).length)) === before);
  await popover(t).getByRole("button", { name: "New component" }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Made in the block");
  await dialog.getByRole("button", { name: "Create" }).click();
  await t.until("Create makes the component and the block picks it", async () => {
    const comps = await t.page.evaluate(async () => (await window.kubus.repo.listComponents()).map((c) => ({ id: c.id, name: c.name })));
    const made = comps.find((c) => c.name === "Made in the block");
    return (!!made && (await storedView(t, coll, view)).blocks[0].options.componentId === made.id) || JSON.stringify(comps.map((c) => c.name));
  });
  await t.until("its page opens beside the view", async () => (await t.count(".ws-pane")) >= 2 || (await t.count(".ws-tab")) >= 2);
});

test("markdown block: Edit text, braces worked out, Save as shared component", async (t) => {
  await t.boot();
  const spec = matrixSpec("typical", { items: 3 });
  spec.bookmarks = [];
  spec.collections[0].views = [{ name: "Text", blocks: [{ kind: "markdown", title: "Notes", options: { text: "Some **bold** text and {{ 21 * 2 }} as a sum." } }] }];
  const ids = await t.seed(spec);
  const coll = ids.collections.books;
  const view = ids.views["books/Text"];
  const path = `${t.listPath(coll)}?view=${view}`;
  const textBox = t.page.getByRole("button", { name: "Edit text", exact: true });
  await t.open(path);
  await t.until("the text is shown with its code worked out", async () => {
    const text = await textBox.innerText();
    return (text.includes("Some bold text and 42 as a sum.")) || text;
  });
  await t.check("the bold word is bold", (await textBox.locator("strong").innerText()) === "bold");
  await t.audit("markdown block");
  // No filter, sort or fields for a text.
  await t.check("a Markdown block has only Block settings", (await header(t).getByRole("button", { name: /^(Filter|Sort|Fields)/ }).count()) === 0);
  // Edit: Escape cancels, Ctrl+Enter stores.
  await textBox.click();
  await t.page.waitForSelector(".markdown-block--editing .ProseMirror");
  await t.editorReady(".markdown-block--editing");
  await t.audit("markdown block being edited");
  await t.page.keyboard.press("Control+End");
  await t.page.keyboard.type(" Dropped.");
  await t.page.keyboard.press("Escape");
  await t.until("Escape leaves the text as it was", async () => (await t.count(".markdown-block--editing")) === 0 && !(await textBox.innerText()).includes("Dropped"));
  await t.check("nothing was stored", (await storedView(t, coll, view)).blocks[0].options.text === "Some **bold** text and {{ 21 * 2 }} as a sum.");
  await textBox.click();
  await t.editorReady(".markdown-block--editing");
  await t.page.keyboard.press("Control+End");
  await t.page.keyboard.type(" Added later.");
  await t.page.keyboard.press("Control+Enter");
  await t.until("Ctrl+Enter stores the text", async () => (await storedView(t, coll, view)).blocks[0].options.text.includes("Added later."));
  await t.until("and shows it", async () => (await textBox.innerText()).includes("Added later."));
  await t.open(path);
  await t.check("after a reload it is there", (await textBox.innerText()).includes("Added later."));
  // Empty: a placeholder box that can still be clicked.
  await textBox.click();
  await t.editorReady(".markdown-block--editing");
  await t.page.keyboard.press("Control+A");
  await t.page.keyboard.press("Delete");
  await t.page.keyboard.press("Control+Enter");
  await t.until("an emptied text is stored empty", async () => (await storedView(t, coll, view)).blocks[0].options.text.trim() === "");
  await t.check("the empty block is still there to click", (await textBox.count()) === 1);
  await t.audit("empty markdown block");
  await textBox.click();
  await t.editorReady(".markdown-block--editing");
  await t.page.keyboard.type("Reusable **words**");
  await t.page.keyboard.press("Control+Enter");
  await t.until("typed text is stored", async () => (await storedView(t, coll, view)).blocks[0].options.text.includes("Reusable"));
  // Save as shared component: the block becomes a component block showing the same text.
  await openPopover(t, "Block settings");
  await t.audit("markdown block settings");
  await popover(t).getByRole("button", { name: "Save as shared component" }).click();
  const dialog = t.page.locator(".cds--modal.is-visible");
  await t.until("a dialog asks for the name", async () => (await dialog.innerText()).includes("Save as shared component"));
  await dialog.getByLabel("Name", { exact: true }).fill("My shared words");
  await dialog.getByRole("button", { name: "Save as shared" }).click();
  await t.until("the block now shows a shared component", async () => {
    const b = (await storedView(t, coll, view)).blocks[0];
    const comps = await t.page.evaluate(async () => (await window.kubus.repo.listComponents()).map((c) => ({ id: c.id, name: c.name, code: c.code })));
    const made = comps.find((c) => c.name === "My shared words");
    return (b.kind === "component" && !!made && b.options.componentId === made.id && made.code.includes("Reusable")) || JSON.stringify([b.kind, comps.map((c) => c.name)]);
  });
  await t.until("with the same words", async () => (await t.page.locator(".ws-pane--active .component-block").first().innerText()).includes("Reusable words"));
});

// ---- the Collection picker of an item page's block ----------------------------------------------

test("item page block: Collection picker and Name", async (t) => {
  await t.boot();
  const spec = matrixSpec("typical", { items: 5 });
  spec.bookmarks = [];
  spec.collections[0].itemViews = [{ name: "Page", layout: { fields: ["title", "count", "authors-block"], blocks: [{ id: "authors-block", kind: "table", collection: "authors" }] } }];
  const ids = await t.seed(spec);
  const coll = ids.collections.books;
  await t.open(t.itemPath(coll, ids.items["books/i0"]));
  const stored = () => t.page.evaluate(async (c) => (await window.kubus.repo.listCollections()).find((x) => x.id === c).itemViews[0].layout.blocks[0], coll);
  await t.until("a block listing Authors", async () => (await t.page.locator(".ws-pane--active .block").first().innerText()).includes("Table") && (await t.count(".ws-pane--active .block tbody tr")) >= 1);
  const rows = (await t.count(".ws-pane--active .block tbody tr"));
  await t.check("it lists all six Authors", rows >= 6, `${rows} rows`);
  await t.audit("item page with a block");
  await openPopover(t, "Block settings");
  const picker = popover(t).getByRole("combobox").first();
  await t.check("the picker shows the block's collection", (await picker.innerText()).includes("Authors"), await picker.innerText());
  await picker.click();
  const offered = await t.page.getByRole("option").allInnerTexts();
  await t.check("it lists the collections", offered.includes("Books") && offered.includes("Authors"), offered.join(", "));
  await t.audit("collection picker open");
  await t.page.getByRole("option", { name: "Books", exact: true }).click();
  await t.until("another collection: the block lists Books, afresh", async () => (await stored()).collectionId === coll);
  await t.until("five books in the block", async () => (await t.count(".ws-pane--active .block tbody tr:has(a[href*='/items/'])")) === 5 || (await t.count(".ws-pane--active .block tbody tr")));
  await t.check("a collection without a link to this page has no filter", ((await stored()).filters || []).length === 0);
  await t.audit("block listing another collection");
  // Back to Authors: linked to nothing either (Authors don't refer to Books), all six.
  // (The block is drawn afresh for another collection, which closes its settings.)
  if (!(await popover(t).isVisible().catch(() => false))) await openPopover(t, "Block settings");
  await popover(t).getByRole("combobox").first().click();
  await t.page.getByRole("option", { name: "Authors", exact: true }).click();
  await t.until("Authors again", async () => (await stored()).collectionId === ids.collections.authors);
  // Name.
  if (!(await popover(t).isVisible().catch(() => false))) await openPopover(t, "Block settings");
  const name = popover(t).getByLabel("Name", { exact: true });
  await name.fill("Who wrote it");
  await name.press("Enter");
  await t.until("the name is stored", async () => (await stored()).title === "Who wrote it");
  await t.until("and shown in the block header", async () => (await t.page.locator(".ws-pane--active .block").first().locator(".section-header").first().innerText()).includes("Who wrote it"));
  await t.closeAll();
  await t.open(t.itemPath(coll, ids.items["books/i0"]));
  await t.check("after a reload it is still named", (await t.page.locator(".ws-pane--active .block").first().locator(".section-header").first().innerText()).includes("Who wrote it"));
});

// @@END@@
