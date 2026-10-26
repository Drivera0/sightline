// Mission goals and the score (the owner, 2026-10-26: "not gamified enough to interest people to keep
// playing or to understand how it works"). Four goals a search manager holds anyway, each read live from the
// engine's own state (GuideRun.tsx gathers it: the find, the photos flagged for review and their answers,
// the radio clues and their confirmations, each team's last-heard clock), and at the end a score out of 100
// worked out from those goals and the time to find against the lines compare.ts already computes (the
// manual line, sim.ts manualLine; the AI's every pick). Every part says how it is worked out. The best
// score per scenario stays in this browser (localStorage, wrapped: private mode keeps none). Pure but the
// storage helpers. Built by lane A.

import { fmtMin } from "./compare";

/** What the goals are read from, all on the mission clock (ms). */
export interface GoalInput {
  /** The subject found (when, on the mission clock), or not yet. */
  found: number | null;
  /** Last light on the mission clock. */
  lastLight: number;
  /** The mission clock now. */
  now: number;
  /** Photos flagged for a person's review so far, and how many have an answer. */
  photos: { flagged: number; answered: number };
  /** Radio clues on the board, and how many are confirmed (read back, or with a bearing; logged without mapping is not). */
  clues: { total: number; confirmed: number };
  /** Teams on the search, those past their radio check-in now, and those that went past it at any time this run. */
  teams: { total: number; overdueNow: number; everOverdue: number };
}

export type GoalId = "find" | "photos" | "clues" | "checkins";
export type GoalState = "done" | "open" | "missed";

export interface Goal {
  id: GoalId;
  /** The goal, in full ("Find the subject before last light"). */
  label: string;
  /** Its chip's name ("Find by last light"). */
  short: string;
  /** Its chip's figure ("2/3", "found"; empty while the find is to play for: the status line has the daylight left). */
  brief: string;
  state: GoalState;
  /** Where it stands, in words from the state ("2 of 3 answered", "3 h 41 min of light left"). */
  progress: string;
  /** 0..1, for the score. */
  share: number;
}

const of = (a: number, b: number, what: string) => `${a} of ${b} ${what}`;

/** The four goals as they stand now. */
export function missionGoals(i: GoalInput): Goal[] {
  const left = (i.lastLight - i.now) / 60_000;
  const foundInTime = i.found !== null && i.found <= i.lastLight;
  const find: Goal = {
    id: "find",
    label: "Find the subject before last light",
    short: "Find by last light",
    brief: i.found !== null ? (foundInTime ? "found" : "late") : left > 0 ? "" : "dark",
    state: foundInTime ? "done" : i.found !== null || left <= 0 ? "missed" : "open",
    progress: i.found !== null ? (foundInTime ? "found" : "found after last light") : left > 0 ? `${fmtMin(left)} of light left` : "last light has gone",
    share: foundInTime ? 1 : 0,
  };
  const p = i.photos;
  const photos: Goal = {
    id: "photos",
    label: "Review every photo flagged",
    short: "Photos",
    brief: p.flagged === 0 ? "–" : `${Math.min(p.answered, p.flagged)}/${p.flagged}`,
    state: p.flagged === 0 ? "open" : p.answered >= p.flagged ? "done" : "open",
    progress: p.flagged === 0 ? "none flagged yet" : of(Math.min(p.answered, p.flagged), p.flagged, "answered"),
    share: p.flagged === 0 ? 1 : Math.min(1, p.answered / p.flagged),
  };
  const c = i.clues;
  const clues: Goal = {
    id: "clues",
    label: "Confirm each radio clue",
    short: "Radio clues",
    brief: c.total === 0 ? "–" : `${Math.min(c.confirmed, c.total)}/${c.total}`,
    state: c.total === 0 ? "open" : c.confirmed >= c.total ? "done" : "open",
    progress: c.total === 0 ? "none by radio yet" : of(Math.min(c.confirmed, c.total), c.total, "confirmed"),
    share: c.total === 0 ? 1 : Math.min(1, c.confirmed / c.total),
  };
  const t = i.teams;
  const kept = Math.max(0, t.total - t.everOverdue);
  const checkins: Goal = {
    id: "checkins",
    label: "Keep every team within its radio check-in",
    short: "Check-ins",
    brief: t.total ? `${kept}/${t.total}` : "none",
    state: t.everOverdue > 0 ? "missed" : "done",
    progress: t.overdueNow > 0 ? `${t.overdueNow} not heard in time` : t.everOverdue > 0 ? of(kept, t.total, "kept") : t.total ? `all ${t.total} heard in time` : "no teams out",
    share: t.total ? kept / t.total : 1,
  };
  return [find, photos, clues, checkins];
}

