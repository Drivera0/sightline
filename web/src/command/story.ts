// The demo mission's clock outside the guided search: where it is (a checkpoint and how far into it),
// whether it is playing, and what the visitor did on the console along the way. One store for the whole
// site: the console reads the mission from `useMission`, and this only says which moment of the demo
// mission `useMission` holds (missionTime.ts derives it). `#m/demo?t=N` opens the console at a checkpoint
// (no coach marks: the walk-through is the guided search, `useGuide` below).

import { create } from "zustand";
import type { MissionEvent } from "../contract";
import type { TriedPhoto } from "../detect/TryPhoto";
import type { LiveAnswer } from "../review/LiveReview";
import { prefersReducedMotion } from "../metrics/motion";
import type { Choice } from "./guide";
import { checkpoint, CHECKPOINTS, clockAt, LAST, type Checkpoint } from "./missionTime";

/** How long the clock takes to run into each checkpoint, in ms (reduced motion: no run, a jump). */
export const RUN_MS: Readonly<Record<Checkpoint, number>> = { 0: 0, 1: 6000, 2: 1200, 3: 1200, 4: 6000, 5: 2500, 6: 800 };

/** The last checkpoint the clock runs into: the end of the timeline. */
const END: Checkpoint = LAST;

export interface StoryState {
  /** The checkpoint the clock is at, or running into. */
  t: Checkpoint;
  /** 0..1 of the way from the previous checkpoint into t (1: at t). */
  progress: number;
  playing: boolean;
  /** The scrubber's play: the clock runs on through every checkpoint to the end; the clock it started at. */
  through: string | null;
  /** The scrubber's play button: play from here to the end, or pause and resume. */
  play: () => void;
  /** The landing's pitch bar (t0, before the guided search starts). */
  pitch: boolean;
  /** The demo mission's clock has been set at least once in this page (else the console opens at "now"). */
  started: boolean;
  /** What the visitor did on the demo console, as the events the console made (replayed when the clock moves). */
  user: MissionEvent[];
  /** The visitor's answers in the demo's Review rail (a live mission's go to the server). */
  answers: Record<string, LiveAnswer>;
  /** The last photo run through Try a photo: its result leads the Review rail. */
  tried: TriedPhoto | null;
  seek: (t: Checkpoint, opts?: { animate?: boolean }) => void;
  setProgress: (progress: number) => void;
  /** Space: pause or resume the clock's run into the checkpoint. */
  toggle: () => void;
  /** The pitch bar goes; the console stays at this mission time. */
  exit: () => void;
  /** "Skip to now": the mission as it stands at the end of the timeline. */
  skipToNow: () => void;
  record: (events: readonly MissionEvent[]) => void;
  answer: (id: string, answer: LiveAnswer) => void;
  setTried: (tried: TriedPhoto | null) => void;
  reset: () => void;
}

const INITIAL = { t: LAST as Checkpoint, progress: 1, playing: false, through: null as string | null, pitch: false, started: false, user: [] as MissionEvent[], answers: {} as Record<string, LiveAnswer>, tried: null as TriedPhoto | null };

export const useStory = create<StoryState>((set, get) => ({
  ...INITIAL,
  seek: (t, opts = {}) => {
    const animate = !!opts.animate && t > 0 && RUN_MS[t] > 0 && !prefersReducedMotion();
    set({ t, progress: animate ? 0 : 1, playing: animate, through: null, pitch: t === 0 && get().pitch, started: true });
  },
  setProgress: (progress) => {
    if (progress < 1) return set({ progress });
    const { through, t } = get();
    // playing through: on into the next checkpoint, until the end
    if (through && t < END) {
      get().seek((t + 1) as Checkpoint, { animate: true });
      set({ through });
    } else set({ progress: 1, playing: false, through: null });
  },
  toggle: () => {
    const s = get();
    if (s.progress < 1) set({ playing: !s.playing });
  },
  play: () => {
    const s = get();
    if (s.progress < 1) return set({ playing: !s.playing });
    const from: Checkpoint = s.t >= END ? 0 : s.t;
    if (prefersReducedMotion()) return get().seek(END);
    get().seek((from + 1) as Checkpoint, { animate: true });
    set({ through: clockAt(from), pitch: false });
  },
  exit: () => set({ pitch: false, playing: false, progress: 1, through: null }),
  skipToNow: () => set({ t: END, progress: 1, playing: false, through: null, pitch: false, started: true }),
  record: (events) => set((s) => ({ user: [...s.user, ...events] })),
  answer: (id, answer) => set((s) => ({ answers: { ...s.answers, [id]: answer } })),
  setTried: (tried) => set({ tried }),
  reset: () => set({ ...INITIAL }),
}));

