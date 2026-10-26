// Usage: node scripts/check-offline.mjs [build folder]   (default: dist)
// Fails when the build refers to a web address the browser would fetch. Namespace and error-message
// strings that are never fetched are allowed. The MapLibre entries are help and attribution text
// inside the library; the basemap itself comes from /basemap/*.pmtiles (lane B).
import { scanDirectory } from "./offline.mjs";

const ALLOWED_HOSTS = [
  "www.w3.org", "react.dev", "maplibre.org", "maplibre.invalid", "wiki.openstreetmap.org",
  // The demo Trace tab's recorded conditions lookup (src/command/__fixtures__/demo_trace_conditions.jsonl):
  // the pages Tavily found, shown as text in the trace's JSON, never fetched by the page.
  "weather.gc.ca", "www.weather.gc.ca", "bcparks.ca",
];
const ALLOWED_URLS = [
  "https://github.com/mapbox/mapbox-gl-js/issues/2907",
  "https://github.com/maplibre/maplibre-gl-js/*", // licence comment in the worker
  // Lane B's basemap (web/src/map/base/basemap.ts). The MapTiler style is only fetched when
  // VITE_MAPTILER_KEY is set AND the browser is online; otherwise the map reads the local
  // /basemap/northshore.pmtiles. The other three are an attribution text and a library comment.
  "https://api.maptiler.com/maps/satellite-v4/style.json",
  "https://github.com/protomaps/PMTiles/tree/main/js",
  "https://protomaps.com",
  "https://www.openstreetmap.org/copyright",
  // onnxruntime-web ("Try your own photo", src/detect/): a warning message about threads, and the
  // bundler's error text for a Node-only `require`. Neither is fetched; the runtime's .wasm and the
  // model are served from this site.
  "https://web.dev/cross-origin-isolation-guide/",
  "https://rolldown.rs/in-depth/bundling-cjs#require-external-modules",
  // The Results closing card's "Code on GitHub" link: opened only when a viewer clicks it, never
  // fetched by the page, so the demo still runs with Wi-Fi off.
  "https://github.com/Drivera0/sightline",
  // The XMP namespace a dropped drone photo's metadata is matched against (src/lib/exif.ts): an
  // identifier inside the file, never fetched.
  "http://ns.adobe.com/xap/1.0/",
  // The #judges page's links into the repo (report, architecture, what changed): opened on click only.
  "https://github.com/Drivera0/sightline/*",
  // The end screen's source for search time and survival (Adams et al. 2007, src/command/compare.ts): a link
  // opened only when a viewer clicks it, never fetched by the page.
  "https://pubmed.ncbi.nlm.nih.gov/17590071/",
  // About's "Who built it": the BCS Hackathon teammates' GitHub profiles (src/front/About.tsx BCS_TEAM),
  // opened on click only.
  "https://github.com/bamobam",
  "https://github.com/har-vir",
  "https://github.com/jkiim",
];
const dir = process.argv[2] ?? "dist";
const found = scanDirectory(dir, ALLOWED_HOSTS, ALLOWED_URLS);

if (Object.keys(found).length > 0) {
  console.error("The build refers to web addresses, so it may not work with Wi-Fi off:");
  for (const [file, urls] of Object.entries(found)) {
    for (const url of urls) console.error(`  ${file}: ${url}`);
  }
  process.exit(1);
}
console.log(`${dir}: no external web addresses`);
