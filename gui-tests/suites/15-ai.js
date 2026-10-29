// AI fields against a fake language model (an OpenAI-style endpoint, page.route on a made-up address):
// values fill in by themselves, "Generate again" with a nudge.

const LLM = "https://llm.test/v1";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS" };

const AI_PREFS = { "kubus.ai": { baseUrl: LLM, apiKey: "test-key", fieldModel: "fake-model", codeModel: "", paused: false } };

/**
 * Serves the fake model. `answer(body, n)` gives the reply for the n-th completion request: a
 * string (the model's text) or { status, message } (an error answer). Returns the list of request
 * bodies, which grows as requests come in; `fake.answer` can be swapped during a test.
 */
async function fakeModel(t, answer) {
  const fake = { calls: [], answer };
  await t.page.route(`${LLM}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (req.url().endsWith("/models")) return route.fulfill({ status: 200, headers: CORS, json: { data: [{ id: "fake-model" }, { id: "other-model" }] } });
    let body = {};
    try {
      body = JSON.parse(req.postData() || "{}");
    } catch {}
    fake.calls.push(body);
    const r = await fake.answer(body, fake.calls.length);
    if (r && typeof r === "object") return route.fulfill({ status: r.status, headers: CORS, json: { error: { message: r.message || "error" } } });
    return route.fulfill({ status: 200, headers: CORS, json: { choices: [{ message: { content: r } }] } });
  });
  return fake;
}

/** The user message of a request (the prompt, with the item's data and a nudge). */
const promptOf = (body) => (body.messages || []).map((m) => m.content).join("\n");

/** A reply naming the item the prompt is about ("Summarise <title>"). */
const summaryReply = (body) => {
  const m = /Summarise ([^\n]*)/.exec(promptOf(body));
  return `AI summary of ${m ? m[1].trim().slice(0, 40) : "it"}`;
};

function aiSpec(items = 3) {
  const spec = profileSpec("typical", { items, ai: true });
  spec.prefs = AI_PREFS;
  return spec;
}

test("AI values fill in by themselves, generate again with a nudge @ desktop", async (t) => {
  await t.boot();
  const fake = await fakeModel(t, summaryReply);
  const ids = await t.seed(aiSpec(3));
  await t.open(t.listPath(ids.collections.books));
  await t.until("every item's AI value fills in", async () => {
    const text = await t.page.locator(".ws-pane--active").innerText();
    return (text.match(/AI summary of/g) || []).length >= 3 || `${(text.match(/AI summary of/g) || []).length} of 3 shown, ${fake.calls.length} requests`;
  }, { timeout: 20000 });
  await t.audit("table with AI values");
  await t.check("one request per value", fake.calls.length === 3, `${fake.calls.length} requests for 3 values`);
  await t.check("the request carries the model and the item's data", fake.calls.every((b) => b.model === "fake-model") && fake.calls.some((b) => promptOf(b).includes("Summarise")), JSON.stringify(fake.calls[0]).slice(0, 300));
  // The item page: its value, and "Generate again" with a nudge.
  await t.open(t.itemPath(ids.collections.books, ids.items["books/i0"]));
  await t.until("the item page shows the value", async () => (await t.page.locator(".ws-pane--active .item-fields").innerText()).includes("AI summary of"));
  fake.answer = (body) => (promptOf(body).includes("the second edition") ? "AI summary, nudged" : summaryReply(body));
  const before = fake.calls.length;
  await t.openPanel(t.page.locator(".ws-pane--active .item-fields > *", { hasText: "Summary" }).first(), "Generate again");
  await t.audit("generate again popover");
  const nudge = t.page.locator(".toolbar-popover.cds--popover--open").getByRole("textbox", { name: /Nudge/ });
  await nudge.click();
  await t.popoverStep("typing a nudge", () => t.page.keyboard.type("the second edition", { delay: 10 }), { target: nudge, scope: ".ws-pane--active .page-header" });
  await t.page.locator(".toolbar-popover.cds--popover--open").getByRole("button", { name: "Generate", exact: true }).click();
  await t.until("Generate closes the popover", async () => (await t.count(".toolbar-popover.cds--popover--open")) === 0);
  await t.until("the nudged value replaces the old one", async () => (await t.page.locator(".ws-pane--active .item-fields").innerText()).includes("AI summary, nudged"), { timeout: 10000 });
  await t.check("one more request, with the nudge in it", fake.calls.length === before + 1 && promptOf(fake.calls[fake.calls.length - 1]).includes("the second edition"), `${fake.calls.length - before} requests`);
  await t.audit("after generating again");
}, { viewport: "desktop", smoke: true });
