// Renders the iOS home-screen icon (desktop/icons/home-screen.svg) to every PNG it is used as: the web app's
// apple-touch-icon and icon-1024 (app/public), and the Tauri iOS app icons (desktop/icons/ios, each at its own size).
// Drawn once at 1024px by the pre-installed Chromium (Playwright), scaled down with Pillow and saved without an
// alpha channel (iOS fills a transparent pixel with black). Run: node scripts/render-ios-icons.mjs
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = createRequire(import.meta.url)("playwright");

const root = new URL("..", import.meta.url).pathname;
const svg = readFileSync(join(root, "desktop/icons/home-screen.svg"), "utf8");
const big = join(mkdtempSync(join(tmpdir(), "kubus-icon-")), "icon.png");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(`<style>html,body{margin:0}svg{display:block;width:1024px;height:1024px}</style>${svg}`);
await page.screenshot({ path: big });
await browser.close();

const targets = [join(root, "app/public/apple-touch-icon.png"), join(root, "app/public/icon-1024.png")];
for (const f of readdirSync(join(root, "desktop/icons/ios"))) if (f.endsWith(".png")) targets.push(join(root, "desktop/icons/ios", f));
// Each at the size it already has.
const resize = `
import sys, struct
from PIL import Image
src = Image.open(sys.argv[1]).convert("RGB")
for path in sys.argv[2:]:
    with open(path, "rb") as f:
        w, h = struct.unpack(">II", f.read(24)[16:24])
    src.resize((w, h), Image.LANCZOS).save(path, optimize=True)
    print(w, path)
`;
writeFileSync(big + ".py", resize);
process.stdout.write(execFileSync("python3", ["-I", big + ".py", big, ...targets], { encoding: "utf8" }));
