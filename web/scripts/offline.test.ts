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

  it("is empty when nothing external is referenced", () => {
    const dir = mkdtempSync(join(tmpdir(), "offline-"));
    writeFileSync(join(dir, "index.html"), '<script src="/assets/app.js"></script>');

    expect(scanDirectory(dir, ALLOWED)).toEqual({});
  });
});
