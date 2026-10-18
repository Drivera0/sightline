import type { CacheBundle, Detection, Frame } from "../contract";

/**
 * One photo the rank animation stops on. `hits` are candidates (at or above the candidate
 * threshold); `rejected` are things the detector looked at and scored below it, shown only on
 * photos with no candidate, so they never sit on a person the detector already flagged.
 */
export interface ScanStop {
  frame: Frame;
  /** Position of the frame in flight order (0-based), for the counter and the timeline. */
  position: number;
  hits: Detection[];
  rejected: Detection[];
}

/**
 * How long the scanner rests on an empty photo, a rejected look-alike, and a candidate. Kept well
 * under 3 changes a second (WCAG 2.3.1) and slow enough to read a box: this runs in front of judges.
 */
export const CLEAR_MS = 900;
export const REJECT_MS = 1600;
export const HIT_MS = 1800;

/** Rest time for a stop. */
export function stopMs(stop: Pick<ScanStop, "hits" | "rejected">): number {
  if (stop.hits.length > 0) return HIT_MS;
  return stop.rejected.length > 0 ? REJECT_MS : CLEAR_MS;
}

/** Frames in flight order. */
export function framesInFlightOrder(cache: Pick<CacheBundle, "survey">): Frame[] {
  return [...cache.survey.frames].sort((a, b) => a.flight_index - b.flight_index);
}

const best = (detections: Detection[]) => Math.max(...detections.map((d) => d.conf));

/**
 * The photos the rank animation stops on, in flight order:
 * - the `maxHits` frames with the most confident candidates;
 * - the `maxRejected` candidate-free frames whose best detection scored highest (the detector
 *   looked, and said no);
 * - up to `maxClear` empty frames, evenly spread so the pass covers the whole flight.
 * Candidates in frames it does not stop on still join the queue as the scan passes them.
 */
export function scanStops(
  cache: Pick<CacheBundle, "survey" | "detections">,
  maxClear = 6,
  maxHits = 8,
  maxRejected = 4,
): ScanStop[] {
  const threshold = cache.detections.candidate_threshold;
  const frames = framesInFlightOrder(cache);

  const hitStops: ScanStop[] = [];
  const rejectStops: ScanStop[] = [];
  const clear: number[] = [];
  frames.forEach((frame, position) => {
    const all = cache.detections.frames[frame.id] ?? [];
    const hits = all.filter((d) => d.conf >= threshold);
    if (hits.length > 0) hitStops.push({ frame, position, hits, rejected: [] });
    else if (all.length > 0) rejectStops.push({ frame, position, hits: [], rejected: all });
    else clear.push(position);
  });

  hitStops.sort((a, b) => best(b.hits) - best(a.hits) || a.position - b.position).splice(maxHits);
  rejectStops.sort((a, b) => best(b.rejected) - best(a.rejected) || a.position - b.position).splice(maxRejected);

  const clearStops: ScanStop[] = [];
  const take = Math.min(maxClear, clear.length);
  for (let i = 0; i < take; i++) {
    const position = clear[Math.floor((i * clear.length) / take)] as number;
    clearStops.push({ frame: frames[position] as Frame, position, hits: [], rejected: [] });
  }
  return [...hitStops, ...rejectStops, ...clearStops].sort((a, b) => a.position - b.position);
}

/** Total length of one pass of the scan, in milliseconds. */
export function scanDurationMs(stops: readonly ScanStop[]): number {
  return stops.reduce((ms, s) => ms + stopMs(s), 0);
}
