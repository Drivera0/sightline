import type { CacheBundle, Detection, Frame } from "../contract";

/** One photo the rank animation stops on: the frame, and the candidate detections in it. */
export interface ScanStop {
  frame: Frame;
  /** Position of the frame in flight order (0-based), for the counter and the timeline. */
  position: number;
  hits: Detection[];
}

/**
 * How long the scanner rests on a photo with nothing in it, and on one with a candidate. Kept well
 * under 3 changes a second (WCAG 2.3.1) and slow enough to read a box: this runs in front of judges.
 */
export const CLEAR_MS = 700;
export const HIT_MS = 1400;

/** Frames in flight order. */
export function framesInFlightOrder(cache: Pick<CacheBundle, "survey">): Frame[] {
  return [...cache.survey.frames].sort((a, b) => a.flight_index - b.flight_index);
}

/**
 * The photos the rank animation stops on, in flight order: the `maxHits` frames with the most
 * confident candidates, plus up to `maxClear` frames without one, evenly spread over the flight so
 * the pass covers all of it. Candidates in frames it does not stop on still join the queue as the
 * scan passes them.
 */
export function scanStops(
  cache: Pick<CacheBundle, "survey" | "detections">,
  maxClear = 8,
  maxHits = 8,
): ScanStop[] {
  const threshold = cache.detections.candidate_threshold;
  const frames = framesInFlightOrder(cache);
  const hitsOf = (frame: Frame) =>
    (cache.detections.frames[frame.id] ?? []).filter((d) => d.conf >= threshold);

  const clear: number[] = [];
  const stops: ScanStop[] = [];
  frames.forEach((frame, position) => {
    const hits = hitsOf(frame);
    if (hits.length > 0) stops.push({ frame, position, hits });
    else clear.push(position);
  });

  const best = (stop: ScanStop) => Math.max(...stop.hits.map((d) => d.conf));
  stops.sort((a, b) => best(b) - best(a) || a.position - b.position).splice(maxHits);

  const take = Math.min(maxClear, clear.length);
  for (let i = 0; i < take; i++) {
    const position = clear[Math.floor((i * clear.length) / take)] as number;
    stops.push({ frame: frames[position] as Frame, position, hits: [] });
  }
  return stops.sort((a, b) => a.position - b.position);
}

/** Total length of one pass of the scan, in milliseconds. */
export function scanDurationMs(stops: readonly ScanStop[]): number {
  return stops.reduce((ms, s) => ms + (s.hits.length > 0 ? HIT_MS : CLEAR_MS), 0);
}
