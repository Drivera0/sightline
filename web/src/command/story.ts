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
  /** The end screen was put away ("Stay on the console"): the console stays on this run, its clock stopped. */
  closed?: boolean;
  /**
   * Free play (`#m/demo/map`, the console only): the same engine and clock, but no coach bar, no step strip
   * and no hidden items; the clock runs steadily (FREE_MIN_PER_S a second at 1×) and never waits on a
   * decision: proposals wait in Needs you while it runs, and the run still ends at the find.
   */
  free?: boolean;
}

/** Free play's clock at 1×: mission minutes per real second (2×, 4× multiply it). */
export const FREE_MIN_PER_S = 2;
/** Free play reads its beats this far ahead of the clock (mission ms), then the next stretch. */
export const FREE_WINDOW_MS = 30 * 60_000;

/** The time-lapse's speeds (the coach bar's 1× 2× 4×). */
export const SPEEDS = [1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];

export const useGuide = create<{
  guide: GuideState | null;
  start: (opts?: { watch?: boolean; free?: boolean }) => void;
  stop: () => void;
  setClock: (ms: number) => void;
  pause: (paused?: boolean) => void;
  setWatch: (watch: boolean) => void;
  setSpeed: (speed: Speed) => void;
  choose: (c: Choice) => void;
  /** A decision is on screen (its choice key): stamps when, once, for the decision time. */
  show: (key: string) => void;
  end: () => void;
  /** Put the end screen away (or back): the run's console stays, its clock stopped. */
  close: (closed?: boolean) => void;
}>((set, get) => ({
  guide: null,
  // a new run from the call: nothing of the last one but the speed the visitor picked
  // (free play: Watch instead is the guided run's, never free play's)
  start: (opts = {}) => set({ guide: { clock: new Date(CHECKPOINTS[0]!.at).getTime(), paused: false, watch: !opts.free && !!opts.watch, choices: [], ended: false, speed: get().guide?.speed ?? 1, ...(opts.free ? { free: true } : {}) } }),
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
  close: (closed = true) => {
    const g = get().guide;
    if (g) set({ guide: { ...g, closed } });
  },
}));

/**
 * The time-lapse between two decisions, one thing at a time (Dan, 2026-10-25: "way too fast … I'm not
 * understanding what's happening"). The timeline rows on the way are grouped into beats (`lapseBeats`:
 * rows alike landing together, "Drone 3: flight line approved · 3 drones", are one beat); the clock
 * travels from beat to beat, never faster than `secPerMin` real seconds a mission minute (4 mission
 * minutes a second), and stops on each beat for `beatMs` (1–1.5 s: the caption names it, the map shows
 * it). At 1× a stretch takes `minS`–`maxS` (15–25 s) in all where the floor allows; a short one travels
 * at most `maxSecPerMin` a minute. 2× and 4× travel 2 and 4 times faster and shorten each beat by the
 * square root (still one at a time). Under reduced motion there is no travel: the clock steps from
 * beat to beat.
 */
export const LAPSE = { secPerMin: 0.25, maxSecPerMin: 1, minS: 15, maxS: 25, beatMs: 1200, beatMinMs: 1000, beatsTotalMs: 12_000 } as const;

export interface Lapse {
  /** Where the run started and the decision it stops at (mission clock, ms). */
  from: number;
  hold: number;
  /** When each beat on the way lands (mission clock, ms), strictly increasing. */
  beats: readonly number[];
}

/** How long the clock stays on each beat of a run (real ms at 1×): 1.2 s, down to 1 s when there are many. */
export const dwellFor = (l: Pick<Lapse, "beats">): number => Math.max(LAPSE.beatMinMs, Math.min(LAPSE.beatMs, LAPSE.beatsTotalMs / Math.max(1, l.beats.length)));

/** The beat's stop at a speed: 2× and 4× shorten it by the square root, so it still reads. */
export const dwellAt = (l: Pick<Lapse, "beats">, speed: number): number => dwellFor(l) / Math.sqrt(Math.max(1, speed));

/** Mission ms per real ms while the clock travels between beats, at 1×. */
export function lapseRate(l: Pick<Lapse, "from" | "hold"> & Partial<Pick<Lapse, "beats">>): number {
  const span = Math.max(0, l.hold - l.from);
  const min = span / 60_000;
  const beats = l.beats?.filter((b) => b > l.from && b < l.hold) ?? [];
  const stops = (beats.length * dwellFor({ beats })) / 1000;
  const travel = Math.min(min * LAPSE.maxSecPerMin, Math.max(min * LAPSE.secPerMin, LAPSE.minS - stops));
  return travel > 0 ? span / (travel * 1000) : Infinity;
}

