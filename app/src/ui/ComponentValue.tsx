import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Html as HtmlIcon } from "@carbon/icons-react";
import type { FieldValue } from "../domain/model";
import { useStore } from "../app/store";
import { fileSrc, fileIdsIn } from "../domain/files";
import { isComponentError, type ComponentOutput } from "../domain/components";
import { BLOCK_HEIGHT } from "../domain/views";
import { TAG_SOURCE } from "../domain/tags";
import { openModeOf } from "../workspace/Workspace";
import { Highlight } from "./Highlight";
import { useMediaQuery } from "./useMediaQuery";
import { fileDataUrl, UrlImage } from "./images";
import { MarkdownView } from "./MarkdownView";
import { frameFonts } from "./frameFonts";
import { useOpenTag } from "./TagChip";

/**
 * App tokens a frame's base styles use: passed in as resolved values (the frame has no Carbon
 * CSS), read where the frame is, because the type tokens depend on the place: item fields read one
 * step up the type scale, blocks and cards don't (styles.css), exactly as rendered Markdown there.
 */
const FRAME_TOKENS = [
  "--cds-body-01-font-size",
  "--cds-body-01-line-height",
  "--cds-body-01-letter-spacing",
  "--cds-code-02-font-size",
  "--cds-code-02-line-height",
  "--cds-code-02-letter-spacing",
  "--cds-background",
  "--cds-text-primary",
  "--cds-text-secondary",
  "--cds-link-primary",
  "--cds-border-subtle",
  "--cds-border-strong",
  "--cds-layer-01",
  "--cds-layer-accent-01",
  "--cds-tag-background-blue",
  "--cds-tag-color-blue",
  "--cds-tag-hover-blue",
  "--cds-code-02-font-family",
  "--font-sans",
];

/**
 * The frame's base styles: Carbon's look, the same as rendered Markdown (body-01 text, heading
 * sizes, block spacing, links, lists, code, quotes, tables, rules). All at zero specificity
 * (:where), so any CSS in the component overrides them. Spacing goes only between text blocks:
 * the divs a map or chart library creates (often absolutely placed) are left alone.
 */
/** The frame tokens' values at `place` (the frame's parent), as declarations. */
function frameTokens(place: Element): string {
  const at = getComputedStyle(place);
  return FRAME_TOKENS.map((t) => `${t}:${at.getPropertyValue(t).trim()};`).join("");
}

function frameBaseStyles(tokens: string, dark: boolean): string {
  return `:root{${tokens}color-scheme:${dark ? "dark" : "light"};}
:where(html,body){margin:0;height:100%;}
html{overflow:hidden;}
html.measuring,html.measuring body{height:auto;}
html.fonts-pending body{visibility:hidden;}
:where(body){font-family:var(--font-sans);font-size:var(--cds-body-01-font-size);line-height:var(--cds-body-01-line-height);letter-spacing:var(--cds-body-01-letter-spacing);color:var(--cds-text-primary);overflow-wrap:anywhere;font-variant-ligatures:none;}
:where(p,h1,h2,h3,h4,h5,h6,ul,ol,dl,blockquote,pre,table,figure,hr){margin:0;}
:where(:not(style,script,meta,link,title,component)) + :where(p,h1,h2,h3,h4,h5,h6,ul,ol,dl,blockquote,pre,table,figure,hr){margin-top:0.75rem;}
:where(h1){font-size:1.75rem;line-height:1.3;font-weight:400;}
:where(h2){font-size:1.5rem;line-height:1.3;font-weight:400;}
:where(h3){font-size:1.25rem;line-height:1.4;font-weight:400;}
:where(h4,h5,h6){font-size:1rem;font-weight:600;}
:where(strong,b,th){font-weight:600;}
:where(a){color:var(--cds-link-primary);text-decoration:underline;}
:where(ul,ol){padding-left:1rem;}
:where(li) > :where(p){margin:0;}
:where(li + li){margin-top:0;}
:where(blockquote){border-left:3px solid var(--cds-border-strong);padding-left:1rem;color:var(--cds-text-secondary);}
:where(code,pre,kbd,samp){font-family:var(--cds-code-02-font-family);font-size:var(--cds-code-02-font-size);line-height:var(--cds-code-02-line-height);letter-spacing:var(--cds-code-02-letter-spacing);}
:where(code){background:var(--cds-layer-01);padding:0 0.25rem;}
:where(pre){background:var(--cds-layer-01);padding:0.75rem 1rem;white-space:pre-wrap;}
:where(pre code){padding:0;background:none;}
:where(hr){border:0;border-top:1px solid var(--cds-border-subtle);}
:where(table){border-collapse:collapse;max-inline-size:100%;}
:where(th,td){border:1px solid var(--cds-border-subtle);padding:0.25rem 0.5rem;text-align:left;}
:where(th){background:var(--cds-layer-accent-01);}
:where(img,svg,canvas,video){max-width:100%;}
:where(.kubus-tag){padding:0.0625rem 0.5rem;-webkit-box-decoration-break:clone;box-decoration-break:clone;border-radius:1rem;background:var(--cds-tag-background-blue);color:var(--cds-tag-color-blue);font-size:0.75rem;line-height:1rem;letter-spacing:0.32px;cursor:pointer;}
:where(.kubus-tag:hover){background:var(--cds-tag-hover-blue);}`;
}

