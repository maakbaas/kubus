// Platform adapter: the core app never imports Tauri APIs directly.
import { inDesktopShell, inIosHomeScreenApp } from "./shell";

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

/**
 * Opens a link outside the app: in the system browser (Tauri) or a new tab (web) for web pages,
 * in the app registered for its scheme for other links (mailto:, spotify:, …). Blocked schemes
 * and relative URLs are ignored. In the iOS home-screen app a web page isn't opened at all: iOS
 * would show it in its in-app browser over the app (a home-screen app can't reach the default
 * browser); there the link's text is selected and opened from iOS's menu, in the browser.
 */
export async function openExternal(url: string): Promise<void> {
  if (!isOpenableUrl(url)) return;
  if (inDesktopShell()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else if (/^https?:/i.test(url.trim())) {
    if (!inIosHomeScreenApp()) window.open(url, "_blank", "noopener,noreferrer");
  } else {
    // Another app's link: the browser hands it to that app and the page stays (a new tab would
    // be left behind empty).
    window.location.href = url;
  }
}

/**
 * The iOS home-screen app: a tap on any link to a web page opens nothing (a link in an HTML field,
 * drawn inline, included; the app's own links do the same through `openExternal`), instead of iOS's
 * in-app browser. Links still look like links; their text is selected and opened from iOS's menu.
 * The app's own links (`#/…`) and other apps' links (mailto:, …) are left alone.
 */
export function keepWebLinksInHomeScreenApp(): void {
  if (!inIosHomeScreenApp()) return;
  document.addEventListener("click", (e) => {
    const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (/^https?:/i.test((link?.getAttribute("href") ?? "").trim())) e.preventDefault();
  });
}
