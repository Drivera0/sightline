import { describe, expect, it } from "vitest";
import { boxVisible, labelBox, placeLabel, type LabelCandidate } from "./labelPlacement";

const view = { left: 0, top: 0, right: 1000, bottom: 600 };

describe("labelBox", () => {
  it("grows from the anchor point in the anchor's direction, shifted by the offset in ems", () => {
    const right = labelBox({ x: 100, y: 50 }, "right", [-1, 0], "AB", 10);
    expect(right.right).toBeCloseTo(90);
    expect(right.left).toBeLessThan(right.right);
    expect((right.top + right.bottom) / 2).toBeCloseTo(50);
    const topLeft = labelBox({ x: 100, y: 50 }, "top-left", [0, 0], "AB\nSECOND LINE", 10);
    expect(topLeft.left).toBe(100);
    expect(topLeft.top).toBe(50);
    // Two lines: twice the line height; the longer line sets the width.
    expect(topLeft.bottom - topLeft.top).toBeCloseTo(24);
    expect(topLeft.right - topLeft.left).toBeGreaterThan(labelBox({ x: 0, y: 0 }, "left", [0, 0], "AB", 10).right);
  });
});

describe("boxVisible", () => {
  it("rejects a box that runs off the map or under a panel", () => {
    const box = { left: 10, top: 10, right: 60, bottom: 24 };
    expect(boxVisible(box, view, [])).toBe(true);
    expect(boxVisible({ ...box, left: -20 }, view, [])).toBe(false);
    expect(boxVisible({ ...box, right: 999 }, view, [])).toBe(false);
    expect(boxVisible(box, view, [{ left: 0, top: 0, right: 30, bottom: 600 }])).toBe(false);
  });
});

describe("placeLabel", () => {
  const project = ([lon, lat]: [number, number]) => ({ x: lon, y: lat });
  const outside: LabelCandidate = { at: [340, 300], anchor: "right", offset: [-0.7, 0] };
  const inside: LabelCandidate = { at: [340, 300], anchor: "left", offset: [0.7, 0] };

  it("keeps the first candidate when it is clear", () => {
    expect(placeLabel([outside, inside], "SECTOR 1", project, view, [])).toBe(outside);
  });

  it("falls back when a panel covers the first, and hides the label when nothing fits", () => {
    const panel = { left: 0, top: 0, right: 330, bottom: 600 };
    expect(placeLabel([outside, inside], "SECTOR 1", project, view, [panel])).toBe(inside);
    const wide = { left: 0, top: 0, right: 700, bottom: 600 };
    expect(placeLabel([outside, inside], "SECTOR 1", project, view, [wide])).toBeNull();
  });

  it("hides a label clipped by the map's edge (the stray 'CT' at the left edge)", () => {
    const atEdge: LabelCandidate = { at: [20, 100], anchor: "right", offset: [-0.7, 0] };
    expect(placeLabel([atEdge], "SECTOR N", project, view, [])).toBeNull();
  });
});