/** How long a run takes at 1× (real seconds): its travel and its beats. */
export function lapseSeconds(l: Lapse): number {
  const beats = l.beats.filter((b) => b > l.from && b < l.hold);
  return (l.hold - l.from) / lapseRate(l) / 1000 + (beats.length * dwellFor({ beats })) / 1000;
}

/**
 * The guided clock's next reading: `dt` ms of real time on from `clock` at the run's rate times `speed`,
 * stopped at the next beat on the way (`beat`: the caller holds it there for dwellAt), never past the hold.
 * Reduced motion: straight to the next beat (or the hold).
 */
export function lapseStep(clock: number, l: Lapse, dt: number, speed = 1, reduced = false): { clock: number; beat: boolean } {
  if (clock >= l.hold) return { clock, beat: false };
  const next = l.beats.find((b) => b > clock && b < l.hold);
  const to = reduced ? (next ?? l.hold) : Math.min(l.hold, clock + dt * lapseRate(l) * speed);
  if (next !== undefined && to >= next) return { clock: next, beat: true };
  return { clock: to, beat: false };
}

/** A timeline row on the way to the next decision. */
export interface LapseRow {
  at: number;
  text: string;
  kind?: string;
  team?: string | null;
  sector?: string | null;
}

/** One beat of the time-lapse: a row, or rows alike landing together, with what the map shows for it. */
export interface Beat {
  /** When it lands (mission clock, ms): its last row's time, a millisecond on from a beat at the same time. */
  at: number;
  /** The row's time, for the caption. */
  shown: number;
  text: string;
  /** Rows in it. */
  count: number;
  kind: string | null;
  teams: string[];
  sectors: string[];
}

/** Rows within this long of a group's first row, alike, are one beat (mission ms). */
export const GROUP_WITHIN_MS = 5 * 60_000;

const NUMBER = "(?:\\d+|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten)";
/** A row's shape: its words with the names and numbers taken out, so "Team One: position report" and "Team Two: position report" match. */
export const rowShape = (text: string): string =>
  text
    .replace(new RegExp(`\\b(Team|Drone|Photo) ${NUMBER}\\b`, "g"), "#")
    .replace(new RegExp(`\\b(Alpha|Bravo|Charlie|Delta|Echo|Foxtrot) ${NUMBER}\\b`, "g"), "§")
    .replace(/\b[A-Z]\d{1,2}\b/g, "§")
    .replace(/\d+(\.\d+)?/g, "0");

/** What a group of rows counts: "32 photos", "3 drones", "4 teams" (each named once), else "3 in all". */
function countOf(g: readonly LapseRow[]): string {
  const names = (re: RegExp) => new Set(g.flatMap((r) => r.text.match(re) ?? [])).size;
  const first = g[0]!.text;
  if (/\bphoto/i.test(first)) return `${g.length} photos`;
  const drones = names(new RegExp(`\\bDrone ${NUMBER}\\b`, "g"));
  if (drones > 1) return `${drones} drones`;
  const teams = names(new RegExp(`\\bTeam ${NUMBER}\\b`, "g"));
  if (teams > 1) return `${teams} teams`;
  return `${g.length} in all`;
}

/** The rows on the way as beats: alike rows landing within GROUP_WITHIN_MS of each other, one after another, are one. */
export function lapseBeats(rows: readonly LapseRow[]): Beat[] {
  const sorted = [...rows].sort((a, b) => a.at - b.at);
  const groups: LapseRow[][] = [];
  for (const r of sorted) {
    const g = groups.at(-1);
    if (g && rowShape(g[0]!.text) === rowShape(r.text) && r.at - g[0]!.at <= GROUP_WITHIN_MS) g.push(r);
    else groups.push([r]);
  }
  const out: Beat[] = [];
  for (const g of groups) {
    const last = g.at(-1)!;
    const at = Math.max(last.at, (out.at(-1)?.at ?? -Infinity) + 1);
    const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];
    out.push({
      at,
      shown: g[0]!.at,
      text: g.length > 1 ? `${g[0]!.text} · ${countOf(g)}` : g[0]!.text,
      count: g.length,
      kind: g[0]!.kind ?? null,
      teams: uniq(g.map((r) => r.team)),
      sectors: uniq(g.map((r) => r.sector)),
    });
  }
  return out;
}

/** The beat on screen (the map shows it: its sectors outlined, panned to only when off-screen), or none. */
export const useLapseBeat = create<{ beat: Beat | null }>(() => ({ beat: null }));

/** The landing: t0 with the pitch bar. */
export function landing(): void {
  useStory.setState({ t: 0, progress: 1, playing: false, through: null, pitch: true, started: true });
}

/** The view a checkpoint shows, for the view switch (t6 is the debrief). */
export const storyView = (t: Checkpoint) => checkpoint(t).view;