function frameDocument(html: string, fill: boolean, dark: boolean, tokens: string): string {
  // Hidden (laid out, not shown) until the page has handed over the app's fonts: no flash of
  // another font, and the height it reports is measured in the fonts it shows.
  return `<!doctype html><html class="${fill ? "in-card" : "in-page"} fonts-pending"><head><meta charset="utf-8"><style>
${frameBaseStyles(tokens, dark)}
</style></head><body>${html}<script>
(() => {
  const root = document.documentElement;
  // The app's fonts (frameFonts.ts): asked for from the page, which sends their bytes.
  let fontsReady = false;
  const fontsDone = () => {
    if (fontsReady) return;
    fontsReady = true;
    root.classList.remove("fonts-pending");
    watch();
  };
  addEventListener("message", async (e) => {
    if (e.source !== parent || !e.data || !Array.isArray(e.data.kubusFonts)) return;
    try {
      await Promise.all(e.data.kubusFonts.map((f) => {
        const face = new FontFace(f.family, f.data, { style: f.style, weight: f.weight });
        document.fonts.add(face);
        return face.load();
      }));
    } finally {
      fontsDone();
    }
  });
  // Shown anyway if the page doesn't answer (it always does unless its fonts failed to load).
  setTimeout(fontsDone, 2000);
  parent.postMessage({ kubusFrameReady: true }, "*");
  const wanted = () => {
    const m = document.querySelector('meta[name="frame"]')?.getAttribute("content") ?? "";
    const ratio = /ratio\\s*=\\s*([\\d.]+)\\s*(?:\\/\\s*([\\d.]+))?/.exec(m);
    const height = /height\\s*=\\s*([\\d.]+)/.exec(m);
    return { ratio: ratio ? Number(ratio[1]) / Number(ratio[2] ?? 1) : null, height: height ? Number(height[1]) : null };
  };
  let last = "";
  const report = () => {
    root.style.setProperty("--frame-width", innerWidth + "px");
    root.style.setProperty("--frame-height", innerHeight + "px");
    if (${fill}) return;
    // The content's own height: with html and body sized to their content, a box at 100% has none.
    root.classList.add("measuring");
    const natural = Math.ceil(document.body.getBoundingClientRect().height);
    root.classList.remove("measuring");
    // After "load" and the fonts the layout is final (styles, images, text); a size from before may be off.
    const size = { natural, ...wanted(), loaded: document.readyState === "complete" && fontsReady };
    const key = JSON.stringify(size);
    if (key !== last) {
      last = key;
      parent.postMessage({ kubusFrame: size }, "*");
    }
  };
  // Content can change size at any time (images, maps, charts loading): watch its elements.
  const sizes = new ResizeObserver(report);
  const watch = () => {
    sizes.disconnect();
    sizes.observe(root);
    for (const el of document.body.children) sizes.observe(el);
    report();
  };
  // At most once a frame: maps and charts change attributes continuously while panning.
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      watch();
    });
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, attributes: true });
  addEventListener("load", watch);
  addEventListener("resize", report);
  watch();
  // #tags in the text (domain/tags.ts) become tags, as everywhere in the app; a click on one is
  // the page's (it searches for the tag). Only the HTML as written: what a script draws is its own.
  const tagSplit = new RegExp("(" + ${JSON.stringify(TAG_SOURCE).replace(/</g, "\\u003c")} + ")", "u");
  const skip = "a,code,pre,kbd,samp,script,style,textarea,select,option,button,svg,canvas,template,[contenteditable],.kubus-tag";
  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) texts.push(walker.currentNode);
  for (const text of texts) {
    if (!text.data.includes("#") || text.parentElement?.closest(skip)) continue;
    const parts = text.data.split(tagSplit);
    if (parts.length === 1) continue;
    const pieces = parts.map((part, i) => {
      if (i % 2 === 0) return document.createTextNode(part);
      const tag = document.createElement("span");
      tag.className = "kubus-tag";
      tag.setAttribute("role", "link");
      tag.tabIndex = 0;
      tag.title = "Search for " + part;
      tag.textContent = part;
      return tag;
    });
    text.replaceWith(...pieces);
  }
  const openTag = (e, tag) => {
    e.preventDefault();
    e.stopPropagation();
    parent.postMessage({ kubusTag: tag.textContent, ctrlKey: e.ctrlKey, metaKey: e.metaKey, button: e.button ?? 0 }, "*");
  };
  addEventListener("click", (e) => {
    const tag = e.target instanceof Element && e.target.closest(".kubus-tag");
    if (tag && e.button === 0) openTag(e, tag);
  }, true);
  addEventListener("auxclick", (e) => {
    const tag = e.target instanceof Element && e.target.closest(".kubus-tag");
    if (tag && e.button === 1) openTag(e, tag);
  }, true);
  addEventListener("keydown", (e) => {
    const tag = e.key === "Enter" && e.target instanceof Element && e.target.closest(".kubus-tag");
    if (tag) openTag(e, tag);
  }, true);
  // A click on plain content (text, an empty area) is the page's: it starts editing the field.
  // Clicks on what is interactive stay here (links, controls, maps and charts drawn in a canvas
  // or svg, elements with handlers), as do clicks a script stopped or that end a selection.
  addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || String(getSelection() || "")) return;
    const interactive = "a,button,input,select,textarea,label,summary,details,option,video,audio,canvas,svg,iframe,embed,item,[onclick],[contenteditable],[tabindex],[role=button],[role=link],[role=checkbox],[role=tab],[role=slider]";
    if (e.target instanceof Element && e.target.closest(interactive)) return;
    parent.postMessage({ kubusFrameClick: true }, "*");
  });
})();
</script></body></html>`;
}

