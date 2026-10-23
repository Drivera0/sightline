// The story's state: where the demo mission's clock is (a checkpoint and how far into it), whether it is
// playing, whether the coach marks are on, and what the visitor did on the console along the way. One
// store for the whole site: the console reads the mission from `useMission`, and this only says which
// moment of the demo mission `useMission` holds (missionTime.ts derives it).

import { create } from "zustand";
import type { MissionEvent } from "../contract";
import type { TriedPhoto } from "../detect/TryPhoto";
import type { LiveAnswer } from "../review/LiveReview";
import { prefersReducedMotion } from "../metrics/motion";
import { checkpoint, clockAt, LAST, type Checkpoint } from "./missionTime";

/** How long the clock takes to run into each checkpoint, in ms (reduced motion: no run, a jump). */
export const RUN_MS: Readonly<Record<Checkpoint, number>> = { 0: 0, 1: 6000, 2: 1200, 3: 1200, 4: 6000, 5: 2500, 6: 800 };

/** The last checkpoint the clock runs into: the end of the timeline. */
const END: Checkpoint = LAST;

/** The overdue hiker's beats per checkpoint (storyCopy.ts), until the loaded scenario sets its own. */
const BEATS = [1, 2, 3, 2, 2, 1, 1];

export interface StoryState {
  /** The checkpoint the clock is at, or running into. */
  t: Checkpoint;
  /** Which of the checkpoint's coach marks is showing (0-based). */
  beat: number;
  /** How many coach marks each checkpoint has for the loaded scenario (0: the story steps over it). */
  beats: readonly number[];
  setBeats: (beats: readonly number[]) => void;
  /** 0..1 of the way from the previous checkpoint into t (1: at t). */
  progress: number;
  playing: boolean;
  /** The scrubber's play: the clock runs on through every checkpoint to the end; the clock it started at. */
  through: string | null;
  /** The scrubber's play button (outside the story): play from here to the end, or pause and resume. */
  play: () => void;
  /** The coach marks are showing (the story is being followed). */
  tour: boolean;
  /** The landing's pitch bar (t0, before the story starts). */
  pitch: boolean;
  /** The demo mission's clock has been set at least once in this page (else the console opens at "now"). */
  started: boolean;
  /** What the visitor did on the demo console, as the events the console made (replayed when the clock moves). */
  user: MissionEvent[];
  /** The visitor's answers in the demo's Review rail (a live mission's go to the server). */
  answers: Record<string, LiveAnswer>;
  /** The last photo run through Try a photo: its result leads the Review rail. */
  tried: TriedPhoto | null;
  seek: (t: Checkpoint, opts?: { animate?: boolean; tour?: boolean; beat?: number }) => void;
  setProgress: (progress: number) => void;
  /** Space: pause or resume the clock's run into the checkpoint. */
  toggle: () => void;
  /** "Follow the search": the pitch bar goes, the clock runs to the first coach mark. */
  begin: () => void;
  /** The next coach mark (the arrow key): into the next checkpoint after the last of this one's. */
  next: () => void;
  /** On to the next checkpoint that has a mark, whatever beat this one is at (t3's approval). */
  nextCheckpoint: () => void;
  /** The previous coach mark. */
  previous: () => void;
  /** Esc: the marks go; the console stays at this mission time. */
  exit: () => void;
  /** "Skip to now": the mission as it stands at the end of the timeline, no story. */
  skipToNow: () => void;
  record: (events: readonly MissionEvent[]) => void;
  answer: (id: string, answer: LiveAnswer) => void;
  setTried: (tried: TriedPhoto | null) => void;
  reset: () => void;
}

const INITIAL = { t: LAST as Checkpoint, beat: 0, beats: BEATS as readonly number[], progress: 1, playing: false, through: null as string | null, tour: false, pitch: false, started: false, user: [] as MissionEvent[], answers: {} as Record<string, LiveAnswer>, tried: null as TriedPhoto | null };

export const useStory = create<StoryState>((set, get) => ({
  ...INITIAL,
  seek: (t, opts = {}) => {
    const animate = !!opts.animate && t > 0 && RUN_MS[t] > 0 && !prefersReducedMotion();
    set({ t, beat: opts.beat ?? 0, progress: animate ? 0 : 1, playing: animate, through: null, tour: opts.tour ?? get().tour, pitch: t === 0 && get().pitch, started: true });
  },
  setBeats: (beats) => {
    const s = get();
    if (beats.length === s.beats.length && beats.every((n, i) => n === s.beats[i])) return;
    set({ beats, beat: Math.min(s.beat, Math.max(0, (beats[s.t] ?? 1) - 1)) });
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
    if (prefersReducedMotion()) return get().seek(END, { tour: false });
    get().seek((from + 1) as Checkpoint, { animate: true, tour: false });
    set({ through: clockAt(from), pitch: false });
  },
  begin: () => {
    set({ pitch: false });
    get().seek(0, { tour: true });
  },
  next: () => {
    const { t, beat, beats } = get();
    if (beat + 1 < (beats[t] ?? 1)) return set({ beat: beat + 1 });
    get().nextCheckpoint();
  },
  nextCheckpoint: () => {
    const { t, beats } = get();
    for (let k = t + 1; k <= END; k++) if ((beats[k] ?? 1) > 0 || k === END) return get().seek(k as Checkpoint, { animate: true });
  },
  previous: () => {
    const { t, beat, beats } = get();
    if (beat > 0) return set({ beat: beat - 1, progress: 1, playing: false });
    for (let k = t - 1; k >= 0; k--) if ((beats[k] ?? 1) > 0) return get().seek(k as Checkpoint, { beat: Math.max(0, (beats[k] ?? 1) - 1) });
  },
  exit: () => set({ tour: false, pitch: false, playing: false, progress: 1, through: null }),
  skipToNow: () => set({ t: END, beat: 0, progress: 1, playing: false, through: null, tour: false, pitch: false, started: true }),
  record: (events) => set((s) => ({ user: [...s.user, ...events] })),
  answer: (id, answer) => set((s) => ({ answers: { ...s.answers, [id]: answer } })),
  setTried: (tried) => set({ tried }),
  reset: () => set({ ...INITIAL, beats: get().beats }),
}));

/** The mission clock the story is at (ISO). */
export function storyClock(s: Pick<StoryState, "t" | "progress">): string {
  return clockAt(s.t, s.progress);
}

/** The landing: t0 with the pitch bar. */
export function landing(): void {
  useStory.setState({ t: 0, beat: 0, progress: 1, playing: false, through: null, tour: false, pitch: true, started: true });
}

/** The view a checkpoint shows, for the view switch (t6 is the debrief). */
export const storyView = (t: Checkpoint) => checkpoint(t).view;
