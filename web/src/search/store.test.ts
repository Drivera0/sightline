import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Detection, Detections, MapFile } from "../contract";
import { useReview, type HistoryEntry } from "../review/store";
import { cellsWithinRadius, replay } from "./update";
import {
  CHECKPOINT_EVERY,
  applyReview,
  deriveSearch,
  effectiveAnswers,
  heldCells,
  priorOf,
  stateAtStep,
  useSearch,
  type SearchData,
} from "./store";

const sum = (p: Float64Array) => p.reduce((a, b) => a + b, 0);

// A 10 × 10 grid with 60 random steps, so replays cross two checkpoints.
function syntheticMap(seed = 3): MapFile {
  let x = seed;
  const rand = () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
  const rows = 10;
  const cols = 10;
  const n = rows * cols;
  const raw = Array.from({ length: n }, () => 0.5 + rand());
  const total = raw.reduce((a, b) => a + b, 0);
  const prior = { p: raw.map((v) => (v / total) * 0.7), outside: 0.3 };
  const steps = Array.from({ length: 60 }, (_, k) => ({
    frame_id: `f${String(k + 1).padStart(4, "0")}`,
    cells: Array.from({ length: 4 }, (_, j): [number, number] => [(k * 7 + j * 13) % n, Math.round(rand() * 6000) / 10000]),
  }));
  const map: MapFile = {
    contract_version: "1.0",
    grid: { origin_nw: { lat: 49.374492, lon: -122.951898 }, cell_m: 20, rows, cols },
    lkp: { lat: 49.3736, lon: -122.9505 },
    params: { recall: 0.8, recall_source: "test", pod_cap: 0.95, review_pod: 0.9 },
    prior,
    canopy: Array.from({ length: n }, () => null),
    steps,
    final: prior,
    top_cells: [],
  };
  const final = replay(priorOf(map), steps, steps.length);
  return { ...map, final: { p: Array.from(final.p), outside: final.outside } };
}

function detection(id: string, lat: number, lon: number): Detection {
  return { id, box_px: [0, 0, 10, 10], conf: 0.9, crop: null, lat, lon, radius_m: 10 };
}

function dataFor(map: MapFile): SearchData {
  // Centre of cell (row 4, col 4) and of cell (row 7, col 2).
  const latOf = (row: number) => map.grid.origin_nw.lat - ((row + 0.5) * 20) / 111320;
  const lonOf = (col: number) =>
    map.grid.origin_nw.lon + ((col + 0.5) * 20) / (111320 * Math.cos((map.grid.origin_nw.lat * Math.PI) / 180));
  const detections: Detections = {
    contract_version: "1.0",
    model: "test",
    save_threshold: 0.05,
    candidate_threshold: 0.25,
    frames: {
      f0001: [detection("f0001-d01", latOf(4), lonOf(4))],
      f0002: [detection("f0002-d01", latOf(7), lonOf(2))],
    },
  };
  return { map, detections };
}

const h = (detectionId: string, answer: HistoryEntry["answer"], at: number): HistoryEntry => ({
  detectionId,
  answer,
  at,
});

describe("stateAtStep", () => {
  const map = syntheticMap();

  it("step 0 is the prior", () => {
    const s = stateAtStep(map, 0);
    expect(Array.from(s.p)).toEqual(map.prior.p);
    expect(s.outside).toBe(map.prior.outside);
  });

  it("the last step matches map.final within 1e-6", () => {
    const s = stateAtStep(map, map.steps.length);
    s.p.forEach((v, i) => expect(Math.abs(v - (map.final.p[i] as number))).toBeLessThan(1e-6));
    expect(Math.abs(s.outside - map.final.outside)).toBeLessThan(1e-6);
  });

  it("gives exactly replay()'s numbers at every step, in any scrub order", () => {
    expect(map.steps.length).toBeGreaterThan(2 * CHECKPOINT_EVERY);
    const order = [60, 3, 59, 25, 26, 0, 50, 49, 51, 24];
    for (const k of order) {
      const a = stateAtStep(map, k);
      const b = replay(priorOf(map), map.steps, k);
      expect(Array.from(a.p)).toEqual(Array.from(b.p));
      expect(a.outside).toBe(b.outside);
    }
  });

  it("clamps out-of-range step indices", () => {
    expect(stateAtStep(map, 999).outside).toBe(stateAtStep(map, 60).outside);
    expect(stateAtStep(map, -5).outside).toBe(map.prior.outside);
  });

  it("matches the sample cache's final map", () => {
    const sample = JSON.parse(
      readFileSync(join(process.cwd(), "public/cache/sample/map.json"), "utf8"),
    ) as MapFile;
    const s = stateAtStep(sample, sample.steps.length);
    s.p.forEach((v, i) => expect(Math.abs(v - (sample.final.p[i] as number))).toBeLessThan(1e-6));
  });
});