/** What a page frame's content reported: its own height, and the size it asks for (meta). */
interface FrameSize {
  /** Measured after the document loaded (earlier sizes can be off; only these are final). */
  loaded?: boolean;
  natural: number;
  ratio: number | null;
  height: number | null;
}

/** Below this the content has no height of its own: it fills its box (a map, a chart). */
const FILL_THRESHOLD = 4;

/**
 * The HTML with every stored image it refers to (`files/<sha256>`) embedded as a data URL;
 * undefined while those load.
 */
function useEmbeddedFiles(html: string): string | undefined {
  const { repo } = useStore();
  const ids = useMemo(() => fileIdsIn(html), [html]);
  const [embedded, setEmbedded] = useState<{ html: string; out: string }>();
  useEffect(() => {
    if (ids.length === 0) return;
    let cancelled = false;
    // An image that can't be read stays a plain `files/…` reference (not shown) rather than
    // keeping the whole frame from showing.
    const urlOf = (id: string) => fileDataUrl(repo, id).catch((e) => (console.error("Loading file failed", e), null));
    Promise.all(ids.map((id) => urlOf(id).then((url) => [id, url] as const))).then((urls) => {
      if (cancelled) return;
      let out = html;
      for (const [id, url] of urls) if (url) out = out.split(fileSrc(id)).join(url);
      setEmbedded({ html, out });
    });
    return () => {
      cancelled = true;
    };
  }, [repo, html, ids]);
  if (ids.length === 0) return html;
  return embedded?.html === html ? embedded.out : undefined;
}

/** The size a frame's content last measured, by its document: a frame shown again starts at it. */
const measuredFrames = new Map<string, FrameSize>();

/**
 * Frames still measuring their content, for a page that shows nothing that would move until
 * they are done (FramesSizing). A frame's height is only known once its content has rendered;
 * shown before, everything below it would jump when it takes that height.
 */
const FrameSizingContext = createContext<((id: string, sizing: boolean) => void) | null>(null);

