// Smooth replay motion for the drone icon: the drone glides between frame positions instead of
// jumping, and its nose turns smoothly (shortest way round) at the end of each flight line.
// Pure maths plus a tiny state object; HeatLayer drives it from requestAnimationFrame.
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