/** The times the score compares, in mission minutes from the call (null: not found by last light). */
export interface ScoreTimes {
  you: number | null;
  /** The manual line (no detector, photos by eye, a hand split: compare.ts withWithout). */
  manual: number | null;
  /** Every decision the AI's way, same seed and engine (null: not worked out, or not found). */
  agent: number | null;
  /** Last light, minutes from the call: the manual line's time when it does not find the subject. */
  lastLight: number;
}

export interface ScorePart {
  id: GoalId | "speed";
  label: string;
  points: number;
  max: number;
  /** How the part is worked out, with this run's numbers. */
  how: string;
}

export interface Score {
  total: number;
  max: 100;
  parts: ScorePart[];
}

/** The parts' weights: they add up to 100. */
export const WEIGHTS = { find: 40, speed: 20, photos: 15, clues: 15, checkins: 10 } as const;

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The score out of 100: the find before last light (40), the time to find against the manual line and the
 * AI's (20: full at the AI's time or faster, none at the manual line's, in proportion between), the photos
 * answered (15), the radio clues confirmed (15) and the teams kept within their check-in (10).
 */
export function missionScore(goals: readonly Goal[], t: ScoreTimes): Score {
  const g = (id: GoalId) => goals.find((x) => x.id === id)!;
  const find = g("find");
  const manual = t.manual ?? t.lastLight;
  let speed = 0;
  let speedHow: string;
  if (t.you === null || find.share === 0) speedHow = "No find before last light: no points for time.";
  else {
    const best = Math.min(t.agent ?? t.you, t.you);
    const span = manual - best;
    speed = span <= 0 ? (t.you <= manual ? 1 : 0) : Math.max(0, Math.min(1, (manual - t.you) / span));
    speedHow = `You found the subject in ${fmtMin(t.you)}; the manual search ${t.manual === null ? "does not by last light" : `takes ${fmtMin(t.manual)}`}${t.agent !== null ? `, the AI's every pick ${fmtMin(t.agent)}` : ""}. Full points at the faster of you and the AI, none at the manual search's time, in proportion between.`;
  }
  const part = (id: GoalId, max: number, how: string): ScorePart => ({ id, label: g(id).label, points: round1(max * g(id).share), max, how });
  const parts: ScorePart[] = [
    { id: "find", label: find.label, points: find.share * WEIGHTS.find, max: WEIGHTS.find, how: find.share ? "Found before last light: all 40." : "Not found before last light: 0." },
    { id: "speed", label: "Time to find", points: round1(speed * WEIGHTS.speed), max: WEIGHTS.speed, how: speedHow },
    part("photos", WEIGHTS.photos, `${g("photos").progress}: ${WEIGHTS.photos} × the share answered.`),
    part("clues", WEIGHTS.clues, `${g("clues").progress}: ${WEIGHTS.clues} × the share confirmed (logged without mapping does not count).`),
    part("checkins", WEIGHTS.checkins, `${g("checkins").progress}: ${WEIGHTS.checkins} × the share of teams never past their radio check-in.`),
  ];
  return { total: Math.round(parts.reduce((n, p) => n + p.points, 0)), max: 100, parts };
}

// ---- the best score per scenario, in this browser ----

const BEST_KEY = (seed: string) => `sightline.best-score.${seed}`;

/** The best score kept for this scenario, or null (none yet, or no storage). */
export function readBest(seed: string): number | null {
  try {
    const v = globalThis.localStorage?.getItem(BEST_KEY(seed));
    const n = v === null || v === undefined ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Keep a score if it beats the best: whether it did, and the best before it. */
export function keepBest(seed: string, score: number): { best: number | null; beat: boolean } {
  const best = readBest(seed);
  const beat = best === null || score > best;
  if (beat) {
    try {
      globalThis.localStorage?.setItem(BEST_KEY(seed), String(score));
    } catch {
      /* private mode: the best is not kept */
    }
  }
  return { best, beat };
}
