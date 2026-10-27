// AI fields and "Write with AI", against a fake language model: an OpenAI-style endpoint
// (page.route on a made-up address) answering with scripted replies. Values fill in by themselves,
// "Generate again" with a nudge, a value typed over and the "Replace what you typed?" question, a
// rate limit (429) pausing everything, a failure and Retry, many values asking first, the banner
// when no model is set up, and a component written with AI. Popovers and dialogs with their checks.

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


for (const vp of ["desktop", "phone"]) {
  test(`AI values fill in by themselves, generate again with a nudge @ ${vp}`, async (t) => {
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
    await t.openPanel(t.page.locator(".ws-pane--active .item-fields"), "Generate again");
    await t.audit("generate again popover");
    const nudge = t.page.locator(".toolbar-popover.cds--popover--open").getByRole("textbox", { name: /Nudge/ });
    await nudge.click();
    await t.popoverStep("typing a nudge", () => t.page.keyboard.type("the second edition", { delay: 10 }), { target: nudge, scope: ".ws-pane--active .page-header" });
    await t.page.locator(".toolbar-popover.cds--popover--open").getByRole("button", { name: "Generate", exact: true }).click();
    await t.until("Generate closes the popover", async () => (await t.count(".toolbar-popover.cds--popover--open")) === 0);
    await t.until("the nudged value replaces the old one", async () => (await t.page.locator(".ws-pane--active .item-fields").innerText()).includes("AI summary, nudged"), { timeout: 10000 });
    await t.check("one more request, with the nudge in it", fake.calls.length === before + 1 && promptOf(fake.calls[fake.calls.length - 1]).includes("the second edition"), `${fake.calls.length - before} requests`);
    await t.audit("after generating again");
  }, { viewport: vp, smoke: vp === "desktop" });
}

test("a value typed over is kept or replaced only when asked", async (t) => {
  await t.boot();
  const fake = await fakeModel(t, summaryReply);
  const ids = await t.seed(aiSpec(1));
  await t.open(t.itemPath(ids.collections.books, ids.items["books/i0"]));
  await t.until("the value fills in", async () => (await t.page.locator(".ws-pane--active .item-fields").innerText()).includes("AI summary of"), { timeout: 15000 });
  // Typed over: the user's text.
  await t.page.getByRole("button", { name: "Edit Summary", exact: true }).click();
  await t.editorReady();
  await t.page.keyboard.press("Control+A");
  await t.page.keyboard.type("My own summary");
  await t.page.keyboard.press("Enter");
  await t.until("the typed value is shown", async () => (await t.page.locator(".ws-pane--active .item-fields").innerText()).includes("My own summary"));
  const rename = async (suffix) => {
    await t.page.locator(".item-title").first().click();
    await t.editorReady(".item-title--editing");
    await t.page.keyboard.press("Control+End");
    await t.page.keyboard.type(suffix);
    await t.page.keyboard.press("Enter");
  };
  // What the prompt reads changes (the title): asked, not replaced.
  const calls = fake.calls.length;
  await rename(" (revised)");
  await t.until("the dialog asks before replacing the typed value", async () => (await t.page.locator(".cds--modal.is-visible").innerText().catch(() => "")).includes("Replace what you typed?"), { timeout: 10000 });
  await t.audit("replace what you typed? dialog");
  await t.page.locator(".cds--modal.is-visible").getByRole("button", { name: "Keep mine" }).click();
  await t.settle();
  await t.wait(1500);
  await t.check("Keep mine keeps the typed value, no request", (await t.page.locator(".ws-pane--active .item-fields").innerText()).includes("My own summary") && fake.calls.length === calls, `${fake.calls.length - calls} requests`);
  // Again, and this time replaced.
  await rename(" again");
  await t.until("asked again after another change", async () => (await t.page.locator(".cds--modal.is-visible").innerText().catch(() => "")).includes("Replace what you typed?"), { timeout: 10000 });
  await t.page.locator(".cds--modal.is-visible").getByRole("button", { name: "Generate again" }).click();
  await t.until("Generate again replaces it", async () => {
    const text = await t.page.locator(".ws-pane--active .item-fields").innerText();
    return (text.includes("AI summary of") && !text.includes("My own summary")) || "still the typed value";
  }, { timeout: 10000 });
});

test("a rate limit (429) pauses the requests; a failure shows Retry", async (t) => {
  await t.boot();
  const fake = await fakeModel(t, () => ({ status: 429, message: "Too many requests" }));
  const ids = await t.seed(aiSpec(3));
  await t.open(t.listPath(ids.collections.books));
  await t.until("a request was made", async () => fake.calls.length > 0 || "no request yet", { timeout: 10000 });
  await t.wait(4000);
  const n = fake.calls.length;
  await t.check("after a 429 no more requests go out for a while", n <= 3, `${n} requests within 4s of a 429`);
  await t.check("no value was filled in", !(await t.page.locator(".ws-pane--active").innerText()).includes("AI summary of"));
  await t.audit("rate limited");
});

