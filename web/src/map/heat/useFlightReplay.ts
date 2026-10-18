// The flight replay's clock. Playing, one requestAnimationFrame loop owns the drone: it moves at a
// steady ground speed along the flight path (droneMotion.ts), its nose turns gradually, and the photo
// highlight glides from one footprint to the next. React is not re-rendered per frame: the slider's
// thumb is moved directly, and the store's step (which recolours the heat, moves pins and sectors)
// is committed only every COMMIT_MS, while the heat raster tweens between commits (HeatLayer).
//
// Paused, scrubbed or stepped by keyboard, the drone glides to the slider's step (stepDrone). With
// prefers-reduced-motion, Play jumps straight to the end of the flight and nothing glides.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Map } from "maplibre-gl";
import {
  buildTrack,
  distanceAtStep,
  type DroneState,
  footprintAtStep,
  headingAtDistance,
  lerpAngle,
  pointAtStep,
  REPLAY_MS,
  stepAtDistance,
  stepDrone,
  trailAtStep,
  turnTowards,
} from "./droneMotion";
import { pushDrone, setReplayEmphasis } from "./layers";

type LonLat = [number, number];
type Ring = readonly (readonly [number, number])[];

/** How often the playing clock commits its step to the store (heat, pins, sectors, the step text). */
export const COMMIT_MS = 120;
/** The heat raster's tween between two commits while playing: a little longer, so it never stalls. */
export const REPLAY_HEAT_TWEEN_MS = 160;
/** Frames longer than this (a hidden tab, a long task) advance the clock by this much at most. */
const MAX_FRAME_MS = 50;

export interface FlightReplay {
  playing: boolean;
  /** Play or pause. Under reduced motion, Play jumps to the end of the flight. */
  toggle: () => void;
  /** Stop and show the end of the flight. */
  skip: () => void;
  /** The slider was moved by hand (or keyboard): stop and go to that step. */
  scrub: (step: number) => void;
  /** Ref callback for the slider's <input>, so the clock can move its thumb without a render. */
  bindSlider: (el: HTMLInputElement | null) => void;
  /** Draw the drone, trail and highlight again (after a style reload). */
  redraw: () => void;
}

interface Options {
  map: Map | null;
  enabled: boolean;
  path: readonly LonLat[];
  footprints: readonly Ring[];
  stepIndex: number;
  stepCount: number;
  setStepIndex: (step: number) => void;
  reduced: boolean;
}

/** Slider thumb at a fractional step, without React (the input is controlled at commits only). */
export function moveSliderThumb(el: HTMLInputElement | null, s: number, max: number): void {
  if (!el || max <= 0) return;
  const v = Math.min(max, Math.max(0, s));
  el.value = String(v);
  el.style.setProperty("--sl-range-fill", `${(v / max) * 100}%`);
}