/**
 * Wraps content holding HTML frames: hidden (keeping its place) while any of them is still
 * measuring, at most `maxMs`, so its frames take their height before anything is seen.
 */
export function FramesSizing({ children, maxMs = 1000, className }: { children: ReactNode; maxMs?: number; className?: string }) {
  const [sizing, setSizing] = useState<ReadonlySet<string>>(() => new Set());
  const [timedOut, setTimedOut] = useState(false);
  const report = useCallback((id: string, on: boolean) => {
    setSizing((s) => {
      if (s.has(id) === on) return s;
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const waiting = sizing.size > 0 && !timedOut;
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => setTimedOut(true), maxMs);
    return () => window.clearTimeout(timer);
  }, [waiting, maxMs]);
  return (
    <FrameSizingContext.Provider value={report}>
      <div className={className} style={waiting ? { opacity: 0 } : undefined}>
        {children}
      </div>
    </FrameSizingContext.Provider>
  );
}

/**
 * The page a component's HTML is shown in: a sandboxed frame (scripts run, but in an opaque
 * origin: no access to the app, its storage or the database). The app's font and text colour
 * are passed in.
 *
 * It looks like rendered Markdown by default (frameBaseStyles); the component's CSS overrides that.
 *
 * Its size, one component for every place: html and body are always 100% of the frame, so
 * content can fill it (`#map { height: 100% }`). On a card cover (`fill`) the frame is the
 * cover. On a page the frame measures the content's own height (body sized to its content):
 *  - flow: it has one (text, tables, a fixed-size chart), and the frame is exactly that tall, at
 *    most `maxHeight` (a component block's Height; it scrolls inside beyond that);
 *  - fill: it has none (a map or chart at 100%), and the frame is `maxHeight` tall (a field
 *    component, without one: BLOCK_HEIGHT's initial height, like a new block's).
 * `<meta name="frame" content="ratio=4/3">` or `content="height=300"` in the HTML gives it that
 * size (at most `maxHeight`). <html> has the
 * class in-card or in-page, and --frame-width / --frame-height, for content that adapts to where
 * it is shown.
 */
export function HtmlFrame({
  html: source,
  fill = false,
  maxHeight = null,
  onContentClick,
}: {
  html: string;
  fill?: boolean;
  /** The most it takes on a page, in rem (a component block's Height); null = no limit for content with a height of its own. */
  maxHeight?: number | null;
  /** A click on the frame's plain content (not a link, control, map, …): e.g. to start editing. */
  onContentClick?(): void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const html = useEmbeddedFiles(source);
  // Shown before: its content's size is known (until it measures itself again).
  const [size, setSize] = useState<FrameSize | undefined>(() => (fill ? undefined : measuredFrames.get(source)));
  // Settled: its reports have stopped changing. The first ones, while the frame lays itself out,
  // can be far off (0, or several times the real height).
  const [settled, setSettled] = useState(() => !fill && measuredFrames.has(source));
  const settleTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(settleTimer.current), []);
  // Focus inside the (sandboxed) frame, e.g. tabbing to one of its links: the frame matches no
  // :focus or :focus-within then, so it is marked for its focus ring (styles.css). The page sees
  // it only as its window losing focus with the frame as the active element.
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const update = () => el.toggleAttribute("data-focused", document.activeElement === el);
    const later = () => setTimeout(update);
    window.addEventListener("blur", later);
    window.addEventListener("focus", update);
    document.addEventListener("focusin", update);
    return () => {
      window.removeEventListener("blur", later);
      window.removeEventListener("focus", update);
      document.removeEventListener("focusin", update);
    };
  }, []);
  const contentClick = useRef(onContentClick);
  contentClick.current = onContentClick;
  // A tag clicked in the frame opens its search (see frameDocument).
  const latestOpenTag = useOpenTag();
  const openTag = useRef(latestOpenTag);
  openTag.current = latestOpenTag;
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const data = e.data as
        | { kubusFrame?: FrameSize; kubusFrameClick?: boolean; kubusFrameReady?: boolean; kubusTag?: string; ctrlKey?: boolean; metaKey?: boolean; button?: number }
        | null;
      // The frame asks for the app's fonts (it can't load them itself): their bytes, once per frame.
      if (data?.kubusFrameReady) {
        const target = e.source as Window;
        frameFonts().then((fonts) => target.postMessage({ kubusFonts: fonts }, "*"));
      }
      if (data?.kubusFrameClick) contentClick.current?.();
      if (typeof data?.kubusTag === "string") openTag.current?.(data.kubusTag, openModeOf({ ctrlKey: !!data.ctrlKey, metaKey: !!data.metaKey, button: data.button ?? 0 }));
      const s = data?.kubusFrame;
      if (!fill && s && typeof s.natural === "number") {
        setSize(s);
        window.clearTimeout(settleTimer.current);
        if (!s.loaded) return;
        // Final once no other size follows for a moment.
        settleTimer.current = window.setTimeout(() => {
          measuredFrames.set(source, s);
          setSettled(true);
        }, 150);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [fill, source]);
  // Tell a FramesSizing around it while its content's height isn't known yet.
  const reportSizing = useContext(FrameSizingContext);
  const id = useRef(Math.random().toString(36)).current;
  const measuring = !fill && !settled;
  useLayoutEffect(() => {
    if (!reportSizing) return;
    reportSizing(id, measuring);
    return () => reportSizing(id, false);
  }, [reportSizing, id, measuring]);
  // Rebuilt when the theme flips (light / dark): the frame's colours are the app's, passed in.
  const dark = useMediaQuery("(prefers-color-scheme: dark)");
  // The type tokens where the frame is (read once it is in place, before it is first drawn).
  const [tokens, setTokens] = useState<string>();
  useLayoutEffect(() => {
    const place = frame.current?.parentElement;
    if (place) setTokens(frameTokens(place));
  }, [dark]);
  const doc = useMemo(() => (html === undefined || tokens === undefined ? undefined : frameDocument(html, fill, dark, tokens)), [html, fill, dark, tokens]);
  const fills = !!size && size.natural < FILL_THRESHOLD;
  // A size asked for in the HTML wins; else its own height (flow), else the block's height (fill). Never more than the block's height.
  const max = `${maxHeight ?? BLOCK_HEIGHT.initial}rem`;
  const capped = (px: number) => (maxHeight === null ? `${px}px` : `min(${px}px, ${max})`);
  const style: CSSProperties | undefined =
    fill || !size
      ? undefined
      : size.height
        ? { blockSize: capped(size.height) }
        : size.ratio
          ? { aspectRatio: size.ratio, blockSize: "auto", ...(maxHeight !== null && { maxBlockSize: max }) }
          : !fills
            ? { blockSize: capped(size.natural) }
            : { blockSize: max };
  return (
    <iframe
      ref={frame}
      className={fill ? "html-frame html-frame--fill" : "html-frame"}
      sandbox="allow-scripts"
      srcDoc={doc}
      title="HTML"
      style={style}
    />
  );
}

