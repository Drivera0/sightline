import type { CacheBundle, Detection, Frame } from "../contract";

/** One photo the rank animation stops on: the frame, and the candidate detections in it. */
export interface ScanStop {
  frame: Frame;
  /** Position of the frame in flight order (0-based), for the counter and the timeline. */
  position: number;
  hits: Detection[];
}

/** How long the scanner rests on a photo with nothing in it, and on one with a candidate. */
export const CLEAR_MS = 90;
export const HIT_MS = 320;

/** Frames in flight order. */
export function framesInFlightOrder(cache: Pick<CacheBundle, "survey">): Frame[] {
  return [...cache.survey.frames].sort((a, b) => a.flight_index - b.flight_index);
}

/**
 * The photos the rank animation shows, in flight order: every frame with a candidate, plus up to
 * `maxClear` frames without one, evenly spread over the flight so the loop covers all of it.
 */
export function scanStops(cache: Pick<CacheBundle, "survey" | "detections">, maxClear = 30): ScanStop[] {
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
