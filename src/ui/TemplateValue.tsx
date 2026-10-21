import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Html as HtmlIcon } from "@carbon/icons-react";
import type { FieldValue } from "../domain/model";
import { useStore } from "../app/store";
import { fileSrc, fileIdsIn } from "../domain/files";
import { isTemplateError, ratioValue, type TemplateOutput } from "../domain/templates";
import { Highlight } from "./Highlight";
import { useMediaQuery } from "./useMediaQuery";
import { fileDataUrl, UrlImage } from "./images";
import { MarkdownView } from "./MarkdownView";

/** App tokens a frame's base styles use: passed in as resolved values (the frame has no Carbon CSS). */
const FRAME_TOKENS = [
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
 * (:where), so any CSS in the template overrides them. Spacing goes only between text blocks:
 * the divs a map or chart library creates (often absolutely placed) are left alone.
 */
function frameBaseStyles(): string {
  const app = getComputedStyle(document.querySelector(".app-root") ?? document.body);
  const tokens = FRAME_TOKENS.map((t) => `${t}:${app.getPropertyValue(t).trim()};`).join("");
  return `:root{${tokens}}
:where(html,body){margin:0;height:100%;}
html{overflow:hidden;}
html.measuring,html.measuring body{height:auto;}
:where(body){font-family:var(--font-sans);font-size:0.875rem;line-height:1.42857;letter-spacing:0.16px;color:var(--cds-text-primary);overflow-wrap:anywhere;font-variant-ligatures:none;}
:where(p,h1,h2,h3,h4,h5,h6,ul,ol,dl,blockquote,pre,table,figure,hr){margin:0;}
:where(:not(style,script,meta,link,title,template)) + :where(p,h1,h2,h3,h4,h5,h6,ul,ol,dl,blockquote,pre,table,figure,hr){margin-top:0.75rem;}
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

function frameDocument(html: string, fill: boolean): string {
  return `<!doctype html><html class="${fill ? "in-card" : "in-page"}"><head><meta charset="utf-8"><style>
${frameBaseStyles()}
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
    const size = { natural, ...wanted() };
    const key = JSON.stringify(size);
    if (key !== last) {
      last = key;
      parent.postMessage({ pkmsFrame: size }, "*");
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
})();
</script></body></html>`;
}

/** What a page frame's content reported: its own height, and the size it asks for (meta). */
interface FrameSize {
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

/**
 * The page a template's HTML is shown in: a sandboxed frame (scripts run, but in an opaque
 * origin: no access to the app, its storage or the database). The app's font and text colour
 * are passed in.
 *
 * It looks like rendered Markdown by default (frameBaseStyles); the template's CSS overrides that.
 *
 * Its size, one template for every place: html and body are always 100% of the frame, so
 * content can fill it (`#map { height: 100% }`). On a card cover (`fill`) the frame is the
 * cover. On a page the frame measures the content's own height (body sized to its content):
 *  - flow: it has one (text, tables, a fixed-size chart), and the frame is exactly that tall;
 *  - fill: it has none (a map or chart at 100%), and the frame gets a box of a fixed shape
 *    (16:9 by default).
 * The template's own ratio setting (`ratio`) replaces that default; `<meta name="frame"
 * content="ratio=4/3">` or `content="height=300"` in the HTML wins over both. <html> has the
 * class in-card or in-page, and --frame-width / --frame-height, for content that adapts to where
 * it is shown.
 */
export function HtmlFrame({
  html: source,
  fill = false,
  ratio = null,
  onFill,
}: {
  html: string;
  fill?: boolean;
  /** The box's shape when the content fills it (the template's setting); null = 16:9. */
  ratio?: number | null;
  /** Told whether the content turned out to fill its box (it has no height of its own). */
  onFill?(fills: boolean): void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [size, setSize] = useState<FrameSize>();
  const html = useEmbeddedFiles(source);
  useEffect(() => {
    if (fill) return;
    const onMessage = (e: MessageEvent) => {
      const s = (e.data as { pkmsFrame?: FrameSize } | null)?.pkmsFrame;
      if (e.source === frame.current?.contentWindow && s && typeof s.natural === "number") setSize(s);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [fill]);
  // Rebuilt when the theme flips (light / dark): the frame's colours are the app's, passed in.
  const dark = useMediaQuery("(prefers-color-scheme: dark)");
  const doc = useMemo(() => (html === undefined ? undefined : frameDocument(html, fill)), [html, fill, dark]);
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
 * A template field's result, shown by its template's output type: rendered Markdown, text, a
 * number, an image or HTML. `cell` is the compact form for table cells and card lines (Markdown
 * as plain text, a thumbnail, HTML as a note); errors show as their message.
 */
export function TemplateValue({
  value,
  output,
  variant,
  search = "",
  frameRatio = null,
  onFill,
}: {
  value: FieldValue;
  output: TemplateOutput;
  variant: "page" | "cell";
  search?: string;
  /** HTML that fills its box: the box's shape (the template's setting). */
  frameRatio?: string | null;
  /** HTML: told whether it fills its box (the template editor then offers the ratio). */
  onFill?(fills: boolean): void;
}) {
  if (value == null || value === "") return null;
  const text = String(value);
  // A failing template shows its warning; plain results (text, numbers) read in the code font
  // on pages, rendered ones (Markdown, images, HTML) as such.
  if (isTemplateError(value)) return <Highlight text={text} query={search} />;
  switch (output) {
    case "image":
      return <UrlImage url={text} className={variant === "cell" ? "image-thumb" : "object-view__image"} compact={variant === "cell"} />;
    case "html":
      return variant === "cell" ? (
        <span className="icon-label template-html-note">
          <HtmlIcon />
          HTML
        </span>
      ) : (
        <HtmlFrame html={text} ratio={ratioValue(frameRatio)} onFill={onFill} />
      );
    case "markdown":
      if (variant === "page" && typeof value === "string") return <MarkdownView source={text} />;
      break;
  }
  return variant === "cell" ? (
    <Highlight text={text} query={search} />
  ) : (
    <span className="template-text">
      <Highlight text={text} query={search} />
    </span>
  );
}
