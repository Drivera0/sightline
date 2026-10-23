import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, ratio, themes, TEXT_TOKENS } from "./contrast.mjs";

describe("the colour tokens", () => {
  it("computes WCAG contrast: black on white is 21:1", () => {
    expect(ratio(parse("#000000"), parse("#ffffff"))).toBeCloseTo(21, 5);
  });

  it("keeps every text token at 4.5:1 or more on its backgrounds, in both themes", () => {
    const all = themes(join(__dirname, "../src/shell/theme.css"));
    for (const [theme, rows] of Object.entries(all)) {
      expect(rows.length).toBeGreaterThan(TEXT_TOKENS.length * 3);
      const under = rows.filter((r) => r.ratio < 4.5).map((r) => `${theme}: ${r.text} on ${r.on} ${r.ratio.toFixed(2)}`);
      expect(under).toEqual([]);
    }
  });
});
