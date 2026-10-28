// @vitest-environment node
// The AI service's queue: what runs when, how many at once, rate limits, the long-queue question,
// failures, typed values. The repository and the language model are stand-ins; time is faked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Repository } from "../data";
import type { Collection, FieldDef, Item } from "../domain/model";
import { CONFIRM_LIMIT, AiService, type AiConfig, type AiJob } from "./ai";

const field = (id: string, extra: Partial<FieldDef> = {}): FieldDef => ({ id, name: `F${id}`, output: "string", ...extra }) as FieldDef;
const collection = { id: "c" } as Collection;

const OWN: AiConfig = { source: "own", baseUrl: "https://llm.test/v1", apiKey: "k", fieldModel: "m", codeModel: "", paused: false };

const job = (itemId: string, extra: Partial<AiJob> & { hash?: string; field?: FieldDef } = {}): AiJob => {
  const { hash = "h1", field: f = field("f1"), ...rest } = extra;
  return { collection, field: f, itemId, request: { system: "sys", prompt: `prompt ${itemId}`, hash }, label: `Item ${itemId}`, ...rest };
};

interface Harness {
  ai: AiService;
  repo: { getItem: ReturnType<typeof vi.fn>; setGenerated: ReturnType<typeof vi.fn>; acceptEdit: ReturnType<typeof vi.fn> };
  /** The bodies sent to the model, in order. */
  asked: { model: string; messages: { role: string; content: string }[] }[];
  /** What the model answers next (a reply text, or a status for an error); the last one repeats. */
  replies: (string | number)[];
}

function setup(config: Partial<AiConfig> | null = {}): Harness {
  let stored: Partial<Item> | undefined = { id: "x", aiInputs: {} } as Partial<Item>;
  const repo = {
    sync: { config: { url: "", token: "" }, subscribe: () => () => {} },
    getItem: vi.fn(async () => stored),
    setGenerated: vi.fn(async () => {}),
    acceptEdit: vi.fn(async () => {}),
  };
  const h: Harness = { ai: undefined as never, repo, asked: [], replies: ["answer"] };
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    h.asked.push(JSON.parse(String(init.body)));
    const reply = h.replies.length > 1 ? h.replies.shift()! : h.replies[0];
    if (typeof reply === "number") return Response.json({ error: { message: "nope" } }, { status: reply });
    return Response.json({ choices: [{ message: { content: reply } }] });
  });
  h.ai = new AiService(repo as unknown as Repository);
  if (config) h.ai.setSettings({ ...OWN, ...config });
  void stored;
  return h;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

describe("generating a value", () => {
  it("asks the model with the request and stores the parsed reply with the prompt's hash", async () => {
    const h = setup();
    h.replies = ['  "Hello there"  '];
    h.ai.offer([job("i1")]);
    await tick();
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toMatchObject({ model: "m", messages: [{ role: "system", content: "sys" }, { role: "user", content: "prompt i1" }] });
    expect(h.repo.setGenerated).toHaveBeenCalledWith(collection, "i1", expect.objectContaining({ id: "f1" }), "Hello there", "h1");
    expect(h.ai.cellState("i1", "f1")).toBe("");
    expect(h.ai.isRecent("i1")).toBe(true);
    await tick(30_000);
    expect(h.ai.isRecent("i1")).toBe(false);
  });

  it("stores a number for a number field and fails on a reply that is not one", async () => {
    const h = setup();
    h.replies = ["about 1,5 km"];
    h.ai.offer([job("i1", { field: field("n", { output: "number" }) })]);
    await tick();
    expect(h.repo.setGenerated).toHaveBeenCalledWith(collection, "i1", expect.anything(), 1.5, "h1");

    h.replies = ["lots"];
    h.ai.offer([job("i2", { field: field("n", { output: "number" }) })]);
    await tick(2000);
    expect(h.ai.cellState("i2", "n")).toBe("error: Not a number: lots");
    expect(h.ai.getProgress()).toMatchObject({ failed: 1, lastError: "Not a number: lots" });
  });

  it("does not ask when the stored value already answers this prompt, unless forced", async () => {
    const h = setup();
    h.repo.getItem.mockResolvedValue({ aiInputs: { f1: "h1" } });
    h.ai.offer([job("i1")]);
    await tick();
    expect(h.asked).toHaveLength(0);
    expect(h.repo.setGenerated).not.toHaveBeenCalled();
    h.ai.regenerate(job("i1"));
    await tick(2000);
    expect(h.asked).toHaveLength(1);
    expect(h.repo.setGenerated).toHaveBeenCalledOnce();
  });

  it("does nothing for an item that no longer exists", async () => {
    const h = setup();
    h.repo.getItem.mockResolvedValue(undefined);
    h.ai.offer([job("gone")]);
    await tick();
    expect(h.asked).toHaveLength(0);
    expect(h.ai.getProgress().failed).toBe(0);
  });

  it("sends the user's hint along once", async () => {
    const h = setup();
    h.ai.regenerate(job("i1", { hint: "the 1999 film" }));
    await tick();
    expect(h.asked[0].messages[1].content).toBe("prompt i1\n\nA nudge from the user about this item: the 1999 film");
  });

  it("does not take the same prompt twice, but takes a changed one", async () => {
    const h = setup();
    h.ai.offer([job("i1"), job("i1")]);
    await tick();
    h.ai.offer([job("i1")]); // already running or done with this hash: it is not stored in the stand-in
    await tick(2000);
    expect(h.asked.length).toBeGreaterThanOrEqual(1);
    const before = h.asked.length;
    h.ai.offer([job("i1", { hash: "h2" })]);
    await tick(2000);
    expect(h.asked.length).toBe(before + 1);
  });
});

