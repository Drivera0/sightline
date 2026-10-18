import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// vitest runs from web/
const config = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8"));
const fetchCaches = readFileSync(join(process.cwd(), "scripts/fetch-caches.sh"), "utf8");
const fetchModel = readFileSync(join(process.cwd(), "scripts/fetch-model.sh"), "utf8");

describe("vercel.json (the auto-deployed site)", () => {
  it("downloads the demo cache from its release before building, since cache/demo is git-ignored", () => {
    expect(fetchCaches).toContain(
      "https://github.com/Drivera0/sightline/releases/download/demo-cache/demo-cache.tar.gz",
    );
    expect(fetchCaches).toContain("tar -xz -C public/cache");
  });

  it("downloads the real-position cache beside the demo cache", () => {
    expect(fetchCaches).toContain(
      "https://github.com/Drivera0/sightline/releases/download/real-gps-cache/real-gps-cache.tar.gz",
    );
    expect(config.buildCommand).toContain("bash scripts/fetch-caches.sh");
  });

  it("builds the demo cache, not the sample, into dist", () => {
    expect(config.buildCommand).toContain("VITE_CACHE_DIR=demo pnpm build");
    expect(config.outputDirectory).toBe("dist");
    expect(config.buildCommand.length).toBeLessThanOrEqual(256); // Vercel's limit
  });

  it("fails the build if the download fails, rather than shipping an empty demo", () => {
    expect(fetchCaches).toMatch(/curl -fsSL/);
    expect(fetchCaches).toContain("set -euo pipefail");
  });

  it("fetches the in-browser detector into the site's own /models/ before building, without failing the build", () => {
    expect(config.buildCommand).toContain("bash scripts/fetch-model.sh");
    expect(fetchModel).toContain(
      "https://github.com/Drivera0/sightline/releases/download/model-onnx-v2/sightline-detector-v2.onnx",
    );
    expect(fetchModel).toContain('OUT="public/models/sightline-detector-v2.onnx"');
    expect(fetchModel).toMatch(/SHA256="[0-9a-f]{64}"/);
    expect(fetchModel).not.toContain("set -e");
  });
});
