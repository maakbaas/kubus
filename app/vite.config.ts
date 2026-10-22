import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const host = process.env.TAURI_DEV_HOST;

// Touch screens emulate :hover and keep it after a tap, so hover styles stick. Every rule with a
// :hover selector (Carbon's included) moves into `@media (hover: hover)`, which only devices
// with a real hovering pointer match.
const hoverOnlyWhenHovering = {
  postcssPlugin: "hover-only-when-hovering",
  Rule(rule: any, { AtRule }: any) {
    if (rule.__hoverDone || !rule.selector?.includes(":hover")) return;
    for (let p = rule.parent; p; p = p.parent) {
      if (p.type === "atrule" && (/keyframes$/.test(p.name) || p.params?.includes("hover: hover"))) return;
    }
    const parts: string[] = rule.selectors;
    const hovering = parts.filter((x) => x.includes(":hover"));
    const rest = parts.filter((x) => !x.includes(":hover"));
    const media = new AtRule({ name: "media", params: "(hover: hover)" });
    const inner = rule.clone({ selectors: hovering });
    inner.__hoverDone = true;
    media.append(inner);
    rule.after(media);
    if (rest.length > 0) rule.selectors = rest;
    else rule.remove();
  },
};

// One build serves both the Tauri shell and the plain web / home-screen app.
// Tauri expects a fixed dev port and must not watch its own Rust sources.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    react(),
    {
      // The service worker (app/sw.js) is emitted by the build, not copied from public/, because a
      // new build must make browsers install a new worker: each build stamps its own version.
      name: "service-worker",
      apply: "build",
      generateBundle() {
        const source = readFileSync(fileURLToPath(new URL("sw.js", import.meta.url)), "utf8");
        this.emitFile({ type: "asset", fileName: "sw.js", source: source.replaceAll("__BUILD__", Date.now().toString(36)) });
      },
    },
    {
      // iOS keeps the icon it fetched when the app was added, and Safari caches the file by URL:
      // a content hash in the href makes (re)adding the app always fetch the current icon.
      name: "apple-touch-icon-version",
      transformIndexHtml(html) {
        const icon = readFileSync(fileURLToPath(new URL("public/apple-touch-icon.png", import.meta.url)));
        const hash = createHash("sha256").update(icon).digest("hex").slice(0, 8);
        return html.replace('href="/apple-touch-icon.png"', `href="/apple-touch-icon.png?v=${hash}"`);
      },
    },
  ],
  css: { postcss: { plugins: [hoverOnlyWhenHovering] } },
  clearScreen: false,
  // sqlite-wasm locates its .wasm via import.meta.url; pre-bundling breaks that.
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  worker: { format: "es" },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/desktop/**"] },
  },
});