describe("effectiveAnswers (latest answer per detection, like useReview.answersOf)", () => {
  it("keeps each detection once, at its latest entry", () => {
    const out = effectiveAnswers([h("a", "not_person", 1), h("b", "person", 2), h("a", "unsure", 3)]);
    expect(out).toEqual([h("b", "person", 2), h("a", "unsure", 3)]);
  });
});

describe("applyReview", () => {
  const map = syntheticMap();
  const data = dataFor(map);
  const base = stateAtStep(map, 10);
  const near = cellsWithinRadius(map.grid, data.detections.frames.f0001![0]!.lat, data.detections.frames.f0001![0]!.lon, 10);

  it("a 'not a person' answer lowers p near the detection and conserves mass", () => {
    const r = applyReview(base, data, [h("f0001-d01", "not_person", 1)]);
    expect(near).toContain(44); // the cell holding the detection
    for (const idx of near) expect(r.state.p[idx]!).toBeLessThan(base.p[idx]!);
    expect(sum(r.state.p) + r.state.outside).toBeCloseTo(1, 9);
    expect(r.found).toBe(false);
  });

  it("an answer changed to unsure, or undone, no longer applies", () => {
    const changed = applyReview(base, data, [h("f0001-d01", "not_person", 1), h("f0001-d01", "unsure", 2)]);
    expect(Array.from(changed.state.p)).toEqual(Array.from(base.p));
    const repeated = applyReview(base, data, [h("f0001-d01", "not_person", 1), h("f0001-d01", "not_person", 2)]);
    const once = applyReview(base, data, [h("f0001-d01", "not_person", 1)]);
    expect(Array.from(repeated.state.p)).toEqual(Array.from(once.state.p));
  });

  it("unknown detection ids are ignored", () => {
    const r = applyReview(base, data, [h("f0999-d01", "not_person", 1)]);
    expect(Array.from(r.state.p)).toEqual(Array.from(base.p));
  });

  it("found is the most recent detection whose latest answer is 'person'", () => {
    expect(applyReview(base, data, [h("f0002-d01", "person", 1)])).toMatchObject({
      found: true,
      foundDetectionId: "f0002-d01",
    });
    expect(
      applyReview(base, data, [h("f0002-d01", "person", 1), h("f0002-d01", "not_person", 2)]).found,
    ).toBe(false);
    expect(
      applyReview(base, data, [h("f0002-d01", "person", 1), h("f0001-d01", "person", 2)]).foundDetectionId,
    ).toBe("f0001-d01");
  });

  it("a 'person' answer is a candidate sighting once its photo is flown, and undoing it restores the map", () => {
    // Give f0001-d01's own photo (step 1) a look at its cell, as a cache without held cells would.
    const looked: MapFile = {
      ...map,
      steps: map.steps.map((s, k) => (k === 0 ? { ...s, cells: [...s.cells, [44, 0.7] as [number, number]] } : s)),
    };
    const d = { ...data, map: looked };
    const flown = stateAtStep(looked, 10);
    const r = applyReview(flown, d, [h("f0001-d01", "person", 1)], 10);
    expect(r.sightings).toHaveLength(1);
    expect(r.sightings[0]!.detectionIds).toEqual(["f0001-d01"]);
    expect(r.sightings[0]!.share).toBe(1);
    // The photo's "nobody here" at cell 44 is undone: the cell goes back up.
    expect(r.state.p[44]!).toBeGreaterThan(flown.p[44]!);
    expect(sum(r.state.p) + r.state.outside).toBeCloseTo(1, 12);
    // Before the photo is flown: no sighting and no change.
    const early = applyReview(stateAtStep(looked, 0), d, [h("f0001-d01", "person", 1)], 0);
    expect(early.sightings).toEqual([]);
    expect(Array.from(early.state.p)).toEqual(Array.from(stateAtStep(looked, 0).p));
    // Changing the answer (or undo) leaves the map exactly as without it.
    const changed = applyReview(flown, d, [h("f0001-d01", "person", 1), h("f0001-d01", "unsure", 2)], 10);
    expect(Array.from(changed.state.p)).toEqual(Array.from(flown.p));
    expect(changed.sightings).toEqual([]);
  });

  it("several sightings split the chance by their areas' probability", () => {
    const r = applyReview(base, data, [h("f0001-d01", "person", 1), h("f0002-d01", "person", 2)], 10);
    expect(r.sightings).toHaveLength(2);
    expect(r.sightings.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1, 12);
    for (const s of r.sightings) {
      const poa = s.cells.reduce((a, c) => a + r.state.p[c]!, 0);
      expect(s.poa).toBeCloseTo(poa, 12);
    }
  });

  it("deriveSearch = stateAtStep then the answers", () => {
    const r = deriveSearch(data, 10, [h("f0001-d01", "not_person", 1)]);
    const s = applyReview(base, data, [h("f0001-d01", "not_person", 1)]);
    expect(Array.from(r.state.p)).toEqual(Array.from(s.state.p));
  });
});