/**
 * A component field's result, shown by its component's output type: rendered Markdown, text, a
 * number, an image or HTML. `cell` is the compact form for table cells and card lines (Markdown
 * as plain text, a thumbnail, HTML as a note); errors show as their message.
 */
export function ComponentValue({
  value,
  output,
  variant,
  search = "",
  maxHeight = null,
  onContentClick,
}: {
  value: FieldValue;
  output: ComponentOutput;
  variant: "page" | "cell";
  search?: string;
  /** HTML: the most it takes, in rem (a component block's Height; see HtmlFrame). */
  maxHeight?: number | null;
  /** HTML: a click on its plain content (see HtmlFrame). */
  onContentClick?(): void;
}) {
  if (value == null || value === "") return null;
  const text = String(value);
  // A failing component shows its warning; plain results (text, numbers) read exactly like a
  // string or number field's value, rendered ones (Markdown, images, HTML) as such.
  if (isComponentError(value)) return <Highlight text={text} query={search} />;
  switch (output) {
    case "image":
      return <UrlImage url={text} className={variant === "cell" ? "image-thumb" : "item-view__image"} compact={variant === "cell"} />;
    case "html":
      return variant === "cell" ? (
        <span className="icon-label component-html-note">
          <HtmlIcon />
          HTML
        </span>
      ) : (
        <HtmlFrame html={text} maxHeight={maxHeight} onContentClick={onContentClick} />
      );
    case "markdown":
      if (variant === "page" && typeof value === "string") return <MarkdownView source={text} />;
      break;
  }
  return <Highlight text={text} query={search} />;
}
