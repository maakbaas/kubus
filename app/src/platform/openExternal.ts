// Platform adapter: the core app never imports Tauri APIs directly.
import { inDesktopShell, iosHomeScreenVersion } from "./shell";

/** A URL's scheme ("https", "spotify", …), lower case; null for a relative URL (`files/…`). */
const schemeOf = (url: string): string | null => /^([a-z][a-z0-9+.-]*):/i.exec(url.trim())?.[1].toLowerCase() ?? null;

/**
 * Schemes a link never opens: they run code or reach into the device or the app itself
 * (desktop/capabilities/default.json denies them to the opener too).
 */
const BLOCKED = new Set(["javascript", "vbscript", "data", "file", "blob", "about", "filesystem"]);

/**
 * Whether a link may be opened: any URL with a scheme (https, mailto, tel, spotify, obsidian, …:
 * other apps' links open those apps) but the blocked ones.
 */
export const isOpenableUrl = (url: string): boolean => {
  const scheme = schemeOf(url);
  return scheme !== null && !BLOCKED.has(scheme);
};

/**
 * What Markdown may link or point to (react-markdown's `urlTransform`): openable URLs and relative
 * ones (stored images, `files/<sha256>`); anything else becomes an empty link.
 */
export const safeUrl = (url: string): string => (schemeOf(url) === null || isOpenableUrl(url) ? url : "");

/** The browsers the iOS home-screen app can hand a web page to (Settings → Display, on that device). */
export const WEB_BROWSERS = [
  { value: "safari", text: "Safari" },
  { value: "chrome", text: "Chrome" },
  { value: "firefox", text: "Firefox" },
  { value: "edge", text: "Edge" },
  { value: "brave", text: "Brave" },
] as const;
export type WebBrowser = (typeof WEB_BROWSERS)[number]["value"];

/** Where the browser chosen on this device is kept (not synced: each device has its own browsers). */
const BROWSER_KEY = "kubus.browser";

/** The browser chosen on this device for web links; Safari until one is chosen. */
export function chosenBrowser(): WebBrowser {
  try {
    const v = localStorage.getItem(BROWSER_KEY);
    return WEB_BROWSERS.some((b) => b.value === v) ? (v as WebBrowser) : "safari";
  } catch {
    return "safari";
  }
}

export function chooseBrowser(browser: WebBrowser): void {
  try {
    localStorage.setItem(BROWSER_KEY, browser);
  } catch {
    // Storage blocked: links keep opening in Safari.
  }
}

/**
 * A web page's address that makes iOS open it in that browser. A home-screen app opens a web page
 * (window.open, a link to another site) in an in-app browser over the app; a web app can neither
 * open "the default browser" (iOS has no such link) nor find out which it is. A link with a
 * browser's own scheme is handed to that browser like any other app's link: Safari's
 * `x-safari-https://…` (iOS 17 on; `com-apple-mobilesafari-tab:<url>` before), Chrome's
 * `googlechromes://…`, Edge's `microsoft-edge-https://…`, Firefox's and Brave's `…://open-url?url=`.
 */
export function browserUrl(url: string, browser: WebBrowser, iosVersion: number): string {
  const trimmed = url.trim();
  const secure = /^https:/i.test(trimmed);
  const rest = trimmed.replace(/^https?:/i, "");
  switch (browser) {
    case "chrome":
      return `${secure ? "googlechromes" : "googlechrome"}:${rest}`;
    case "firefox":
      return `firefox://open-url?url=${encodeURIComponent(trimmed)}`;
    case "edge":
      return `microsoft-edge-${trimmed}`;
    case "brave":
      return `brave://open-url?url=${encodeURIComponent(trimmed)}`;
    case "safari":
      return iosVersion >= 17 ? `x-safari-${trimmed}` : `com-apple-mobilesafari-tab:${trimmed}`;
  }
}

/**
 * Opens a link outside the app: in the system browser (Tauri), in the browser chosen on the device
 * (the iOS home-screen app, never its in-app browser: `browserUrl`) or a new tab (web) for web pages,
 * in the app registered for its scheme for other links (mailto:, spotify:, …). Blocked schemes
 * and relative URLs are ignored.
 */
export async function openExternal(url: string): Promise<void> {
  if (!isOpenableUrl(url)) return;
  if (inDesktopShell()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else if (/^https?:/i.test(url.trim())) {
    const ios = iosHomeScreenVersion();
    if (ios !== null) window.location.href = browserUrl(url, chosenBrowser(), ios);
    else window.open(url, "_blank", "noopener,noreferrer");
  } else {
    // Another app's link: the browser hands it to that app and the page stays (a new tab would
    // be left behind empty).
    window.location.href = url;
  }
}

/**
 * The iOS home-screen app: a click on any link to a web page that nothing else handled (a link in an
 * HTML field, drawn inline: InlineHtml) goes through `openExternal` too, to the chosen browser, instead of
 * opening in iOS's in-app browser. The app's own links (`#/…`) and other apps' links are left alone.
 * Listens after React's handlers (on the document, bubbling): a link they open themselves has its
 * default prevented, so it isn't opened twice.
 */
export function openWebLinksOutside(): void {
  if (iosHomeScreenVersion() === null) return;
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
    const href = link?.getAttribute("href") ?? "";
    if (!/^https?:/i.test(href.trim())) return;
    e.preventDefault();
    void openExternal(href);
  });
}
