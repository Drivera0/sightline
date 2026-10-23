// Usage: node scripts/map-stills.mjs [--url http://localhost:5173] [--theme dark|light]   (from web/)
//
// Renders the phone and wide still images of the demo map (web/public/map/demo-t0-390.webp and
// demo-t0-1440.webp, MapStill.tsx) from the current fixture: the console at t0 (the call), the legend closed,
// screenshotted with Playwright's Chromium and encoded as WebP by the same browser. Never hand-made: run this
// again whenever the demo fixture, the map's look or the console's layout changes (src/map/README.md).
//
// Without --url it starts its own Vite dev server on a free port and stops it after. It needs the demo
// cache in public/cache/demo (scripts/fetch-caches.sh) and Playwright's Chromium (`pnpm exec playwright
// install chromium` once).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const THEME = arg("theme", "dark");

/** The two stills: the phone one at 2× for a 390 px screen, the wide one for 1024 px and up. */
const STILLS = [
  { file: "public/map/demo-t0-390.webp", width: 390, height: 844, scale: 2 },
  { file: "public/map/demo-t0-1440.webp", width: 1440, height: 900, scale: 1 },
];

async function serve() {
  const given = arg("url", null);
  if (given) return { url: given.replace(/\/$/, ""), close: async () => {} };
  const { createServer } = await import("vite");
  const server = await createServer({ root: WEB, logLevel: "error", server: { port: 0, strictPort: false } });
  await server.listen();
  const url = server.resolvedUrls?.local[0]?.replace(/\/$/, "");
  if (!url) throw new Error("the dev server has no local address");
  return { url, close: () => server.close() };
}

async function still(browser, base, s) {
  const page = await browser.newPage({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: s.scale, colorScheme: THEME });
  // a fresh browser: the legend closed, the theme asked for, no remembered drone feed or voices
  await page.addInitScript((theme) => {
    localStorage.setItem("sightline.mapLegend", "closed");
    localStorage.setItem("sightline.theme", theme);
  }, THEME);
  await page.goto(`${base}/#m/demo/map?t=0`);
  const box = page.locator("#console-map > div").last();
  await box.waitFor();
  // a phone shows a still first: tap it for the live map
  const tap = page.getByRole("button", { name: /Tap to load the map/ });
  if (await tap.isVisible({ timeout: 8000 }).catch(() => false)) await tap.click();
  await page.locator("#console-map canvas.maplibregl-canvas").waitFor({ timeout: 30000 });
  await page.getByTestId("map-still").waitFor({ state: "detached", timeout: 30000 }).catch(() => undefined);
  const legend = page.getByRole("button", { name: /^Legend/ });
  if ((await legend.getAttribute("aria-expanded").catch(() => null)) === "true") await legend.click();
  // the closed legend's pill is left out of the picture: the still's own label ("Still image · at the call")
  // sits where it is, and a pill in a picture cannot be opened
  await page.evaluate(() => {
    const pill = document.querySelector('#console-map button[aria-keyshortcuts="L"]')?.closest("figcaption");
    if (pill) pill.style.visibility = "hidden";
  });
  await box.scrollIntoViewIfNeeded();
  // the map settles: tiles, labels, the heat's first frame
  await page.waitForTimeout(4000);
  const png = await box.screenshot({ animations: "disabled" });
  // WebP from the same browser's encoder (no image library needed)
  const webp = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    return c.toDataURL("image/webp", 0.8).split(",")[1];
  }, png.toString("base64"));
  const out = Buffer.from(webp, "base64");
  writeFileSync(new URL(`../${s.file}`, import.meta.url), out);
  const size = await box.boundingBox();
  console.log(`${s.file}: ${Math.round(size.width * s.scale)}×${Math.round(size.height * s.scale)}, ${Math.round(out.length / 1024)} KB`);
  await page.close();
}

const { url, close } = await serve();
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
try {
  for (const s of STILLS) await still(browser, url, s);
} finally {
  await browser.close();
  await close();
}
