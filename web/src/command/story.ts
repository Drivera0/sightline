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

// ---- The guided search (`?guide=1`, guide.ts): its own clock, which waits at every decision and plays
// the time between them as a time-lapse ----

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
  /** The decision on screen (its choice key) and when it was shown (wall clock, ms): the end screen's decision time. */
  shown?: { key: string; at: number } | null;
  /** The time-lapse's speed between decisions (1×, 2×, 4×). */
  speed: Speed;
}

/** The time-lapse's speeds (the coach bar's 1× 2× 4×). */
export const SPEEDS = [1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];

export const useGuide = create<{
  guide: GuideState | null;
  start: (opts?: { watch?: boolean }) => void;
  stop: () => void;
  setClock: (ms: number) => void;
  pause: (paused?: boolean) => void;
  setWatch: (watch: boolean) => void;
  setSpeed: (speed: Speed) => void;
  choose: (c: Choice) => void;
  /** A decision is on screen (its choice key): stamps when, once, for the decision time. */
  show: (key: string) => void;
  end: () => void;
}>((set, get) => ({
  guide: null,
  // a new run from the call: nothing of the last one but the speed the visitor picked
  start: (opts = {}) => set({ guide: { clock: new Date(CHECKPOINTS[0]!.at).getTime(), paused: false, watch: !!opts.watch, choices: [], ended: false, speed: get().guide?.speed ?? 1 } }),
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
  setSpeed: (speed) => {
    const g = get().guide;
    if (g) set({ guide: { ...g, speed } });
  },
  choose: (c) => {
    const g = get().guide;
    if (!g || g.choices.some((x) => x.key === c.key)) return;
    // the wall-clock time the decision took: from when it was shown to now
    const now = Date.now();
    const timed = { ...c, shownAt: c.shownAt ?? (g.shown?.key === c.key ? g.shown.at : undefined), decidedAt: c.decidedAt ?? now };
    set({ guide: { ...g, choices: [...g.choices, timed], paused: false } });
  },
  show: (key) => {
    const g = get().guide;
    if (g && g.shown?.key !== key && !g.choices.some((x) => x.key === key)) set({ guide: { ...g, shown: { key, at: Date.now() } } });
  },
  end: () => {
    const g = get().guide;
    if (g) set({ guide: { ...g, ended: true, paused: true } });
  },
}));

/**
 * The time-lapse between two decisions: the run from one to the next takes 6–10 s at 1× whatever its
 * length in mission minutes (0.15 s a mission minute, held to that range), and the clock stops at each
 * timeline row on the way for a moment (dwellMs, shared out so a run takes about 8–12 s in all) so
 * the visitor sees what happened and when. Under reduced motion there is no run: the clock steps from
 * row to row.
 */
export const LAPSE = { secPerMin: 0.15, minS: 6, maxS: 10, dwellMs: 800, dwellTotalMs: 2000 } as const;

export interface Lapse {
  /** Where the run started and the decision it stops at (mission clock, ms). */
  from: number;
  hold: number;
  /** When each timeline row on the way lands (mission clock, ms), in order. */
  beats: readonly number[];
}

/** Mission ms per real ms for a run at 1×. */
export function lapseRate(l: Pick<Lapse, "from" | "hold">): number {
  const span = Math.max(0, l.hold - l.from);
  const s = Math.max(LAPSE.minS, Math.min(LAPSE.maxS, (span / 60_000) * LAPSE.secPerMin));
  return span / (s * 1000);
}

/** How long the clock stays on each row of a run (real ms at 1×). */
export const dwellFor = (l: Pick<Lapse, "beats">): number => Math.min(LAPSE.dwellMs, LAPSE.dwellTotalMs / Math.max(1, l.beats.length));

/**
 * The guided clock's next reading: `dt` ms of real time on from `clock` at the run's rate times `speed`,
 * stopped at the next row on the way (`beat`: the caller holds it there for dwellFor), never past the hold.
 * Reduced motion: straight to the next row (or the hold).
 */
export function lapseStep(clock: number, l: Lapse, dt: number, speed = 1, reduced = false): { clock: number; beat: boolean } {
  if (clock >= l.hold) return { clock, beat: false };
  const next = l.beats.find((b) => b > clock && b < l.hold);
  const to = reduced ? (next ?? l.hold) : Math.min(l.hold, clock + dt * lapseRate(l) * speed);
  if (next !== undefined && to >= next) return { clock: next, beat: true };
  return { clock: to, beat: false };
}

/** The landing: t0 with the pitch bar. */
export function landing(): void {
  useStory.setState({ t: 0, progress: 1, playing: false, through: null, pitch: true, started: true });
}

/** The view a checkpoint shows, for the view switch (t6 is the debrief). */
export const storyView = (t: Checkpoint) => checkpoint(t).view;