describe("a model that is not set up", () => {
  it("holds shown values and runs them once settings arrive", async () => {
    const h = setup(null);
    h.ai.offer([job("i1"), job("i2")]);
    expect(h.ai.getProgress()).toMatchObject({ held: 2, configured: false, working: 0 });
    expect(h.ai.cellState("i1", "f1")).toBe("held");
    expect(h.asked).toHaveLength(0);
    h.ai.setSettings({ ...OWN });
    await tick(2000);
    expect(h.asked).toHaveLength(2);
    expect(h.ai.getProgress()).toMatchObject({ held: 0, configured: true });
  });

  it("dismissHeld drops them and they are not offered again until the prompt changes", async () => {
    const h = setup(null);
    h.ai.offer([job("i1")]);
    h.ai.dismissHeld();
    expect(h.ai.getProgress().held).toBe(0);
    h.ai.offer([job("i1")]);
    expect(h.ai.getProgress().held).toBe(0);
    h.ai.offer([job("i1", { hash: "h2" })]);
    expect(h.ai.getProgress().held).toBe(1);
  });
});

describe("pacing", () => {
  it("starts one request per interval, whoever asked, at most three at once", async () => {
    const h = setup();
    h.replies = ["a"];
    // Requests that never finish, to see how many are in flight.
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      h.asked.push(JSON.parse(String(init.body)));
      return new Promise<Response>(() => {});
    });
    h.ai.offer([1, 2, 3, 4, 5].map((n) => job(`i${n}`)));
    await tick();
    expect(h.asked).toHaveLength(1);
    await tick(1500);
    expect(h.asked).toHaveLength(2);
    await tick(1500);
    expect(h.asked).toHaveLength(3);
    await tick(10_000);
    expect(h.asked).toHaveLength(3); // a fourth waits for one to finish
    expect(h.ai.cellState("i1", "f1")).toBe("running");
    expect(h.ai.cellState("i4", "f1")).toBe("queued");
    expect(h.ai.getProgress().working).toBe(5);
  });

  it("shown values go before the backfill's, which waits behind them", async () => {
    const h = setup();
    h.ai.offerBackground([job("bg1"), job("bg2")]);
    h.ai.offer([job("shown")]);
    expect(h.ai.cellState("bg2", "f1")).toBe("held"); // in the backfill's line
    expect(h.ai.cellState("bg1", "f1")).toBe("running"); // it started before the shown one was found
    expect(h.ai.cellState("shown", "f1")).toBe("queued"); // and the shown one is next, ahead of bg2
    await tick(10_000);
    expect(h.asked.map((a) => a.messages[1].content)).toEqual(["prompt bg1", "prompt shown", "prompt bg2"]);
  });

  it("a shown value moves up from the backfill's line", async () => {
    const h = setup();
    h.ai.setSettings({ ...OWN, paused: true });
    h.ai.offerBackground([job("a"), job("b")]);
    h.ai.offer([job("b")]);
    expect(h.ai.cellState("b", "f1")).toBe("queued");
    expect(h.ai.cellState("a", "f1")).toBe("held");
    h.ai.setSettings({ ...OWN, paused: false });
    await tick(5000);
    expect(h.asked.map((a) => a.messages[1].content)).toEqual(["prompt b", "prompt a"]);
  });

  it("paused: nothing starts, whatever waits stays queued; resuming runs it", async () => {
    const h = setup({ paused: true });
    h.ai.offer([job("i1")]);
    await tick(10_000);
    expect(h.asked).toHaveLength(0);
    expect(h.ai.getProgress()).toMatchObject({ paused: true, working: 1, confirm: 0 });
    h.ai.setSettings({ ...OWN, paused: false });
    await tick();
    expect(h.asked).toHaveLength(1);
  });
});

