import { describe, expect, it } from "vitest";
import { insidePaddedViewport, overlayPadding, paddingOffset, surveyPadding } from "./camera";

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

describe("overlayPadding", () => {
  const container = { left: 100, top: 50, right: 1100, bottom: 750 };

  it("pads each side by the panel on it plus a gap, and the rest by a small margin", () => {
    const p = overlayPadding(container, [
      { side: "left", rect: { left: 112, top: 62, right: 432, bottom: 600 } },
      { side: "bottom", rect: { left: 500, top: 690, right: 900, bottom: 738 } },
    ]);
    expect(p.left).toBe(432 - 100 + 16);
    expect(p.bottom).toBe(750 - 690 + 16);
    expect(p.right).toBe(24);
    expect(p.top).toBe(24);
  });

  it("counts a corner panel against the side that leaves the larger square", () => {
    // A wide map: a tall corner card is cheaper on the right.
    const wide = overlayPadding(container, [{ side: "corner", rect: { left: 840, top: 300, right: 1088, bottom: 738 } }]);
    expect(wide.right).toBe(1100 - 840 + 16);
    expect(wide.bottom).toBe(24);
    // A narrow, tall map (Review): the same card is cheaper at the bottom.
    const narrow = { left: 0, top: 0, right: 500, bottom: 700 };
    const tall = overlayPadding(narrow, [{ side: "corner", rect: { left: 240, top: 420, right: 488, bottom: 688 } }]);
    expect(tall.bottom).toBe(700 - 420 + 16);
    expect(tall.right).toBe(24);
  });

  it("ignores hidden panels and panels outside the map", () => {
    const p = overlayPadding(container, [
      { side: "left", rect: { left: 0, top: 0, right: 0, bottom: 0 } },
      { side: "right", rect: { left: 1200, top: 60, right: 1300, bottom: 200 } },
    ]);
    expect(p).toEqual({ top: 24, right: 24, bottom: 24, left: 24 });
  });

  it("feeds surveyPadding, which still keeps a third of the map", () => {
    const p = surveyPadding(600, 400, true, { top: 24, right: 300, bottom: 24, left: 340 });
    expect(600 - p.left - p.right).toBeGreaterThanOrEqual(200 - 1);
  });
});

describe("paddingOffset", () => {
  it("shifts the centre into the middle of the free gap", () => {
    expect(paddingOffset({ top: 20, right: 300, bottom: 100, left: 20 })).toEqual([-140, -40]);
  });
});
