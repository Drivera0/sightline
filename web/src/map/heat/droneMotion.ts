// Smooth replay motion for the drone icon. Paused or scrubbed, the drone glides to the slider's frame
// (stepDrone); playing, it flies the path at a steady ground speed (the track functions below), and
// its nose turns smoothly (shortest way round). Pure maths plus a tiny state object; useFlightReplay
// drives it from requestAnimationFrame.
import { bearingDeg } from "./layers";

type LonLat = [number, number];

/** Time constant of the glide towards the slider's step (ms). About 3τ to settle. */
export const GLIDE_TAU_MS = 90;
/** Time constant of the turn towards the new heading (ms). */
export const TURN_TAU_MS = 140;
/** Jumps larger than this many frames (a scrub) are not glided. */
export const SNAP_FRAMES = 40;

/**
 * Position and heading at a fractional step s (s = k: after k frames, at path[k - 1]).
 * Between whole steps the drone is on the straight line between the two frame positions.
 */
export function pointAtStep(path: readonly LonLat[], s: number): { at: LonLat; bearing: number; frame: number } | null {
  if (path.length === 0 || s < 1) return null;
  const f = Math.min(path.length - 1, Math.max(0, s - 1));
  const i = Math.min(path.length - 2, Math.floor(f));
  if (i < 0) return { at: path[0]!, bearing: 0, frame: 0 };
  const a = path[i]!;
  const b = path[i + 1]!;
  const t = f - i;
  const at: LonLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { at, bearing: bearingDeg(a, b), frame: Math.round(f) };
}

/** Move angle a towards b by fraction k along the shorter arc (degrees, result in [0, 360)). */
export function lerpAngle(a: number, b: number, k: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return (((a + d * k) % 360) + 360) % 360;
}

export interface DroneState {
  s: number;
  bearing: number;
}

/** One animation step of dt ms towards the target step. Snaps on large jumps or with reduced motion. */
export function stepDrone(
  state: DroneState,
  path: readonly LonLat[],
  target: number,
  dtMs: number,
  reduced: boolean,
): DroneState {
  if (reduced || Math.abs(target - state.s) > SNAP_FRAMES || state.s < 1) {
    const p = pointAtStep(path, target);
    return { s: target, bearing: p ? p.bearing : state.bearing };
  }
  const kGlide = 1 - Math.exp(-dtMs / GLIDE_TAU_MS);
  let s = state.s + (target - state.s) * kGlide;
  if (Math.abs(target - s) < 0.002) s = target;
  const p = pointAtStep(path, s);
  const kTurn = 1 - Math.exp(-dtMs / TURN_TAU_MS);
  return { s, bearing: p ? lerpAngle(state.bearing, p.bearing, kTurn) : state.bearing };
}

/** The trail flown so far at fractional step s: every whole frame passed, then the drone itself. */
export function trailAtStep(path: readonly LonLat[], s: number): LonLat[] {
  const p = pointAtStep(path, s);
  if (!p) return [];
  const whole = path.slice(0, Math.max(1, Math.min(path.length, Math.floor(s))));
  return s - Math.floor(s) > 1e-9 ? [...whole, p.at] : whole;
}

// --- The continuous replay (one requestAnimationFrame clock; see useFlightReplay.ts) --------------
//
// Playing, the drone moves at a steady ground speed along the flight path, measured in metres, so
// it never speeds up and settles at each photo the way a per-step glide did. Its nose follows the
// chord between a point just behind and a point just ahead, which rounds every turn over a few
// metres of path, then eases on top of that (TURN_TAU_MS).

/** One full play-through of the flight, at a steady ground speed (ms). */
export const REPLAY_MS = 12_000;
/** The heading looks this many photo spacings behind and ahead (rounds the turns). */
export const HEADING_LOOKAHEAD_SEGMENTS = 1;

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON_EQUATOR = 111_320;

export interface FlightTrack {
  path: readonly LonLat[];
  /** Distance along the path to each photo position, metres (cum[0] = 0). */
  cum: Float64Array;
  /** Path length, metres. */
  total: number;
  /** Heading look-behind / look-ahead distance, metres. */
  lookM: number;
}