describe("a long queue", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => job(`i${i}`));

  it("up to the limit runs by itself", async () => {
    const h = setup();
    h.ai.offer(many(CONFIRM_LIMIT));
    await tick(60_000);
    expect(h.asked).toHaveLength(CONFIRM_LIMIT);
  });

  it("more than the limit waits for the go-ahead, then runs everything", async () => {
    const h = setup();
    h.ai.offer(many(CONFIRM_LIMIT + 1));
    await tick(60_000);
    expect(h.asked).toHaveLength(0);
    expect(h.ai.getProgress()).toMatchObject({ confirm: CONFIRM_LIMIT + 1, working: CONFIRM_LIMIT + 1 });
    h.ai.confirmQueue();
    await tick(60_000);
    expect(h.asked).toHaveLength(CONFIRM_LIMIT + 1);
    expect(h.ai.getProgress()).toMatchObject({ confirm: 0, working: 0 });
  });

  it("'Not now' drops them for this session", async () => {
    const h = setup();
    h.ai.offer(many(CONFIRM_LIMIT + 1));
    h.ai.cancelQueue();
    expect(h.ai.getProgress()).toMatchObject({ confirm: 0, working: 0 });
    h.ai.offer(many(CONFIRM_LIMIT + 1));
    expect(h.ai.getProgress().working).toBe(0); // dismissed, not asked about again
    await tick(60_000);
    expect(h.asked).toHaveLength(0);
  });

  it("the approval ends with the queue: the next long queue asks again", async () => {
    const h = setup();
    h.ai.offer(many(CONFIRM_LIMIT + 1));
    h.ai.confirmQueue();
    await tick(60_000);
    h.ai.offer(many(CONFIRM_LIMIT + 1).map((j) => ({ ...j, request: { ...j.request, hash: "h2" } })));
    expect(h.ai.getProgress().confirm).toBe(CONFIRM_LIMIT + 1);
  });
});

describe("rate limits", () => {
  it("a 429 pauses everything for a while and tries the value again", async () => {
    const h = setup();
    h.replies = [429, "fine"];
    h.ai.offer([job("i1"), job("i2")]);
    await tick();
    expect(h.asked).toHaveLength(1);
    expect(h.ai.getProgress().failed).toBe(0);
    await tick(20_000);
    expect(h.asked).toHaveLength(1); // still pausing, i2 waits too
    await tick(15_000);
    expect(h.asked.length).toBeGreaterThanOrEqual(2);
    await tick(10_000);
    expect(h.repo.setGenerated).toHaveBeenCalledTimes(2);
    expect(h.ai.getProgress().failed).toBe(0);
  });

  it("gives up after the fourth retry and shows the error; Retry tries afresh", async () => {
    const h = setup();
    h.replies = [429];
    h.ai.offer([job("i1")]);
    await tick(5 * 31_000);
    expect(h.asked).toHaveLength(5); // the first try and four retries
    expect(h.ai.cellState("i1", "f1")).toMatch(/^error: 429/);
    expect(h.ai.getProgress()).toMatchObject({ failed: 1 });
    h.replies = ["ok"];
    h.ai.retryFailed();
    await tick(31_000);
    expect(h.repo.setGenerated).toHaveBeenCalledOnce();
    expect(h.ai.getProgress().failed).toBe(0);
  });

  it("any other failure is not retried by itself", async () => {
    const h = setup();
    h.replies = [500];
    h.ai.offer([job("i1")]);
    await tick(10_000);
    expect(h.asked).toHaveLength(1);
    expect(h.ai.cellState("i1", "f1")).toMatch(/^error: 500.*nope/);
    h.ai.offer([job("i1")]); // the same prompt: it failed, not offered again
    await tick(10_000);
    expect(h.asked).toHaveLength(1);
  });

  it("dismissFailed gives up on them until the prompt changes", async () => {
    const h = setup();
    h.replies = [500];
    h.ai.offer([job("i1")]);
    await tick(1000);
    h.ai.dismissFailed();
    expect(h.ai.getProgress().failed).toBe(0);
    expect(h.ai.cellState("i1", "f1")).toBe("");
    h.ai.offer([job("i1")]);
    await tick(5000);
    expect(h.asked).toHaveLength(1);
    h.replies = ["ok"];
    h.ai.offer([job("i1", { hash: "h2" })]);
    await tick(5000);
    expect(h.asked).toHaveLength(2);
  });

  it("a failed backfill value is retried in the backfill's line", async () => {
    const h = setup();
    h.replies = [500];
    h.ai.offerBackground([job("i1")]);
    await tick(1000);
    expect(h.ai.getProgress().failed).toBe(1);
    h.replies = ["ok"];
    h.ai.retryFailed();
    await tick(2000);
    expect(h.repo.setGenerated).toHaveBeenCalledOnce();
  });
});

