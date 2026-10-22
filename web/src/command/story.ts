// The story's state: where the demo mission's clock is (a checkpoint and how far into it), whether it is
// playing, whether the coach marks are on, and what the visitor did on the console along the way. One
// store for the whole site: the console reads the mission from `useMission`, and this only says which
// moment of the demo mission `useMission` holds (missionTime.ts derives it).

import { create } from "zustand";
import type { MissionEvent } from "../contract";
import { prefersReducedMotion } from "../metrics/motion";
import { checkpoint, clockAt, type Checkpoint } from "./missionTime";

/** How long the clock takes to run into each checkpoint, in ms (reduced motion: no run, a jump). */
export const RUN_MS: Readonly<Record<Checkpoint, number>> = { 0: 0, 1: 6000, 2: 1200, 3: 1200, 4: 3500, 5: 0 };

export interface StoryState {
  /** The checkpoint the clock is at, or running into. */
  t: Checkpoint;
  /** 0..1 of the way from the previous checkpoint into t (1: at t). */
  progress: number;
  playing: boolean;
  /** The coach marks are showing (the story is being followed). */
  tour: boolean;
  /** The landing's pitch bar (t0, before the story starts). */
  pitch: boolean;
  /** The demo mission's clock has been set at least once in this page (else the console opens at "now"). */
  started: boolean;
  /** What the visitor did on the demo console, as the events the console made (replayed when the clock moves). */
  user: MissionEvent[];
  seek: (t: Checkpoint, opts?: { animate?: boolean; tour?: boolean }) => void;
  setProgress: (progress: number) => void;
  /** Space: pause or resume the clock's run into the checkpoint. */
  toggle: () => void;
  /** "Follow the search": the pitch bar goes, the clock runs to the first coach mark. */
  begin: () => void;
  next: () => void;
  previous: () => void;
  /** Esc: the marks go; the console stays at this mission time. */
  exit: () => void;
  /** "Skip to now": the mission as it stands at the end of the timeline, no story. */
  skipToNow: () => void;
  record: (events: readonly MissionEvent[]) => void;
  reset: () => void;
}

const INITIAL = { t: 4 as Checkpoint, progress: 1, playing: false, tour: false, pitch: false, started: false, user: [] as MissionEvent[] };

export const useStory = create<StoryState>((set, get) => ({
  ...INITIAL,
  seek: (t, opts = {}) => {
    const animate = !!opts.animate && t > 0 && RUN_MS[t] > 0 && !prefersReducedMotion();
    set({ t, progress: animate ? 0 : 1, playing: animate, tour: opts.tour ?? get().tour, pitch: t === 0 && get().pitch, started: true });
  },
  setProgress: (progress) => set(progress >= 1 ? { progress: 1, playing: false } : { progress }),
  toggle: () => {
    const s = get();
    if (s.progress < 1) set({ playing: !s.playing });
  },
  begin: () => {
    set({ pitch: false });
    get().seek(1, { animate: true, tour: true });
  },
  next: () => {
    const { t } = get();
    if (t < 5) get().seek((t + 1) as Checkpoint, { animate: true });
  },
  previous: () => {
    const { t } = get();
    if (t > 0) get().seek((t - 1) as Checkpoint);
  },
  exit: () => set({ tour: false, pitch: false, playing: false, progress: 1 }),
  skipToNow: () => set({ t: 4, progress: 1, playing: false, tour: false, pitch: false, started: true }),
  record: (events) => set((s) => ({ user: [...s.user, ...events] })),
  reset: () => set({ ...INITIAL }),
}));

/** The mission clock the story is at (ISO). */
export function storyClock(s: Pick<StoryState, "t" | "progress">): string {
  return clockAt(s.t, s.progress);
}

/** The landing: t0 with the pitch bar. */
export function landing(): void {
  useStory.setState({ t: 0, progress: 1, playing: false, tour: false, pitch: true, started: true });
}

/** The view a checkpoint shows, for the view switch (t5 is the debrief). */
export const storyView = (t: Checkpoint) => checkpoint(t).view;
