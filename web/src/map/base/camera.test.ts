import { describe, expect, it } from "vitest";
import { insidePaddedViewport, surveyPadding } from "./camera";

describe("surveyPadding", () => {
  it("uses an even margin when no panels sit over the map", () => {
    expect(surveyPadding(390, 500, false)).toEqual({ top: 48, right: 48, bottom: 48, left: 48 });
  });

  it("clears the side panels and the replay bar on a wide map", () => {
    const p = surveyPadding(1400, 760, true);
    expect(p.left).toBeGreaterThan(300);
    expect(p.right).toBeGreaterThan(250);
    expect(p.bottom).toBeGreaterThan(p.top);
  });

  it("shrinks on a small map so a third of it stays for the survey", () => {
    const p = surveyPadding(900, 300, true);
    expect(900 - p.left - p.right).toBeGreaterThanOrEqual(300 - 1);
    expect(300 - p.top - p.bottom).toBeGreaterThanOrEqual(100 - 1);
  });
});

describe("insidePaddedViewport", () => {
  it("is true near the centre and false near an edge", () => {
    expect(insidePaddedViewport({ x: 500, y: 400 }, 1000, 800)).toBe(true);
    expect(insidePaddedViewport({ x: 100, y: 400 }, 1000, 800)).toBe(false);
    expect(insidePaddedViewport({ x: 500, y: 790 }, 1000, 800)).toBe(false);
  });
});
