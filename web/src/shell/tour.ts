// The guided tour: a judge who opens the link alone gets the story told for them, one caption per
// stop, while the app moves itself through the five steps. Pure: the stops (captions built from
// the cache's own numbers) and the state machine that steps through them. The overlay owns the
// clock; Shell owns the side effects (changing step, the demo answer, pressing play).

import type { CacheBundle } from "../contract";
import { expectedLastPositive } from "../metrics/randomOrder";
import type { StepId } from "./flow";

/** Something the tour does on the page part-way through a stop. */
export type TourAction = "demoAnswer" | "playFlight";

export interface TourStop {
  id: string;
  step: StepId;
  title: string;
  body: string;
  /** How long the stop shows before the tour moves on by itself. */
  ms: number;
  action?: TourAction;
  /** When the action fires, in ms after the stop opens. */
  actionAtMs?: number;
}

/**
 * idle: no tour. playing: advances by itself. paused: the clock is held. manual: reduced motion,
 * captions only, the viewer presses Next. done: the last stop's time ran out; the caption stays
 * with Replay and Close.
 */
export type TourStatus = "idle" | "playing" | "paused" | "manual" | "done";

export interface TourState {
  status: TourStatus;
  index: number;
}

export type TourEvent =
  | { type: "start"; reducedMotion: boolean }
  | { type: "next" }
  | { type: "back" }
  | { type: "pause" }
  | { type: "resume" }
  /** The current stop's time ran out. */
  | { type: "elapsed" }
  | { type: "stop" };

export const TOUR_IDLE: TourState = { status: "idle", index: 0 };

export function isTouring(state: TourState): boolean {
  return state.status !== "idle";
}

/** The tour's state machine over `count` stops. */
export function tourReducer(state: TourState, event: TourEvent, count: number): TourState {
  if (count <= 0) return TOUR_IDLE;
  const last = count - 1;
  switch (event.type) {
    case "start":
      return { status: event.reducedMotion ? "manual" : "playing", index: 0 };
    case "stop":
      return TOUR_IDLE;
    case "next":
      if (state.status === "idle") return state;
      if (state.index >= last) return TOUR_IDLE; // Next on the last stop finishes the tour.
      // Stepping by hand from "done" plays on again; manual stays manual, paused stays paused.
      return { status: state.status === "done" ? "playing" : state.status, index: state.index + 1 };
    case "back":
      if (state.status === "idle") return state;
      return { status: state.status === "done" ? "paused" : state.status, index: Math.max(0, state.index - 1) };
    case "pause":
      return state.status === "playing" ? { ...state, status: "paused" } : state;
    case "resume":
      return state.status === "paused" ? { ...state, status: "playing" } : state;
    case "elapsed":
      if (state.status !== "playing") return state;
      return state.index >= last ? { ...state, status: "done" } : { ...state, index: state.index + 1 };
  }
}

/** Whether the current stop's clock runs (only while playing). */
export function clockRuns(state: TourState): boolean {
  return state.status === "playing";
}

/** Total running time of the tour, in ms. */
export function tourLengthMs(stops: readonly TourStop[]): number {
  return stops.reduce((sum, s) => sum + s.ms, 0);
}

/**
 * The stops, in story order. Every number is read from the cache (manifest, metrics.json); the
 * simulated parts (flight path, search evaluation, 10 m radius) are said to be simulated.
 */
export function tourStops(cache: CacheBundle): TourStop[] {
  const { manifest, metrics, survey } = cache;
  const n = manifest.n_frames;
  const { ranking, detector } = metrics;
  const k = ranking.n_positive;
  const hasRace = k >= 1 && k < ranking.n_frames;
  const randomAll = hasRace ? Math.round(expectedLastPositive(ranking.n_frames, k)) : null;
  const where = survey.simulated_path ? "on a simulated flight path" : "at their recorded GPS positions";

  return [
    {
      id: "survey",
      step: "survey",
      title: k >= ranking.n_frames ? `${n} photos, a person in each` : `${n} photos to check by eye`,
      body:
        `A drone survey brings back ${n} photos to check (sections of real HERIDAL drone images, ${where}). ` +
        (k >= ranking.n_frames
          ? "Every photo in this survey contains a person."
          : `Only ${k} of them contain a person, each a speck a few dozen pixels wide.`),
      ms: 8000,
    },
    {
      id: "rank",
      step: "rank",
      title: "The detector reads every photo",
      body:
        `It scans each photo in overlapping tiles, so a person a few dozen pixels wide is not lost, ` +
        `and flags the ones scoring at least ${detector.threshold}. Flagged photos join a queue, likeliest person first.`,
      ms: 11000,
    },
    {
      id: "review",
      step: "review",
      title: "A searcher answers each candidate",
      body:
        "Person, Not a person, or Unsure (keys P, N, U). The tour presses Person on the top candidate to show " +
        "what happens: it is pinned on the map with a 10 m position radius (simulated). This demo answer is not saved.",
      ms: 11000,
      action: "demoAnswer",
      actionAtMs: 3500,
    },
    {
      id: "search",
      step: "search",
      title: "Where the person could still be",
      body:
        "A probability map updated after every photo. Replaying the flight (simulated), ground the drone saw " +
        "clearly fades; forest it cannot see into stays bright, and ground never photographed is marked not yet searched.",
      ms: 12000,
      action: "playFlight",
      actionAtMs: 1500,
    },
    {
      id: "results",
      step: "results",
      title: "How well it works, with sources",
      body:
        hasRace && randomAll !== null
          ? `All ${k} photos with a person were in the first ${ranking.ranked.frames_to_all_hits} of the queue; ` +
            `a random order needs about ${randomAll} of ${ranking.n_frames} on average. ` +
            "Hover any number for its source; the search evaluation is simulated."
          : "Detector recall and speed against the published human baseline. Hover any number for its source; the search evaluation is simulated.",
      ms: 10000,
    },
  ];
}
