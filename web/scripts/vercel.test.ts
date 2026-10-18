import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// vitest runs from web/
const config = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8"));

describe("vercel.json (the auto-deployed site)", () => {
  it("downloads the demo cache from its release before building, since cache/demo is git-ignored", () => {
    expect(config.buildCommand).toContain(
      "https://github.com/Drivera0/sightline/releases/download/demo-cache/demo-cache.tar.gz",
    );
    expect(config.buildCommand).toContain("tar -xz -C public/cache");
  });

  it("builds the demo cache, not the sample, into dist", () => {
    expect(config.buildCommand).toContain("VITE_CACHE_DIR=demo pnpm build");
    expect(config.outputDirectory).toBe("dist");
    expect(config.buildCommand.length).toBeLessThanOrEqual(256); // Vercel's limit
  });

  it("fails the build if the download fails, rather than shipping an empty demo", () => {
    expect(config.buildCommand).toMatch(/curl -fsSL/);
    expect(config.buildCommand).toMatch(/set -o pipefail|bash -o pipefail/);
  });
});
