import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// The headless device (src/headless) for Node: one ES module, server/headless/index.js, which the
// server loads. Everything is bundled (the app's code imports without extensions and uses ?raw)
// except sqlite-wasm, which finds its .wasm file next to itself and is the server's dependency.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: false,
  build: {
    ssr: "src/headless/index.ts",
    outDir: "../server/headless",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    rollupOptions: { output: { entryFileNames: "index.js" } },
  },
  ssr: { noExternal: true, external: ["@sqlite.org/sqlite-wasm"] },
});
