import { describe, expect, it } from "vitest";
import { decodeSlice, iou, letterbox, mergeSlices, nms, offset, sliceBoxes, type Detection } from "./tiling";

describe("sliceBoxes (SAHI get_slice_bboxes, 1024 px, overlap 0.2)", () => {
  it("cuts a full 4000×3000 HERIDAL photo into 5 × 4 windows, the last ones pulled back to the edge", () => {
    const s = sliceBoxes(4000, 3000);
    expect(s).toHaveLength(20);
    // step 1024 - int(0.2 * 1024) = 820
    expect(s.slice(0, 5)).toEqual([
      [0, 0, 1024, 1024],
      [820, 0, 1844, 1024],
      [1640, 0, 2664, 1024],
      [2460, 0, 3484, 1024],
      [2976, 0, 4000, 1024],
    ]);
    expect(s.at(-1)).toEqual([2976, 1976, 4000, 3000]);
    for (const [x1, y1, x2, y2] of s) {
      expect(x2 - x1).toBe(1024);
      expect(y2 - y1).toBe(1024);
    }
  });

  it("uses one window, the whole photo, when it is smaller than a slice", () => {
    expect(sliceBoxes(1000, 750)).toEqual([[0, 0, 1000, 750]]);
  });

  it("covers every pixel", () => {
    const s = sliceBoxes(2500, 1700);
    for (const [x, y] of [
      [0, 0],
      [2499, 1699],
      [1250, 850],
    ] as const) {
      expect(s.some(([x1, y1, x2, y2]) => x >= x1 && x < x2 && y >= y1 && y < y2)).toBe(true);
    }
  });
});

describe("letterbox", () => {
  it("is the identity for a full 1024 px slice", () => {
    expect(letterbox(1024, 1024)).toEqual({ scale: 1, padX: 0, padY: 0, width: 1024, height: 1024 });
  });
  it("scales up and centres a 1000×750 survey photo", () => {
    const lb = letterbox(1000, 750);
    expect(lb.scale).toBeCloseTo(1.024);
    expect([lb.width, lb.height]).toEqual([1024, 768]);
    expect([lb.padX, lb.padY]).toEqual([0, 128]);
  });
});

describe("nms and iou", () => {
  const d = (box: [number, number, number, number], conf: number): Detection => ({ box, conf });
  it("keeps the most confident of overlapping boxes", () => {
    expect(iou([0, 0, 10, 10], [5, 0, 15, 10])).toBeCloseTo(1 / 3);
    const kept = nms([d([0, 0, 10, 10], 0.5), d([1, 0, 11, 10], 0.9), d([50, 50, 60, 60], 0.3)], 0.5);
    expect(kept.map((k) => k.conf)).toEqual([0.9, 0.3]);
  });
  it("suppresses at exactly the threshold only when inclusive (SAHI's merge)", () => {
    const a = d([0, 0, 10, 10], 0.9);
    const b = d([0, 0, 10, 5], 0.8); // IoU 0.5
    expect(nms([a, b], 0.5)).toHaveLength(2);
    expect(nms([a, b], 0.5, Infinity, true)).toHaveLength(1);
  });
});

describe("decodeSlice", () => {
  it("reads YOLO's [1, 5, anchors] layout, drops low scores and undoes the letterbox", () => {
    const anchors = 3;
    // rows: cx, cy, w, h, score; columns: anchors
    const out = new Float32Array([
      100, 500, 300, // cx
      228, 600, 400, // cy (input pixels, 128 px top padding)
      20, 10, 40, // w
      40, 10, 20, // h
      0.9, 0.01, 0.4, // score
    ]);
    const lb = letterbox(1000, 750);
    const dets = decodeSlice(out, anchors, lb, 1000, 750);
    expect(dets.map((x) => x.conf)).toEqual([0.9, 0.4].map((v) => Math.fround(v)));
    const [x1, y1, x2, y2] = dets[0]!.box;
    expect(x1).toBeCloseTo(90 / 1.024);
    expect(y1).toBeCloseTo((208 - 128) / 1.024);
    expect(x2).toBeCloseTo(110 / 1.024);
    expect(y2).toBeCloseTo((248 - 128) / 1.024);
  });
});

describe("mergeSlices", () => {
  it("merges a person seen by two overlapping slices into one box, in photo pixels", () => {
    const a = offset([{ box: [900, 100, 960, 160], conf: 0.8 }], [0, 0, 1024, 1024]);
    const b = offset([{ box: [81, 101, 141, 161], conf: 0.7 }], [820, 0, 1844, 1024]);
    const merged = mergeSlices([a, b], 4000, 3000);
    expect(merged).toEqual([{ box: [900, 100, 960, 160], conf: 0.8 }]);
  });
  it("drops degenerate boxes after rounding and clipping", () => {
    expect(mergeSlices([[{ box: [10.2, 10, 10.4, 20], conf: 0.9 }]], 100, 100)).toEqual([]);
  });
});
