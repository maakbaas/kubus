// @vitest-environment node
// The platform adapters: language model client, opening links, shell integration. Browser APIs are stand-ins.
import { afterEach, describe, expect, it, vi } from "vitest";
import { suppressShellContextMenu } from "./contextMenu";
import { isTextField, TEXT_FIELD, trackKeyboardInset } from "./keyboardInset";
import { createLlmClient } from "./llm";
import { openExternal } from "./openExternal";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.restoreAllMocks();
});

const messages = [{ role: "user" as const, content: "hi" }];
const settings = { baseUrl: "https://llm.test/v1/", apiKey: "key", model: " m " };

/** A fetch that answers once with `body`/`status`, remembering the request. */
function answering(body: unknown, init: ResponseInit = {}) {
  const requests: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, i: RequestInit) => {
    requests.push({ url, init: i });
    return typeof body === "string" ? new Response(body, init) : Response.json(body, init);
  });
  return requests;
}

describe("the language model client", () => {
  it("posts the conversation to /chat/completions with the key, and returns the reply", async () => {
    const requests = answering({ choices: [{ message: { content: "hello" } }] });
    expect(await createLlmClient(settings).complete(messages)).toBe("hello");
    expect(requests[0].url).toBe("https://llm.test/v1/chat/completions"); // the trailing slash is not doubled
    expect(requests[0].init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer key" } });
    expect(JSON.parse(String(requests[0].init.body))).toEqual({ model: "m", messages });
  });

  it("sends no Authorization header for a provider without a key", async () => {
    const requests = answering({ choices: [{ message: { content: "ok" } }] });
    await createLlmClient({ ...settings, apiKey: "" }).complete(messages);
    expect(requests[0].init.headers).not.toHaveProperty("Authorization");
  });

  it("joins a reply in parts", async () => {
    answering({ choices: [{ message: { content: [{ text: "a" }, { type: "x" }, { text: "b" }] } }] });
    expect(await createLlmClient(settings).complete(messages)).toBe("ab");
  });

  it("says what is missing before asking", async () => {
    const requests = answering({});
    await expect(createLlmClient({ ...settings, baseUrl: "  " }).complete(messages)).rejects.toThrow("No provider address is set.");
    await expect(createLlmClient({ ...settings, model: " " }).complete(messages)).rejects.toThrow("No model is chosen.");
    expect(requests).toHaveLength(0);
  });

  it("fails with the provider's status and its message, whichever shape it uses", async () => {
    answering({ error: { message: "Invalid key" } }, { status: 401, statusText: "Unauthorized" });
    await expect(createLlmClient(settings).complete(messages)).rejects.toThrow("401 Unauthorized: Invalid key");
    answering({ error: "quota used" }, { status: 429 });
    await expect(createLlmClient(settings).complete(messages)).rejects.toThrow("429: quota used");
    answering({ message: "plain" }, { status: 400 });
    await expect(createLlmClient(settings).complete(messages)).rejects.toThrow("400: plain");
    answering("<html>bad gateway</html>", { status: 502 });
    await expect(createLlmClient(settings).complete(messages)).rejects.toThrow(/^502$/);
  });

  it("fails on an error in a successful answer, and on an empty reply", async () => {
    answering({ error: { message: "model overloaded" } });
    await expect(createLlmClient(settings).complete(messages)).rejects.toThrow("model overloaded");
    answering({ choices: [{ message: { content: "   " } }] });
    await expect(createLlmClient(settings).complete(messages)).rejects.toThrow("The model replied with nothing.");
    answering({ choices: [] });
    await expect(createLlmClient(settings).complete(messages)).rejects.toThrow("The model replied with nothing.");
  });

  it("says the provider can't be reached, but passes an abort on as it is", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(createLlmClient(settings).complete(messages)).rejects.toThrow("Could not reach https://llm.test/v1. Check the address and your connection.");
    vi.stubGlobal("DOMException", DOMException);
    vi.stubGlobal("fetch", async () => {
      throw new DOMException("aborted", "AbortError");
    });
    await expect(createLlmClient(settings).complete(messages)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("lists the models the provider offers, sorted, without what isn't an id", async () => {
    const requests = answering({ data: [{ id: "b" }, { id: "a" }, { id: 3 }, {}] });
    expect(await createLlmClient(settings).models()).toEqual(["a", "b"]);
    expect(requests[0].url).toBe("https://llm.test/v1/models");
    answering({});
    expect(await createLlmClient(settings).models()).toEqual([]);
  });

  it("lists none without an address", async () => {
    const requests = answering({ data: [{ id: "a" }] });
    expect(await createLlmClient({ ...settings, baseUrl: "" }).models()).toEqual([]);
    expect(requests).toHaveLength(0);
  });
});

describe("openExternal", () => {
  it("ignores blocked and relative links", async () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open, location: { href: "" } });
    await openExternal("javascript:alert(1)");
    await openExternal("files/abc");
    expect(open).not.toHaveBeenCalled();
    expect((window as unknown as { location: { href: string } }).location.href).toBe("");
  });

  it("opens a web page in a new tab, without giving it the opener", async () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open, location: { href: "" } });
    await openExternal("https://example.org/x");
    expect(open).toHaveBeenCalledWith("https://example.org/x", "_blank", "noopener,noreferrer");
  });

  it("hands another app's link to the browser in this tab, which leaves no empty tab behind", async () => {
    const open = vi.fn();
    const location = { href: "" };
    vi.stubGlobal("window", { open, location });
    await openExternal("spotify:track:1");
    expect(location.href).toBe("spotify:track:1");
    expect(open).not.toHaveBeenCalled();
  });

  it("uses the shell's opener in the desktop app", async () => {
    const openUrl = vi.fn(async () => {});
    vi.doMock("@tauri-apps/plugin-opener", () => ({ openUrl }));
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, open: vi.fn() });
    const { openExternal: open } = await import("./openExternal");
    await open("https://example.org");
    expect(openUrl).toHaveBeenCalledWith("https://example.org");
    expect((window as unknown as { open: () => void }).open).not.toHaveBeenCalled();
    vi.doUnmock("@tauri-apps/plugin-opener");
  });
});

