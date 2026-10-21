import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const host = process.env.TAURI_DEV_HOST;

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
  ],
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