test("a failed value shows its error, Retry tries again", async (t) => {
  await t.boot();
  const fake = await fakeModel(t, () => ({ status: 500, message: "The model is down" }));
  const ids = await t.seed(aiSpec(2));
  await t.open(t.listPath(ids.collections.books));
  // The AI icon beside the sync icon; its popover tells what happened.
  const icon = t.page.getByRole("button", { name: "AI values failed" });
  await t.until("the AI icon shows a failure", async () => (await icon.count()) === 1, { timeout: 15000 });
  await icon.click();
  const panel = t.page.locator(".sync-popover");
  await t.until("its popover says values failed, with the error", async () => /failed/.test(await panel.innerText().catch(() => "")) && /The model is down/.test(await panel.innerText()));
  await t.audit("AI failure popover");
  fake.answer = summaryReply;
  await panel.getByRole("button", { name: "Retry" }).click();
  await t.until("Retry fills the values in", async () => ((await t.page.locator(".ws-pane--active").innerText()).match(/AI summary of/g) || []).length >= 2, { timeout: 15000 });
  await t.until("the AI icon goes", async () => (await icon.count()) === 0);
});

for (const vp of ["desktop", "phone"]) {
  test(`many values ask first: Not now sends nothing, Continue goes on @ ${vp}`, async (t) => {
    await t.boot();
    const fake = await fakeModel(t, summaryReply);
    const ids = await t.seed(aiSpec(14));
    await t.open(t.listPath(ids.collections.books));
    const modal = t.page.locator(".cds--modal.is-visible");
    await t.until("a dialog asks before generating many values", async () => /Generate \d+ AI values\?/.test(await modal.innerText().catch(() => "")), { timeout: 10000 });
    await t.audit("generate many values? dialog");
    await t.check("nothing is sent before the answer", fake.calls.length === 0, `${fake.calls.length} requests`);
    await modal.getByRole("button", { name: "Not now" }).click();
    await t.wait(2500);
    await t.check("Not now: still nothing sent", fake.calls.length === 0, `${fake.calls.length} requests`);
    // Next time the app opens it asks again; Continue starts them (rate limited: a few at first).
    await t.open(t.listPath(ids.collections.books));
    await t.until("asked again after a reload", async () => /Generate \d+ AI values\?/.test(await modal.innerText().catch(() => "")), { timeout: 10000 });
    await modal.getByRole("button", { name: "Continue" }).click();
    await t.until("Continue sends requests and values appear", async () => (await t.page.locator(".ws-pane--active").innerText()).includes("AI summary of") || `${fake.calls.length} requests`, { timeout: 15000 });
    await t.audit("generating many values", { skip: ["content-jump"] });
  }, { viewport: vp });
}

test("no model set up: the AI icon says so and leads to the settings", async (t) => {
  await t.boot();
  const spec = profileSpec("typical", { items: 2, ai: true });
  const ids = await t.seed(spec);
  await t.open(t.listPath(ids.collections.books));
  const icon = t.page.getByRole("button", { name: "AI isn't set up" });
  await t.until("the AI icon says AI isn't set up", async () => (await icon.count()) === 1, { timeout: 10000 });
  await icon.click();
  const panel = t.page.locator(".sync-popover");
  await t.until("its popover says why", async () => (await panel.innerText().catch(() => "")).includes("wait for a model"));
  await t.audit("AI not set up popover");
  await panel.getByRole("button", { name: "Open settings" }).click();
  await t.settle();
  await t.until("Open settings shows the AI settings", async () => (await t.page.locator(".ws-pane--active").innerText()).includes("API key"), { timeout: 5000 });
  await t.audit("AI settings from the AI icon");
});

for (const vp of ["desktop", "phone"]) {
  test(`write a component with AI @ ${vp}`, async (t) => {
    await t.boot();
    const fake = await fakeModel(t, () => JSON.stringify({ name: "Reading time", description: "Hours to read it", output: "markdown", code: "{{ ($item.Count ?? 0) / 40 }} hours" }));
    const spec = profileSpec("typical", { items: 2 });
    spec.prefs = AI_PREFS;
    await t.seed(spec);
    await t.open("/components/new");
    const box = t.page.getByRole("textbox", { name: "Write with AI" });
    await box.click();
    await t.page.keyboard.type("the reading time in hours from the count", { delay: 5 });
    const write = t.page.getByRole("button", { name: /^Write/ });
    await t.noShift("writing moves nothing above the editor", async () => {
      await write.click();
      await t.until("the code is written into the editor", async () => (await t.page.getByRole("textbox", { name: "Component" }).inputValue().catch(() => "")).includes("/ 40") || "not yet", { timeout: 10000 });
    }, { scope: ".ws-pane--active .page-header" });
    await t.check("the description is filled in", (await t.page.getByRole("textbox", { name: "Description" }).inputValue()).includes("Hours to read it"));
    await t.check("the box is emptied for a follow-up", (await box.inputValue()) === "");
    await t.check("the request carried the help text (the language)", promptOf(fake.calls[0] || {}).includes("{{"), "no {{ }} in the request");
    await t.audit("component written with AI");
    // A reply that isn't a component: the error says so.
    fake.answer = () => "Sorry, I can't.";
    await box.click();
    await t.page.keyboard.type("make it minutes");
    await write.click();
    await t.until("a reply that isn't a component shows an error", async () => (await t.page.locator(".write-with-ai").innerText()).includes("Could not write it"), { timeout: 10000 });
    await t.audit("write with AI error");
  }, { viewport: vp });
}
