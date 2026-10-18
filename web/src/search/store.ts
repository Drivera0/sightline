// Lane C search store (LANE_C_SEARCH §9). Holds only the step slider position; the map state is
// derived from map.json's steps plus D's review history. Review answers are never copied here.
import { create } from "zustand";
import type { Detection, Detections, MapFile } from "../contract";
import { useCache } from "../lib/cache";
import { useReview, type HistoryEntry } from "../review/store";
import {
  applyReviewNotPerson,
  applyReviewPerson,
  candidateShares,
  cellsWithinRadius,
  mergeSightings,
  replay,
  type CandidateShare,
  type MapState,
} from "./update";

export interface SearchData {
  map: MapFile;
  detections: Detections;
}

export interface SearchDerived {
  /** The map: replayed steps, "not a person" answers, and each flown sighting's own look undone. */
  state: MapState;
  found: boolean;
  foundDetectionId: string | null;
  /**
   * Candidate sightings: "Person" answers whose photo the replay has flown, merged where their areas
   * overlap, with each area's share of the chance if the missing person is one of them.
   */
  sightings: CandidateShare[];
}

/** Replay checkpoints are kept every this many steps, so scrubbing never replays from the start. */
export const CHECKPOINT_EVERY = 25;

const checkpoints = new WeakMap<MapFile, MapState[]>();

export function priorOf(map: MapFile): MapState {
  return { p: Float64Array.from(map.prior.p), outside: map.prior.outside };
}

/**
 * Same result as replay(prior, map.steps, stepIndex), but starts from the nearest cached
 * checkpoint at or below stepIndex. The operations are identical, so the numbers are too.
 */
export function stateAtStep(map: MapFile, stepIndex: number): MapState {
  const n = Math.max(0, Math.min(map.steps.length, Math.floor(stepIndex)));
  let saved = checkpoints.get(map);
  if (!saved) {
    saved = [priorOf(map)];
    checkpoints.set(map, saved);
  }
  const want = Math.floor(n / CHECKPOINT_EVERY);
  while (saved.length <= want) {
    const i = saved.length - 1;
    const start = i * CHECKPOINT_EVERY;
    const chunk = map.steps.slice(start, start + CHECKPOINT_EVERY);
    saved.push(replay(saved[i] as MapState, chunk, chunk.length));
  }
  const start = want * CHECKPOINT_EVERY;
  return replay(saved[want] as MapState, map.steps.slice(start, n), n - start);
}

/**
 * The review answers that still count, using the same "latest answer per detection" rule as
 * useReview's answersOf. A detection counts once, at the position of its latest entry, so an
 * answer that was later changed, or removed by undo/reset, does not apply.
 * Returns detection ids in that order with their current answer.
 */
export function effectiveAnswers(history: readonly HistoryEntry[]): HistoryEntry[] {
  const lastIndex = new Map<string, number>();
  history.forEach((entry, i) => lastIndex.set(entry.detectionId, i));
  return history.filter((entry, i) => lastIndex.get(entry.detectionId) === i);
}

const detectionIndexes = new WeakMap<Detections, Map<string, Detection>>();

const frameIndexes = new WeakMap<Detections, Map<string, string>>();

/** The frame a detection was found in (detections.json is keyed by frame). */
export function frameOfDetection(detections: Detections, id: string): string | undefined {
  let index = frameIndexes.get(detections);
  if (!index) {
    index = new Map();
    for (const [frameId, list] of Object.entries(detections.frames)) for (const d of list) index.set(d.id, frameId);
    frameIndexes.set(detections, index);
  }
  return index.get(id);
}

const stepIndexes = new WeakMap<MapFile, Map<string, number>>();

/** The 0-based step of a frame in map.json (steps are in flight order), or -1. */
export function stepOfFrame(map: MapFile, frameId: string): number {
  let index = stepIndexes.get(map);
  if (!index) {
    index = new Map();
    map.steps.forEach((s, i) => index!.set(s.frame_id, i));
    stepIndexes.set(map, index);
  }
  return index.get(frameId) ?? -1;
}

export function detectionById(detections: Detections, id: string): Detection | undefined {
  let index = detectionIndexes.get(detections);
  if (!index) {
    index = new Map();
    for (const list of Object.values(detections.frames)) for (const d of list) index.set(d.id, d);
    detectionIndexes.set(detections, index);
  }
  return index.get(id);
}

/**
 * Apply each still-valid answer, in history order, to the state after `stepIndex` steps (default:
 * the whole flight): "not a person" clears the cells around it; "person" is a candidate sighting, so
 * once its photo is flown that photo's "nobody here" look at the cells around it is undone
 * (applyReviewPerson). Then the flown sightings are merged into candidate areas with their shares.
 * foundDetectionId is the most recent detection whose latest answer is "person".
 * Ids not in detections.json (for example an old saved history) are ignored.
 */
