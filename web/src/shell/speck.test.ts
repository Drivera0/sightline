import { beforeAll, describe, expect, it } from "vitest";
import type { CacheBundle } from "../contract";
import { loadCache } from "../lib/cache";
import { diskFetch } from "../lib/diskFetch";
import {
  initialSpeck,
  loupeRegion,
  loupeSide,
  speckLabel,
  speckReducer,
  speckTimeline,
  topCandidate,
  type SpeckStatus,
} from "./speck";

let cache: CacheBundle;
beforeAll(async () => {
  cache = await loadCache("sample", diskFetch());
});

describe("topCandidate", () => {
  it("picks the most confident detection at or above the candidate threshold, with its frame", () => {
    const pick = topCandidate(cache)!;
    expect(pick.detection.id).toBe("f0005-d01");
    expect(pick.detection.conf).toBe(0.874);
    expect(pick.frame.id).toBe("f0005");
    expect(pick.frame.file).toBe("frames/f0005.jpg");
  });

  it("returns null when nothing reaches the threshold: no candidate, no animation", () => {
    const c = structuredClone(cache);
    c.detections.candidate_threshold = 0.99;
    expect(topCandidate(c)).toBeNull();
  });

  it("ignores detections whose frame is not in the survey", () => {
    const c = structuredClone(cache);
    c.survey.frames = c.survey.frames.filter((f) => f.id !== "f0005");
    expect(topCandidate(c)!.frame.id).toBe("f0012");
  });

  it("breaks ties by flight order, so the pick is stable", () => {
    const c = structuredClone(cache);
    c.detections.frames["f0012"]![0]!.conf = 0.874;
    const f5 = c.survey.frames.find((f) => f.id === "f0005")!;
    const f12 = c.survey.frames.find((f) => f.id === "f0012")!;
    const expected = f5.flight_index < f12.flight_index ? "f0005" : "f0012";
    expect(topCandidate(c)!.frame.id).toBe(expected);
  });
});

describe("speckLabel", () => {
  it("says only what the cache says: the score and the box width in this photo", () => {
    const label = speckLabel(topCandidate(cache)!);
    expect(label.title).toBe("Person · detector score 0.87");
    expect(label.size).toBe("48 px wide in a 1000 px photo");
    expect(label.text).toBe("Person · detector score 0.87 · 48 px wide in a 1000 px photo");
  });

  it("makes no time or effort claims", () => {
    expect(speckLabel(topCandidate(cache)!).text).not.toMatch(/second|minute|hour|faster|saved|\bs\b/i);
  });
});

describe("loupe", () => {
  it("magnifies a square around the box, inside the photo", () => {
    const pick = topCandidate(cache)!;
    const r = loupeRegion(pick);
    const [x1, y1, x2, y2] = pick.detection.box_px;
    expect(r.side).toBeCloseTo((y2 - y1) * 2.2);
    expect(r.x).toBeLessThanOrEqual(x1);
    expect(r.y).toBeLessThanOrEqual(y1);
    expect(r.x + r.side).toBeGreaterThanOrEqual(x2);
    expect(r.y + r.side).toBeGreaterThanOrEqual(y2);
  });

  it("stays inside the photo for a box at the corner", () => {
    const pick = topCandidate(cache)!;
    const corner = { ...pick, detection: { ...pick.detection, box_px: [0, 0, 20, 20] as [number, number, number, number] } };
    const r = loupeRegion(corner);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.side).toBe(72);
    expect(loupeSide(corner)).toBe("right");
    const right = { ...pick, detection: { ...pick.detection, box_px: [950, 10, 990, 60] as [number, number, number, number] } };
    expect(loupeRegion(right).x + loupeRegion(right).side).toBe(pick.frame.width_px);
    expect(loupeSide(right)).toBe("left");
  });
});

describe("speckTimeline", () => {
  it("snaps the box on when the scan line reaches it, then the loupe, then the label, then settles", () => {
    const pick = topCandidate(cache)!;
    const t = speckTimeline(pick);
    const cy = (pick.detection.box_px[1] + pick.detection.box_px[3]) / 2;
    expect(t.boxAt).toBe(Math.round(t.scanAt + t.scanMs * (cy / pick.frame.height_px)));
    expect(t.loupeAt).toBeGreaterThan(t.boxAt);
    expect(t.labelAt).toBeGreaterThan(t.loupeAt);
    expect(t.settleAt).toBeGreaterThanOrEqual(t.scanAt + t.scanMs);
    expect(t.endAt).toBeGreaterThan(t.settleAt);
    // The whole story in about 5–6 s.
    expect(t.endAt).toBeGreaterThanOrEqual(4500);
    expect(t.endAt).toBeLessThanOrEqual(6500);
  });
});

describe("speck state", () => {
  it("shows the end state still for reduced motion, and never animates it", () => {
    const s = initialSpeck({ reducedMotion: true, played: false });
    expect(s).toBe("still");
    for (const type of ["start", "replay", "ended", "quiet"] as const) expect(speckReducer(s, { type })).toBe("still");
  });

  it("plays once: waiting, playing, then rest; a later visit to the page starts at rest", () => {
    let s: SpeckStatus = initialSpeck({ reducedMotion: false, played: false });
    expect(s).toBe("waiting");
    s = speckReducer(s, { type: "start" });
    expect(s).toBe("playing");
    s = speckReducer(s, { type: "ended" });
    expect(s).toBe("rest");
    expect(speckReducer(s, { type: "start" })).toBe("rest");
    expect(initialSpeck({ reducedMotion: false, played: true })).toBe("rest");
  });

  it("replays on request, and goes quiet (without playing later) when the tour starts", () => {
    expect(speckReducer("rest", { type: "replay" })).toBe("playing");
    expect(speckReducer("playing", { type: "quiet" })).toBe("rest");
    expect(speckReducer("waiting", { type: "quiet" })).toBe("rest");
  });
});