/** Flat-earth distance in metres between two nearby points. */
export function segmentM(a: LonLat, b: LonLat): number {
  const dx = (b[0] - a[0]) * M_PER_DEG_LON_EQUATOR * Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

export function buildTrack(path: readonly LonLat[]): FlightTrack {
  const cum = new Float64Array(path.length);
  const legs: number[] = [];
  for (let i = 1; i < path.length; i++) {
    const m = segmentM(path[i - 1]!, path[i]!);
    cum[i] = cum[i - 1]! + m;
    if (m > 0) legs.push(m);
  }
  legs.sort((a, b) => a - b);
  const median = legs.length > 0 ? legs[legs.length >> 1]! : 0;
  return { path, cum, total: path.length > 0 ? cum[path.length - 1]! : 0, lookM: median * HEADING_LOOKAHEAD_SEGMENTS };
}

/** The fractional step at distance d along the path (s = k at path[k - 1]; 0 for an empty path). */
export function stepAtDistance(track: FlightTrack, d: number): number {
  const n = track.path.length;
  if (n === 0) return 0;
  if (n === 1 || track.total <= 0) return 1;
  const x = Math.min(track.total, Math.max(0, d));
  // The last leg starting at or before x.
  let lo = 0;
  let hi = n - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (track.cum[mid]! <= x) lo = mid;
    else hi = mid - 1;
  }
  const leg = track.cum[lo + 1]! - track.cum[lo]!;
  return 1 + lo + (leg > 0 ? Math.min(1, (x - track.cum[lo]!) / leg) : 1);
}

/** Distance along the path at fractional step s (inverse of stepAtDistance; 0 before the first photo). */
export function distanceAtStep(track: FlightTrack, s: number): number {
  const n = track.path.length;
  if (n < 2) return 0;
  const f = Math.min(n - 1, Math.max(0, s - 1));
  const i = Math.min(n - 2, Math.floor(f));
  return track.cum[i]! + (track.cum[i + 1]! - track.cum[i]!) * (f - i);
}

/** The heading at distance d: the chord from lookM behind to lookM ahead (rounded turns). */
export function headingAtDistance(track: FlightTrack, d: number, fallback = 0): number {
  const behind = pointAtStep(track.path, stepAtDistance(track, d - track.lookM));
  const ahead = pointAtStep(track.path, stepAtDistance(track, d + track.lookM));
  if (!behind || !ahead) return fallback;
  if (behind.at[0] === ahead.at[0] && behind.at[1] === ahead.at[1]) return behind.bearing;
  return bearingDeg(behind.at, ahead.at);
}

type Ring = readonly (readonly [number, number])[];

/**
 * The photo footprint at fractional step s: the corners of the two photos either side, matched by
 * position (a footprint flown the other way lists its corners rotated) and interpolated, so the
 * highlight glides from one photo to the next instead of jumping.
 */
export function footprintAtStep(footprints: readonly Ring[], s: number): LonLat[] | null {
  const n = footprints.length;
  if (n === 0 || s < 1) return null;
  const f = Math.min(n - 1, Math.max(0, s - 1));
  const i = Math.min(Math.max(0, n - 2), Math.floor(f));
  const t = n === 1 ? 0 : f - i;
  const a = footprints[i]!;
  const copy = (r: Ring): LonLat[] => r.map((c) => [c[0], c[1]]);
  if (t < 1e-9) return copy(a);
  const b = footprints[i + 1]!;
  if (t > 1 - 1e-9) return copy(b);
  if (a.length !== b.length || a.length === 0) return copy(t < 0.5 ? a : b);
  let best = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let k = 0; k < b.length; k++) {
    let sum = 0;
    for (let j = 0; j < a.length; j++) {
      const q = b[(j + k) % b.length]!;
      sum += (q[0] - a[j]![0]) ** 2 + (q[1] - a[j]![1]) ** 2;
    }
    if (sum < bestD) {
      bestD = sum;
      best = k;
    }
  }
  return a.map((p, j) => {
    const q = b[(j + best) % b.length]!;
    return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  });
}

/** Ease the heading towards `target` over dt ms (shortest way round). */
export function turnTowards(bearing: number, target: number, dtMs: number): number {
  return lerpAngle(bearing, target, 1 - Math.exp(-dtMs / TURN_TAU_MS));
}
