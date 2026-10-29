// The Map block against a stubbed OpenFreeMap: Location from a text field, the dots, the count of places
// without one.

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

test("map: Location from a text field, dots, count of places without one @ desktop", async (t) => {
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
  const location = shownPopover(t).getByLabel("Location", { exact: true });
  const offered = await location.locator("option").allInnerTexts();
  await t.check("Location offers None and every text and number field", ["None", "Name", "Position", "Latitude", "Longitude", "Country", "Note"].every((n) => offered.includes(n)), offered.join(", "));
  await location.selectOption({ label: "Position" });
  await t.until("choosing Position stores it", async () => (await storedView(t, ids.collections.places, ids.views["places/Map"])).blocks[0].options.locationFieldId === ids.fields["places.where"]);
  await t.check("a text location has no Longitude select", (await shownPopover(t).getByLabel("Longitude", { exact: true }).count()) === 0);
  await t.audit("map block settings: Location");
  await t.closeAll();
  await t.until("the message goes", async () => (await t.count(".map-block__message")) === 0);
  const shown = await dotsShown(t, "four places in four notations are four dots", 4);
  await t.check("two places have no location", (await t.page.locator(".map-block__legend").innerText()).includes("2 without a location"), await t.page.locator(".map-block__legend").innerText().catch(() => "no legend"));
  await t.check("the dots lie inside the map", shown.dots.every((d) => d.x > shown.box.x && d.x < shown.box.x + shown.box.width && d.y > shown.box.y && d.y < shown.box.y + shown.box.height));
  await t.audit("map with four dots");
  // Back to None: the dots and the legend go, the message is back.
  await openPopover(t, "Block settings");
  await shownPopover(t).getByLabel("Location", { exact: true }).selectOption({ label: "None" });
  await t.closeAll();
  await t.until("None brings the message back", async () => (await t.page.locator(".map-block__message").innerText().catch(() => "")).includes("Choose the field"));
  await dotsShown(t, "no dots without a field", 0);
  await t.check("no legend without a field", (await t.count(".map-block__legend")) === 0);
}, { viewport: "desktop", smoke: true });
