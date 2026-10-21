// Platform adapter: the core app never imports Tauri APIs directly.

const OPENABLE = /^(https?:|mailto:)/i;

/** Opens a link in the system browser (Tauri) or a new tab (web). Other schemes are ignored. */
export async function openExternal(url: string): Promise<void> {
  if (!OPENABLE.test(url)) return;
  if ("__TAURI_INTERNALS__" in window) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