export function applyReview(
  base: MapState,
  data: SearchData,
  history: readonly HistoryEntry[],
  stepIndex: number = data.map.steps.length,
): SearchDerived {
  const { grid, params } = data.map;
  let state = base;
  let foundDetectionId: string | null = null;
  const sighted: { detectionId: string; cells: number[] }[] = [];
  for (const entry of effectiveAnswers(history)) {
    const detection = detectionById(data.detections, entry.detectionId);
    if (!detection) continue;
    if (entry.answer === "not_person") {
      state = applyReviewNotPerson(
        state,
        grid,
        detection.lat,
        detection.lon,
        detection.radius_m,
        params.review_pod,
        params.pod_cap,
      );
    } else if (entry.answer === "person") {
      foundDetectionId = entry.detectionId;
      const frameId = frameOfDetection(data.detections, entry.detectionId);
      const step = frameId === undefined ? -1 : stepOfFrame(data.map, frameId);
      if (step < 0 || step >= stepIndex) continue;
      state = applyReviewPerson(state, grid, detection.lat, detection.lon, detection.radius_m, data.map.steps[step] ?? null);
      sighted.push({ detectionId: entry.detectionId, cells: cellsWithinRadius(grid, detection.lat, detection.lon, detection.radius_m) });
    }
  }
  const sightings = sighted.length > 0 ? candidateShares(state, mergeSightings(sighted)) : [];
  return { state, found: foundDetectionId !== null, foundDetectionId, sightings };
}

/**
 * Cells "awaiting review": 1 for every cell within radius_m of a candidate detection (crop set)
 * whose latest answer is not "not_person" (no answer, "unsure" or "person"). Those cells have
 * pod 0 in the map until a searcher says "Not a person". Same latest-answer rule as
 * effectiveAnswers; nothing is stored. Detections can sit in any frame, so this is survey-wide.
 */
export function heldCells(data: SearchData, history: readonly HistoryEntry[]): Uint8Array {
  const { grid } = data.map;
  const held = new Uint8Array(grid.rows * grid.cols);
  const rejected = new Set(
    effectiveAnswers(history)
      .filter((e) => e.answer === "not_person")
      .map((e) => e.detectionId),
  );
  for (const list of Object.values(data.detections.frames)) {
    for (const d of list) {
      if (d.crop === null || rejected.has(d.id)) continue;
      for (const idx of cellsWithinRadius(grid, d.lat, d.lon, d.radius_m)) held[idx] = 1;
    }
  }
  return held;
}

/** Full derivation: replay to stepIndex, then the review answers. */
export function deriveSearch(
  data: SearchData,
  stepIndex: number,
  history: readonly HistoryEntry[],
): SearchDerived {
  return applyReview(stateAtStep(data.map, stepIndex), data, history, stepIndex);
}

interface SearchStore {
  data: SearchData | null;
  /** Number of steps applied: 0 = prior, steps.length = final map. */
  stepIndex: number;
  stepCount: number;
  state: MapState | null;
  found: boolean;
  foundDetectionId: string | null;
  sightings: CandidateShare[];
  /** Use this cache. Resets the slider to the final map when the map file changes. */
  bind: (data: SearchData) => void;
  setStepIndex: (stepIndex: number) => void;
}

// The step state depends only on (map, stepIndex); keep it so review changes skip the replay.
let baseCache: { map: MapFile; stepIndex: number; state: MapState } | null = null;

function derive(data: SearchData, stepIndex: number): SearchDerived {
  if (!baseCache || baseCache.map !== data.map || baseCache.stepIndex !== stepIndex) {
    baseCache = { map: data.map, stepIndex, state: stateAtStep(data.map, stepIndex) };
  }
  return applyReview(baseCache.state, data, useReview.getState().history, stepIndex);
}

export const useSearch = create<SearchStore>((set, get) => ({
  data: null,
  stepIndex: 0,
  stepCount: 0,
  state: null,
  found: false,
  foundDetectionId: null,
  sightings: [],
  bind: (data) => {
    const current = get().data;
    if (current && current.map === data.map && current.detections === data.detections) return;
    const sameMap = current?.map === data.map;
    const stepCount = data.map.steps.length;
    const stepIndex = sameMap ? get().stepIndex : stepCount;
    set({ data, stepCount, stepIndex, ...derive(data, stepIndex) });
  },
  setStepIndex: (value) => {
    const { data, stepCount } = get();
    const stepIndex = Math.max(0, Math.min(stepCount, Math.round(value)));
    if (!data) return set({ stepIndex });
    if (stepIndex === get().stepIndex && get().state) return;
    set({ stepIndex, ...derive(data, stepIndex) });
  },
}));

/** Recompute from the current inputs (after the review history changes). */
export function recomputeSearch(): void {
  const { data, stepIndex } = useSearch.getState();
  if (data) useSearch.setState(derive(data, stepIndex));
}

useReview.subscribe((next, prev) => {
  if (next.history !== prev.history) recomputeSearch();
});

useCache.subscribe((next, prev) => {
  if (next.data && next.data !== prev.data) {
    useSearch.getState().bind({ map: next.data.map, detections: next.data.detections });
  }
});
