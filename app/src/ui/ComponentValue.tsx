import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Html as HtmlIcon } from "@carbon/icons-react";
import type { FieldValue } from "../domain/model";
import { useStore } from "../app/store";
import { fileSrc, fileIdsIn } from "../domain/files";
import { isComponentError, ratioValue, type ComponentOutput } from "../domain/components";
import { Highlight } from "./Highlight";
import { useMediaQuery } from "./useMediaQuery";
import { fileDataUrl, UrlImage } from "./images";
import { MarkdownView } from "./MarkdownView";

/** App tokens a frame's base styles use: passed in as resolved values (the frame has no Carbon CSS). */
const FRAME_TOKENS = [
  "--cds-background",
  "--cds-text-primary",
  "--cds-text-secondary",
  "--cds-link-primary",
  "--cds-border-subtle",
  "--cds-border-strong",
  "--cds-layer-accent-01",
  "--cds-code-02-font-family",
  "--font-sans",
];

/**
 * The frame's base styles: Carbon's look, the same as rendered Markdown (body-01 text, heading
 * sizes, block spacing, links, lists, code, quotes, tables, rules). All at zero specificity
 * (:where), so any CSS in the component overrides them. Spacing goes only between text blocks:
 * the divs a map or chart library creates (often absolutely placed) are left alone.
 */
function frameBaseStyles(dark: boolean): string {
  const app = getComputedStyle(document.querySelector(".app-root") ?? document.body);
  const tokens = FRAME_TOKENS.map((t) => `${t}:${app.getPropertyValue(t).trim()};`).join("");
  return `:root{${tokens}color-scheme:${dark ? "dark" : "light"};}
:where(html,body){margin:0;height:100%;}
html{overflow:hidden;}
html.measuring,html.measuring body{height:auto;}
:where(body){font-family:var(--font-sans);font-size:0.875rem;line-height:1.42857;letter-spacing:0.16px;color:var(--cds-text-primary);overflow-wrap:anywhere;font-variant-ligatures:none;}
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
:where(code,pre,kbd,samp){font-family:var(--cds-code-02-font-family);font-size:0.875rem;line-height:1.42857;letter-spacing:0.32px;}
:where(code){background:var(--cds-layer-accent-01);padding:0 0.25rem;}
:where(pre){background:var(--cds-layer-accent-01);padding:0.75rem 1rem;white-space:pre-wrap;}
:where(pre code){padding:0;background:none;}
:where(hr){border:0;border-top:1px solid var(--cds-border-subtle);}
:where(table){border-collapse:collapse;max-inline-size:100%;}
:where(th,td){border:1px solid var(--cds-border-subtle);padding:0.25rem 0.5rem;text-align:left;}
:where(th){background:var(--cds-layer-accent-01);}
:where(img,svg,canvas,video){max-width:100%;}`;
}

function frameDocument(html: string, fill: boolean, dark: boolean): string {
  return `<!doctype html><html class="${fill ? "in-card" : "in-page"}"><head><meta charset="utf-8"><style>
${frameBaseStyles(dark)}
</style></head><body>${html}<script>
(() => {
  const root = document.documentElement;
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
    // After "load" the layout is final (styles, images); a size from while parsing may be off.
    const size = { natural, ...wanted(), loaded: document.readyState === "complete" };
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
 *  - flow: it has one (text, tables, a fixed-size chart), and the frame is exactly that tall;
 *  - fill: it has none (a map or chart at 100%), and the frame gets a box of a fixed shape
 *    (16:9 by default).
 * The component's own ratio setting (`ratio`) replaces that default; `<meta name="frame"
 * content="ratio=4/3">` or `content="height=300"` in the HTML wins over both. <html> has the
 * class in-card or in-page, and --frame-width / --frame-height, for content that adapts to where
 * it is shown.
 */
export function HtmlFrame({
  html: source,
  fill = false,
  ratio = null,
  onFill,
  onContentClick,
}: {
  html: string;
  fill?: boolean;
  /** The box's shape when the content fills it (the component's setting); null = 16:9. */
  ratio?: number | null;
  /** Told whether the content turned out to fill its box (it has no height of its own). */
  onFill?(fills: boolean): void;
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
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const data = e.data as { kubusFrame?: FrameSize; kubusFrameClick?: boolean } | null;
      if (data?.kubusFrameClick) contentClick.current?.();
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
  const doc = useMemo(() => (html === undefined ? undefined : frameDocument(html, fill, dark)), [html, fill, dark]);
  const fills = !!size && !size.height && !size.ratio && size.natural < FILL_THRESHOLD;
  useEffect(() => {
    if (size) onFill?.(fills);
  }, [size, fills, onFill]);
  // A size asked for wins; else its own height (flow), else the default box (fill).
  const style: CSSProperties | undefined =
    fill || !size
      ? undefined
      : size.height
        ? { blockSize: size.height }
        : size.ratio
          ? { aspectRatio: size.ratio, blockSize: "auto" }
          : !fills
            ? { blockSize: size.natural }
            : { aspectRatio: ratio ?? 16 / 9, blockSize: "auto" };
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
  frameRatio = null,
  onFill,
  onContentClick,
}: {
  value: FieldValue;
  output: ComponentOutput;
  variant: "page" | "cell";
  search?: string;
  /** HTML that fills its box: the box's shape (the component's setting). */
  frameRatio?: string | null;
  /** HTML: told whether it fills its box (the component editor then offers the ratio). */
  onFill?(fills: boolean): void;
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
        <HtmlFrame html={text} ratio={ratioValue(frameRatio)} onFill={onFill} onContentClick={onContentClick} />
      );
    case "markdown":
      if (variant === "page" && typeof value === "string") return <MarkdownView source={text} />;
      break;
  }
  return <Highlight text={text} query={search} />;
}