export function useFlightReplay({ map, enabled, path, footprints, stepIndex, stepCount, setStepIndex, reduced }: Options): FlightReplay {
  const [playing, setPlaying] = useState(false);
  const track = useMemo(() => buildTrack(path), [path]);
  const motion = useRef<DroneState>({ s: stepIndex, bearing: pointAtStep(path, stepIndex)?.bearing ?? 0 });
  const slider = useRef<HTMLInputElement | null>(null);
  /** Why the clock stops: a pause settles on the photo ahead; a skip or a scrub goes where it was sent. */
  const stopReason = useRef<"pause" | "jump">("pause");
  const live = useRef({ stepIndex, stepCount, setStepIndex });
  live.current = { stepIndex, stepCount, setStepIndex };

  const draw = useCallback(() => {
    if (!map || !enabled) return;
    const { s, bearing } = motion.current;
    const p = pointAtStep(path, s);
    try {
      pushDrone(map, p ? p.at : null, bearing, trailAtStep(path, s), footprintAtStep(footprints, s));
    } catch {
      /* style reloading; redraw() runs again from install() */
    }
  }, [map, enabled, path, footprints]);

  // The playing clock.
  useEffect(() => {
    if (!playing || !map || !enabled) return undefined;
    const { stepIndex: start, stepCount: count, setStepIndex: commitTo } = live.current;
    const last = Math.min(count, path.length);
    if (reduced || last <= 0 || track.total <= 0) {
      commitTo(count);
      setPlaying(false);
      return undefined;
    }
    // From the slider's step, or from the first photo when it is at either end.
    let s = start <= 0 || start >= last ? 1 : start;
    let d = distanceAtStep(track, s);
    if (start >= last || start <= 0) {
      motion.current = { s, bearing: headingAtDistance(track, d, motion.current.bearing) };
    }
    stopReason.current = "pause";
    let committed = -1;
    const commit = (step: number) => {
      if (step === committed) return;
      committed = step;
      commitTo(step);
    };
    commit(Math.floor(s));
    const speed = track.total / REPLAY_MS;
    let prev = performance.now();
    let lastCommit = prev;
    let frame = 0;
    const tick = (now: number) => {
      const dt = Math.min(MAX_FRAME_MS, Math.max(0, now - prev));
      prev = now;
      d = Math.min(track.total, d + speed * dt);
      s = stepAtDistance(track, d);
      motion.current = { s, bearing: turnTowards(motion.current.bearing, headingAtDistance(track, d, motion.current.bearing), dt) };
      draw();
      moveSliderThumb(slider.current, s, live.current.stepCount);
      if (d >= track.total) {
        motion.current = { s: last, bearing: motion.current.bearing };
        commit(live.current.stepCount);
        setPlaying(false);
        return;
      }
      if (now - lastCommit >= COMMIT_MS) {
        lastCommit = now;
        commit(Math.min(last, Math.floor(s)));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      // Paused mid-leg: settle on the photo ahead (the glide below takes the drone there).
      if (d < track.total && stopReason.current === "pause") live.current.setStepIndex(Math.min(last, Math.ceil(s - 1e-6)));
    };
  }, [playing, map, enabled, path, track, reduced, draw]);

  // Not playing: glide to the slider's step and turn smoothly; jump with reduced motion.
  useEffect(() => {
    if (playing || !map || !enabled) return undefined;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(64, Math.max(0, now - last));
      last = now;
      const next = stepDrone(motion.current, path, stepIndex, dt, reduced);
      motion.current = next;
      draw();
      const heading = pointAtStep(path, next.s)?.bearing ?? next.bearing;
      const settled = next.s === stepIndex && Math.abs(lerpAngle(next.bearing, heading, 1) - next.bearing) < 0.5;
      if (!settled && !reduced) frame = requestAnimationFrame(tick);
    };
    tick(performance.now());
    return () => cancelAnimationFrame(frame);
  }, [playing, map, enabled, path, stepIndex, reduced, draw]);

  // The trail brightens and the photo highlight fades in while the drone flies; at the end of the
  // flight the highlight fades out and the trail dims, so the search-next circles read first.
  const highlight = playing || (stepIndex > 0 && stepIndex < stepCount);
  useEffect(() => {
    if (!map || !enabled) return;
    try {
      setReplayEmphasis(map, { playing, highlight }, reduced);
    } catch {
      /* style reloading; install() applies it again */
    }
  }, [map, enabled, playing, highlight, reduced]);

  const toggle = useCallback(() => {
    if (reduced) {
      setPlaying(false);
      live.current.setStepIndex(live.current.stepCount);
      return;
    }
    setPlaying((p) => !p);
  }, [reduced]);
  const jump = useCallback((step: number) => {
    stopReason.current = "jump";
    setPlaying(false);
    live.current.setStepIndex(step);
  }, []);
  const skip = useCallback(() => jump(live.current.stepCount), [jump]);
  const scrub = jump;
  const bindSlider = useCallback((el: HTMLInputElement | null) => {
    slider.current = el;
  }, []);
  const redraw = useCallback(() => {
    draw();
    if (map && enabled) setReplayEmphasis(map, { playing, highlight }, true);
  }, [draw, map, enabled, playing, highlight]);

  return { playing, toggle, skip, scrub, bindSlider, redraw };
}