/** The mission clock the story is at (ISO): the guided search's own clock when it runs. */
export function storyClock(s: Pick<StoryState, "t" | "progress"> & { guide?: GuideState | null }): string {
  if (s.guide) return new Date(s.guide.clock).toISOString().replace(/\.\d+Z$/, "Z");
  return clockAt(s.t, s.progress);
}

// ---- The guided search (`?guide=1`, guide.ts): its own clock, which waits at every decision ----

export interface GuideState {
  /** The mission clock (ms). It runs toward the next decision and stops there until it is made. */
  clock: number;
  /** Space pauses it between decisions. */
  paused: boolean;
  /** "Watch instead": the agent's line plays each decision; T takes over. */
  watch: boolean;
  /** The decisions made, in order. */
  choices: Choice[];
  /** The end screen ("What you did") is up. */
  ended: boolean;
}

/** Mission minutes per real second while the guided clock runs (an hour in ten seconds). */
export const GUIDE_RATE = 360;

export const useGuide = create<{
  guide: GuideState | null;
  start: (opts?: { watch?: boolean }) => void;
  stop: () => void;
  setClock: (ms: number) => void;
  pause: (paused?: boolean) => void;
  setWatch: (watch: boolean) => void;
  choose: (c: Choice) => void;
  end: () => void;
}>((set, get) => ({
  guide: null,
  start: (opts = {}) => set({ guide: { clock: new Date(CHECKPOINTS[0]!.at).getTime(), paused: false, watch: !!opts.watch, choices: [], ended: false } }),
  stop: () => set({ guide: null }),
  setClock: (ms) => {
    const g = get().guide;
    if (g && g.clock !== ms) set({ guide: { ...g, clock: ms } });
  },
  pause: (paused) => {
    const g = get().guide;
    if (g) set({ guide: { ...g, paused: paused ?? !g.paused } });
  },
  setWatch: (watch) => {
    const g = get().guide;
    if (g) set({ guide: { ...g, watch } });
  },
  choose: (c) => {
    const g = get().guide;
    if (g && !g.choices.some((x) => x.key === c.key)) set({ guide: { ...g, choices: [...g.choices, c], paused: false } });
  },
  end: () => {
    const g = get().guide;
    if (g) set({ guide: { ...g, ended: true, paused: true } });
  },
}));

/**
 * The guided clock's next reading: `step` ms of real time on from `clock`, at GUIDE_RATE, never past
 * `hold` (the next decision, on the mission clock). Reduced motion: straight to the hold.
 */
export function guideStep(clock: number, hold: number | null, stepMs: number, reduced = false): number {
  if (hold === null) return clock;
  if (clock >= hold) return clock;
  return reduced ? hold : Math.min(hold, clock + stepMs * GUIDE_RATE);
}

/** The landing: t0 with the pitch bar. */
export function landing(): void {
  useStory.setState({ t: 0, progress: 1, playing: false, through: null, pitch: true, started: true });
}

/** The view a checkpoint shows, for the view switch (t6 is the debrief). */
export const storyView = (t: Checkpoint) => checkpoint(t).view;