describe("useSearch store", () => {
  const map = syntheticMap(11);
  const data = dataFor(map);

  beforeEach(() => {
    localStorage.clear();
    useReview.setState({ surveyId: null, history: [], answers: {} });
    useSearch.setState({ data: null, stepIndex: 0, stepCount: 0, state: null, found: false, foundDetectionId: null });
  });

  it("binds at the final map and scrubs", () => {
    useSearch.getState().bind(data);
    expect(useSearch.getState().stepIndex).toBe(60);
    expect(useSearch.getState().state!.outside).toBeCloseTo(map.final.outside, 9);
    useSearch.getState().setStepIndex(0);
    expect(useSearch.getState().state!.outside).toBe(map.prior.outside);
  });

  it("follows the review history, including undo and reset", () => {
    useSearch.getState().bind(data);
    const before = useSearch.getState().state!;
    const idx = 4 * 10 + 4;

    useReview.getState().answer("f0001-d01", "not_person", 1);
    expect(useSearch.getState().state!.p[idx]!).toBeLessThan(before.p[idx]!);

    useReview.getState().answer("f0002-d01", "person", 2);
    expect(useSearch.getState().found).toBe(true);
    expect(useSearch.getState().foundDetectionId).toBe("f0002-d01");

    // Scrubbing still works after a confirmation.
    useSearch.getState().setStepIndex(5);
    expect(useSearch.getState().stepIndex).toBe(5);
    expect(useSearch.getState().found).toBe(true);

    useReview.getState().undo();
    expect(useSearch.getState().found).toBe(false);

    useReview.getState().reset();
    useSearch.getState().setStepIndex(60);
    expect(Array.from(useSearch.getState().state!.p)).toEqual(Array.from(before.p));
  });
});

describe("heldCells (awaiting review)", () => {
  const map = syntheticMap();
  const cand = (id: string, lat: number, lon: number): Detection => ({ ...detection(id, lat, lon), crop: `crops/${id}.jpg` });
  const latOf = (row: number) => map.grid.origin_nw.lat - ((row + 0.5) * 20) / 111320;
  const lonOf = (col: number) =>
    map.grid.origin_nw.lon + ((col + 0.5) * 20) / (111320 * Math.cos((map.grid.origin_nw.lat * Math.PI) / 180));
  const detections: Detections = {
    contract_version: "1.0",
    model: "test",
    save_threshold: 0.05,
    candidate_threshold: 0.25,
    frames: {
      f0001: [cand("f0001-d01", latOf(4), lonOf(4)), detection("f0001-d02", latOf(1), lonOf(1))],
      f0002: [cand("f0002-d01", latOf(7), lonOf(2))],
    },
  };
  const data: SearchData = { map, detections };
  const near4 = cellsWithinRadius(map.grid, latOf(4), lonOf(4), 10);
  const near7 = cellsWithinRadius(map.grid, latOf(7), lonOf(2), 10);
  const idxOf = (held: Uint8Array) => Array.from(held.keys()).filter((i) => held[i] === 1);

  it("holds the cells of every candidate (crop set) when nothing is answered, and ignores non-candidates", () => {
    expect(idxOf(heldCells(data, []))).toEqual([...near4, ...near7].sort((a, b) => a - b));
  });

  it("keeps cells held after unsure or person, releases them after not a person", () => {
    expect(idxOf(heldCells(data, [h("f0001-d01", "unsure", 1)]))).toEqual([...near4, ...near7].sort((a, b) => a - b));
    expect(idxOf(heldCells(data, [h("f0001-d01", "person", 1)]))).toEqual([...near4, ...near7].sort((a, b) => a - b));
    expect(idxOf(heldCells(data, [h("f0001-d01", "not_person", 1)]))).toEqual(near7);
  });

  it("uses the latest answer per detection (changed or undone answers count)", () => {
    expect(idxOf(heldCells(data, [h("f0001-d01", "not_person", 1), h("f0001-d01", "unsure", 2)]))).toEqual(
      [...near4, ...near7].sort((a, b) => a - b),
    );
    const all = [h("f0001-d01", "not_person", 1), h("f0002-d01", "not_person", 2)];
    expect(idxOf(heldCells(data, all))).toEqual([]);
  });

  it("ignores answers for ids that are not in detections.json", () => {
    expect(idxOf(heldCells(data, [h("nope", "not_person", 1)]))).toEqual([...near4, ...near7].sort((a, b) => a - b));
  });
});