describe("the shell's context menu", () => {
  it("is suppressed in the desktop app only", () => {
    const listeners: ((e: { preventDefault(): void }) => void)[] = [];
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, addEventListener: (_: string, l: (typeof listeners)[number]) => listeners.push(l) });
    suppressShellContextMenu();
    const preventDefault = vi.fn();
    listeners[0]({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();

    const browser = { addEventListener: vi.fn() };
    vi.stubGlobal("window", browser);
    suppressShellContextMenu();
    expect(browser.addEventListener).not.toHaveBeenCalled();
  });
});

describe("the keyboard inset", () => {
  function setup(viewport: { height: number; offsetTop: number; pageTop?: number } | undefined, innerHeight = 800) {
    const style = { setProperty: vi.fn() };
    const handlers = new Map<string, () => void>();
    const windowHandlers = new Map<string, () => void>();
    const visualViewport = viewport && { pageTop: 0, ...viewport, addEventListener: (type: string, h: () => void) => handlers.set(type, h) };
    const win = { innerHeight, visualViewport, scrollX: 0, scrollY: 0, scrollTo: vi.fn(), addEventListener: (type: string, h: () => void) => windowHandlers.set(type, h) };
    vi.stubGlobal("window", win);
    const doc = { documentElement: { style }, activeElement: null as unknown, addEventListener: (type: string, h: () => void) => windowHandlers.set(`document:${type}`, h) };
    vi.stubGlobal("document", doc);
    return { style, handlers, windowHandlers, win, viewport: visualViewport, doc };
  }

  it("is the height the keyboard covers, set now and whenever the viewport changes", () => {
    const t = setup({ height: 800, offsetTop: 0 });
    trackKeyboardInset();
    expect(t.style.setProperty).toHaveBeenLastCalledWith("--keyboard-inset", "0px");
    t.viewport!.height = 500;
    t.handlers.get("resize")!();
    expect(t.style.setProperty).toHaveBeenLastCalledWith("--keyboard-inset", "300px");
    t.viewport!.offsetTop = 50; // panned down by iOS: that part is not covered
    t.handlers.get("scroll")!();
    expect(t.style.setProperty).toHaveBeenLastCalledWith("--keyboard-inset", "250px");
  });

  it("is measured again when the window turns, and once more after iOS reports the new height", () => {
    vi.useFakeTimers();
    try {
      const t = setup({ height: 800, offsetTop: 0 });
      trackKeyboardInset();
      // Turned: the visual viewport event came first, the window's new height only now.
      t.win.innerHeight = 400;
      t.viewport!.height = 400;
      t.windowHandlers.get("orientationchange")!();
      expect(t.style.setProperty).toHaveBeenLastCalledWith("--keyboard-inset", "0px");
      // iOS still reported the old window height at that moment; later it is right.
      t.win.innerHeight = 800;
      t.viewport!.height = 500;
      t.windowHandlers.get("resize")!();
      expect(t.style.setProperty).toHaveBeenLastCalledWith("--keyboard-inset", "300px");
      t.viewport!.height = 800;
      vi.advanceTimersByTime(300);
      expect(t.style.setProperty).toHaveBeenLastCalledWith("--keyboard-inset", "0px");
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts a panned window back at 0,0 once no keyboard covers it and the viewport settled, and leaves it while one does", () => {
    vi.useFakeTimers();
    try {
      const t = setup({ height: 500, offsetTop: 0 });
      t.win.scrollY = 120;
      trackKeyboardInset();
      vi.advanceTimersByTime(1000);
      expect(t.win.scrollTo).not.toHaveBeenCalled(); // iOS panned it to show the focused field
      t.viewport!.height = 800;
      t.handlers.get("resize")!();
      expect(t.win.scrollTo).not.toHaveBeenCalled(); // not while iOS may still be moving it
      vi.advanceTimersByTime(300);
      expect(t.win.scrollTo).toHaveBeenCalledWith(0, 0);
      t.win.scrollTo.mockClear();
      t.win.scrollY = 0;
      t.handlers.get("resize")!();
      vi.advanceTimersByTime(300);
      expect(t.win.scrollTo).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // iOS, a field near the bottom tapped: focus, then the pan (reported before the smaller height,
  // so for a moment nothing seems covered), then the keyboard's height (panned by all of it:
  // again nothing of the window covered). A scroll then undid the pan and iOS closed the keyboard.
  it("never scrolls the window while a field has focus, however the pan and the height arrive", () => {
    vi.useFakeTimers();
    try {
      const t = setup({ height: 800, offsetTop: 0 });
      trackKeyboardInset();
      t.doc.activeElement = { matches: (s: string) => s.includes("textarea") };
      t.viewport!.offsetTop = 340;
      t.viewport!.pageTop = 340;
      t.handlers.get("scroll")!();
      t.win.scrollY = 20; // a window scroll among them
      t.windowHandlers.get("resize")!();
      t.viewport!.height = 460;
      t.handlers.get("resize")!();
      expect(t.style.setProperty).toHaveBeenLastCalledWith("--keyboard-inset", "0px");
      t.handlers.get("scroll")!();
      vi.advanceTimersByTime(2000);
      expect(t.win.scrollTo).not.toHaveBeenCalled();
      // "Done": the field blurs, the keyboard goes, the pan is left: put back once settled.
      t.doc.activeElement = null;
      t.windowHandlers.get("document:focusout")!();
      t.viewport!.height = 800;
      t.handlers.get("resize")!();
      vi.advanceTimersByTime(299);
      expect(t.win.scrollTo).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(t.win.scrollTo).toHaveBeenCalledWith(0, 0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a pinch-zoomed viewport where the user panned it", () => {
    vi.useFakeTimers();
    try {
      const t = setup({ height: 400, offsetTop: 400, pageTop: 400 }); // zoomed in 2x, panned to the bottom
      trackKeyboardInset();
      vi.advanceTimersByTime(1000);
      expect(t.win.scrollTo).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("knows the fields a keyboard comes up for", () => {
    const el = (selectorMatch: boolean) => ({ matches: vi.fn(() => selectorMatch) });
    expect(isTextField(el(true) as never)).toBe(true);
    expect(isTextField(el(false) as never)).toBe(false);
    expect(isTextField(null)).toBe(false);
    expect(isTextField({} as never)).toBe(false);
    for (const s of ["textarea", "select", "[contenteditable]", "input:not([type=checkbox])"]) expect(TEXT_FIELD).toContain(s);
  });

  it("is never negative", () => {
    const t = setup({ height: 900, offsetTop: 0 });
    trackKeyboardInset();
    expect(t.style.setProperty).toHaveBeenLastCalledWith("--keyboard-inset", "0px");
  });

  it("does nothing in a browser without a visual viewport", () => {
    const t = setup(undefined);
    trackKeyboardInset();
    expect(t.style.setProperty).not.toHaveBeenCalled();
  });
});

describe("the service worker", () => {
  async function load(env: { prod: boolean; worker: boolean; tauri?: boolean }) {
    vi.resetModules();
    vi.stubEnv("PROD", env.prod);
    const register = vi.fn(async () => {});
    const loads: (() => void)[] = [];
    vi.stubGlobal("window", env.tauri ? { __TAURI_INTERNALS__: {} } : {});
    vi.stubGlobal("navigator", env.worker ? { serviceWorker: { register } } : {});
    vi.stubGlobal("addEventListener", (_: string, l: () => void) => loads.push(l));
    const { registerServiceWorker } = await import("./serviceWorker");
    registerServiceWorker();
    return { register, loads };
  }
  afterEach(() => vi.unstubAllEnvs());

  it("registers sw.js once the page has loaded, in a production web build", async () => {
    const t = await load({ prod: true, worker: true });
    expect(t.loads).toHaveLength(1);
    t.loads[0]();
    expect(t.register).toHaveBeenCalledWith("sw.js");
  });

  it("warns instead of failing when it can't register", async () => {
    const t = await load({ prod: true, worker: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    t.register.mockRejectedValue(new Error("no"));
    t.loads[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith("Service worker not registered", expect.any(Error));
  });

  it("not in development, without service workers, or in the desktop shell", async () => {
    expect((await load({ prod: false, worker: true })).loads).toHaveLength(0);
    expect((await load({ prod: true, worker: false })).loads).toHaveLength(0);
    expect((await load({ prod: true, worker: true, tauri: true })).loads).toHaveLength(0);
  });
});