describe("values the user typed", () => {
  it("adopt records the item's state once per prompt, even if asked again meanwhile", async () => {
    const h = setup();
    let release!: () => void;
    h.repo.acceptEdit.mockImplementation(() => new Promise<void>((r) => (release = r)));
    h.ai.adopt([job("i1"), job("i1")]);
    expect(h.repo.acceptEdit).toHaveBeenCalledTimes(1);
    expect(h.repo.acceptEdit).toHaveBeenCalledWith(collection, "i1", expect.objectContaining({ id: "f1" }), "h1");
    release();
    await tick();
    h.ai.adopt([job("i1")]);
    expect(h.repo.acceptEdit).toHaveBeenCalledTimes(2);
  });

  it("a failing adopt is logged, not thrown", async () => {
    const h = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    h.repo.acceptEdit.mockRejectedValue(new Error("db"));
    h.ai.adopt([job("i1")]);
    await tick();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("changed prompts are asked about; 'generate again' replaces them, 'keep' adopts them", async () => {
    const h = setup();
    const seen = vi.fn();
    h.ai.subscribe(seen);
    h.ai.offerOverrides([job("i1"), job("i2", { label: undefined })]);
    expect(h.ai.getProgress()).toMatchObject({ overrides: 2, overrideSample: "Item i1 · Ff1" });
    expect(seen).toHaveBeenCalled();

    // The same prompt again is nothing new; a settled one leaves the question.
    seen.mockClear();
    h.ai.offerOverrides([job("i1")], [["i2", "f1"]]);
    expect(h.ai.getProgress().overrides).toBe(1);

    h.ai.replaceOverrides();
    expect(h.ai.getProgress().overrides).toBe(0);
    h.repo.getItem.mockResolvedValue({ aiInputs: { f1: "h1" } }); // current, but forced
    await tick();
    expect(h.asked).toHaveLength(1);

    h.ai.offerOverrides([job("i3")]);
    h.ai.keepOverrides();
    expect(h.repo.acceptEdit).toHaveBeenCalledWith(collection, "i3", expect.anything(), "h1");
    expect(h.ai.getProgress().overrides).toBe(0);
  });

  it("offerOverrides with nothing new does not notify", () => {
    const h = setup();
    h.ai.offerOverrides([job("i1")]);
    const seen = vi.fn();
    h.ai.subscribe(seen);
    h.ai.offerOverrides([job("i1")]);
    expect(seen).not.toHaveBeenCalled();
  });

  it("regenerate takes the value out of the question", async () => {
    const h = setup();
    h.ai.offerOverrides([job("i1")]);
    h.ai.regenerate(job("i1"));
    expect(h.ai.getProgress().overrides).toBe(0);
    await tick();
    expect(h.asked).toHaveLength(1);
  });
});

describe("problems", () => {
  it("shows why a value has no prompt in its place, and clears it", () => {
    const h = setup();
    const seen = vi.fn();
    h.ai.subscribe(seen);
    h.ai.setProblems([["i1", "f1", "Choose a component"]]);
    expect(h.ai.cellState("i1", "f1")).toBe("error: Choose a component");
    expect(seen).toHaveBeenCalledTimes(1);
    h.ai.setProblems([["i1", "f1", "Choose a component"]]); // unchanged: no notification
    expect(seen).toHaveBeenCalledTimes(1);
    h.ai.setProblems([["i1", "f1", null]]);
    expect(h.ai.cellState("i1", "f1")).toBe("");
    h.ai.setProblems([["never", "f1", null]]); // clearing what was never set changes nothing
    expect(seen).toHaveBeenCalledTimes(2);
  });
});

describe("progress", () => {
  it("is a new object only when something shows differently", async () => {
    const h = setup();
    const first = h.ai.getProgress();
    h.ai.setProblems([["i1", "f1", "x"]]);
    expect(h.ai.getProgress()).toBe(first);
    h.ai.offer([job("i1")]);
    expect(h.ai.getProgress()).not.toBe(first);
  });

  it("subscribe returns an unsubscribe", () => {
    const h = setup();
    const seen = vi.fn();
    const off = h.ai.subscribe(seen);
    off();
    h.ai.setProblems([["i1", "f1", "x"]]);
    expect(seen).not.toHaveBeenCalled();
  });
});

describe("models", () => {
  it("the code model falls back to the field model; a provider needs an address", () => {
    const h = setup({ fieldModel: " fm ", codeModel: "" });
    expect(h.ai.modelFor("field")).toBe("fm");
    expect(h.ai.modelFor("code")).toBe("fm");
    h.ai.setSettings({ ...OWN, fieldModel: "fm", codeModel: "cm" });
    expect(h.ai.modelFor("code")).toBe("cm");
    expect(h.ai.isConfigured("code")).toBe(true);
    h.ai.setSettings({ ...OWN, baseUrl: "  " });
    expect(h.ai.isConfigured("field")).toBe(false);
    expect(h.ai.settings.baseUrl).toBe("  ");
  });
});

describe("the server's offer", () => {
  const sync = (url: string, token: string) => {
    let listener = () => {};
    const config = { url, token };
    return { config, subscribe: (l: () => void) => ((listener = l), () => {}), fire: () => listener() };
  };
  const make = (s: ReturnType<typeof sync>) => new AiService({ sync: s } as unknown as Repository);

  it("says the server is unreachable, and asks again after a while", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      throw new Error("offline");
    });
    const s = sync("https://s.test", "t");
    const ai = make(s);
    await tick();
    expect(ai.serverOffer.problem).toBe("Can't reach https://s.test.");
    s.fire(); // soon after: no new look
    expect(calls).toBe(1);
    await tick(31_000);
    s.fire();
    await tick();
    expect(calls).toBe(2);
  });

  it("reports an error status, and serverChanged looks again at once", async () => {
    let status = 500;
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return status === 200 ? Response.json({ available: true, fieldModel: "big", codeModel: "" }) : new Response("no", { status });
    });
    const ai = make(sync("https://s.test", "t"));
    await tick();
    expect(ai.serverOffer.problem).toBe("The server answered 500.");
    status = 200;
    ai.serverChanged();
    await tick();
    expect(calls).toBe(2);
    expect(ai.serverOffer).toMatchObject({ problem: null, ai: { fieldModel: "big" } });
    expect(ai.configured).toBe(true);
  });

  it("an offer arriving for a server since replaced is ignored", async () => {
    let resolve!: (r: Response) => void;
    vi.stubGlobal("fetch", () => new Promise<Response>((r) => (resolve = r)));
    const s = sync("https://old.test", "t");
    const ai = make(s);
    s.config.url = "";
    s.fire();
    expect(ai.serverOffer.problem).toMatch(/No server/);
    resolve(Response.json({ available: true, fieldModel: "stale", codeModel: "" }));
    await tick();
    expect(ai.serverOffer.ai).toBeNull();
  });

  it("jobs held for lack of a model run once the server offers one", async () => {
    const s = sync("https://s.test", "t");
    let answer: Response | undefined;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url.endsWith("/api/ai")) return answer ?? Response.json({ available: false, fieldModel: "", codeModel: "" });
      return Response.json({ choices: [{ message: { content: `via ${url} ${(init.headers as Record<string, string>).Authorization}` } }] });
    });
    const repo = { sync: s, getItem: async () => ({ aiInputs: {} }), setGenerated: vi.fn(async () => {}), acceptEdit: vi.fn() };
    const ai = new AiService(repo as unknown as Repository);
    await tick();
    ai.offer([job("i1")]);
    expect(ai.getProgress().held).toBe(1);
    answer = Response.json({ available: true, fieldModel: "big", codeModel: "" });
    ai.serverChanged();
    await tick(2000);
    expect(repo.setGenerated).toHaveBeenCalledWith(collection, "i1", expect.anything(), "via https://s.test/api/ai/chat/completions Bearer t", "h1");
  });
});
