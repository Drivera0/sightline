import { describe, expect, it } from "vitest";
import type { Detection } from "../contract";
import { cellOfBoxCentre, gridSize, inputGeometry, scoreHistogram, surveyScores, topDetection } from "./detectorViz";

describe("scoreHistogram", () => {
  it("makes 19 bins of 0.05 from 0.05 to 1.0", () => {
    const h = scoreHistogram([], 0.29);
    expect(h.bins).toHaveLength(19);
    expect(h.bins[0]).toMatchObject({ lo: 0.05, hi: 0.1 });
    expect(h.bins[18]).toMatchObject({ lo: 0.95, hi: 1 });
    expect(h.total).toBe(0);
    expect(h.max).toBe(1);
  });

  it("puts edge values in the bin they start, and 1.0 in the last bin", () => {
    const h = scoreHistogram([0.05, 0.1, 0.0999, 0.15, 1.0, 0.97], 0.29);
    const n = h.bins.map((b) => b.below + b.above);
    expect(n[0]).toBe(2); // 0.05, 0.0999
    expect(n[1]).toBe(1); // 0.1
    expect(n[2]).toBe(1); // 0.15
    expect(n[18]).toBe(2); // 0.97, 1.0
    expect(h.total).toBe(6);
    expect(h.max).toBe(2);
  });

  it("splits a bin the threshold cuts through box by box", () => {
    const h = scoreHistogram([0.26, 0.28, 0.29, 0.295], 0.29);
    expect(h.bins[4]).toMatchObject({ lo: 0.25, hi: 0.3, below: 2, above: 2 });
  });

  it("clamps out-of-range scores into the end bins", () => {
    const h = scoreHistogram([0.01, 1.2], 0.29);
    expect(h.bins[0]?.below).toBe(1);
    expect(h.bins[18]?.above).toBe(1);
  });
});

describe("prediction grids", () => {
  it("letterboxes a 1000×750 frame to 1024×768 with no padding", () => {
    const g = inputGeometry(1000, 750, 1024);
    expect(g).toEqual({ scale: 1.024, inputW: 1024, inputH: 768, padLeft: 0, padTop: 0 });
    expect(gridSize(g, 8)).toEqual({ cols: 128, rows: 96 });
    expect(gridSize(g, 16)).toEqual({ cols: 64, rows: 48 });
    expect(gridSize(g, 32)).toEqual({ cols: 32, rows: 24 });
  });

  it("pads the short side up to a multiple of 32, split evenly, as Ultralytics does", () => {
    const g = inputGeometry(1000, 700, 1024);
    expect(g.inputW).toBe(1024);
    expect(g.inputH).toBe(736); // 717 + 19
    expect(g.padTop).toBe(9);
    expect(gridSize(g, 32)).toEqual({ cols: 32, rows: 23 });
  });

  it("finds the cell containing the box centre at each stride", () => {
    const g = inputGeometry(1000, 750, 1024);
    const box: [number, number, number, number] = [512, 300, 560, 362]; // centre (536, 331) → (548.9, 338.9) input px
    expect(cellOfBoxCentre(box, g, 8)).toEqual({ col: 68, row: 42 });
    expect(cellOfBoxCentre(box, g, 16)).toEqual({ col: 34, row: 21 });
    expect(cellOfBoxCentre(box, g, 32)).toEqual({ col: 17, row: 10 });
  });

  it("keeps corner boxes inside the grid and returns null without a box", () => {
    const g = inputGeometry(1000, 750, 1024);
    expect(cellOfBoxCentre([0, 0, 2, 2], g, 32)).toEqual({ col: 0, row: 0 });
    expect(cellOfBoxCentre([998, 748, 1000, 750], g, 8)).toEqual({ col: 127, row: 95 });
    expect(cellOfBoxCentre(undefined, g, 8)).toBeNull();
  });
});

const det = (id: string, conf: number): Detection => ({
  id,
  box_px: [0, 0, 10, 10],
  conf,
  crop: null,
  lat: 0,
  lon: 0,
  radius_m: 10,
});

describe("scores", () => {
  it("picks the most confident box", () => {
    expect(topDetection([det("a", 0.2), det("b", 0.7), det("c", 0.5)])?.id).toBe("b");
    expect(topDetection([])).toBeUndefined();
  });

  it("totals boxes, boxes above the threshold and flagged photos", () => {
    const totals = surveyScores({
      candidate_threshold: 0.29,
      frames: { f0001: [det("a", 0.8), det("b", 0.3)], f0002: [det("c", 0.1)], f0003: [] },
    });
    expect(totals).toMatchObject({ boxes: 3, above: 2, photosFlagged: 1 });
    expect(totals.confs).toEqual([0.8, 0.3, 0.1]);
  });
});
