import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findExternalUrls, scanDirectory } from "./offline.mjs";

const ALLOWED = ["www.w3.org", "react.dev"];

describe("findExternalUrls", () => {
  it("finds a URL on a host that is not allowed", () => {
    const css = '@import url("https://fonts.googleapis.com/css2?family=Geist");';

    expect(findExternalUrls(css, ALLOWED)).toEqual(["https://fonts.googleapis.com/css2?family=Geist"]);
  });

  it("ignores allowed hosts such as the SVG namespace", () => {
    const js = 'const ns = "http://www.w3.org/2000/svg"; const e = "https://react.dev/errors/31";';

    expect(findExternalUrls(js, ALLOWED)).toEqual([]);
  });

  it("ignores localhost", () => {
    expect(findExternalUrls("fetch('http://localhost:8000/health'); http://127.0.0.1/x", ALLOWED)).toEqual([]);
  });

  it("lists each URL once, in sorted order", () => {
    const text = "https://b.example.com/x https://a.example.com/y https://b.example.com/x";

    expect(findExternalUrls(text, ALLOWED)).toEqual(["https://a.example.com/y", "https://b.example.com/x"]);
  });

  it("stops a URL at a quote, bracket or space", () => {
    expect(findExternalUrls('<script src="https://cdn.example.com/a.js"></script>', ALLOWED)).toEqual([
      "https://cdn.example.com/a.js",
    ]);
  });

  it("is empty for clean text", () => {
    expect(findExternalUrls("body { color: red } /assets/font.woff2", ALLOWED)).toEqual([]);
  });
});

describe("allowed exact URLs", () => {
  it("ignores a URL that is listed exactly, even on an otherwise unlisted host", () => {
    const text = '// see https://github.com/mapbox/mapbox-gl-js/issues/2907 and https://github.com/other/repo';

    expect(findExternalUrls(text, ALLOWED, ["https://github.com/mapbox/mapbox-gl-js/issues/2907"])).toEqual([
      "https://github.com/other/repo",
    ]);
  });

  it("treats an entry ending in * as a prefix, for URLs that contain a version number", () => {
    const text = "see https://github.com/maplibre/maplibre-gl-js/blob/v6.14.0/LICENSE.txt and https://github.com/evil/x";

    expect(findExternalUrls(text, ALLOWED, ["https://github.com/maplibre/maplibre-gl-js/*"])).toEqual([
      "https://github.com/evil/x",
    ]);
  });

  it("scanDirectory passes the exact URL list on", () => {
    const dir = mkdtempSync(join(tmpdir(), "offline-"));
    writeFileSync(join(dir, "a.js"), '"https://github.com/mapbox/mapbox-gl-js/issues/2907"');

    expect(scanDirectory(dir, ALLOWED, ["https://github.com/mapbox/mapbox-gl-js/issues/2907"])).toEqual({});
  });
});

describe("scanDirectory", () => {
  it("reports external URLs per file, looking into sub folders and skipping fonts and images", () => {
    const dir = mkdtempSync(join(tmpdir(), "offline-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), '<link href="https://fonts.googleapis.com/css">');
    writeFileSync(join(dir, "assets", "app.js"), 'fetch("https://tiles.example.com/{z}/{x}/{y}.pbf")');
    writeFileSync(join(dir, "assets", "clean.css"), "body{}");
    writeFileSync(join(dir, "assets", "font.woff2"), "https://not-text.example.com");

    const found = scanDirectory(dir, ALLOWED);

    expect(found).toEqual({
      "assets/app.js": ["https://tiles.example.com/{z}/{x}/{y}.pbf"],
      "index.html": ["https://fonts.googleapis.com/css"],
    });
  });

  it("ignores plain text files such as licences, which the page never fetches", () => {
    const dir = mkdtempSync(join(tmpdir(), "offline-"));
    mkdirSync(join(dir, "basemap"));
    writeFileSync(join(dir, "basemap", "OFL.txt"), "see https://scripts.sil.org/OFL and https://github.com/notofonts");
    writeFileSync(join(dir, "index.html"), '<script src="/assets/app.js"></script>');

    expect(scanDirectory(dir, ALLOWED)).toEqual({});
  });

  it("is empty when nothing external is referenced", () => {
    const dir = mkdtempSync(join(tmpdir(), "offline-"));
    writeFileSync(join(dir, "index.html"), '<script src="/assets/app.js"></script>');

    expect(scanDirectory(dir, ALLOWED)).toEqual({});
  });
});
