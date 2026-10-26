// "You vs the agent" on the guided search's end screen (GuideEnd.tsx): the visitor's search against the
// agent's line (every decision its pick, same seed, same engine: sim.ts agentLine via guide.ts hotWash),
// in numbers that come only from the engine, the fixtures and the measured wall-clock time of each
// decision (Choice.shownAt/decidedAt, stamped by useGuide). Pure; built by lane A.

import { CHECKPOINTS, poaOf, subjectOf } from "./missionTime";
import { passesFrom, type Pass } from "./sim";
import { costsOf, PIPS, type GuideInput, type HotWash } from "./guide";

export interface SideStats {
  /** Mission minutes from the call to the find, or null: suspended at last light. */
  findMin: number | null;
  /** Distinct sectors a team finished a pass of (the finding pass included). */
  sectors: number;
  /** Team-hours on passes (walk and sweep) up to the find. */
  teamHours: number;
  /** Photo candidates triaged. */
  candidates: number;
  /** Decisions that went another way than the agent's pick. */
  differed: number;
  decisions: number;
  /** Share of the probability (the agent's map) searched without a find before the find, 0..1. */
  covered: number;
}

export interface DecisionTime {
  key: string;
  label: string;
  /** Wall-clock ms from shown to made. */
  ms: number;
  agent: boolean;
}

export interface DecisionRow {
  key: string;
  label: string;
  you: string;
  agent: string;
  same: boolean;
  /** Mission minutes the choice put on the clock (0: none). */
  costMin: number;
  /** Wall-clock ms it took, when measured. */
  thinkMs: number | null;
}

export interface Comparison {
  you: SideStats;
  agent: SideStats;
  /** The visitor's own decisions (not "Watch instead"), with their measured times. */
  times: DecisionTime[];
  totalMs: number;
  medianMs: number | null;
  /** Decisions "Watch instead" made for the visitor. */
  watched: number;
  rows: DecisionRow[];
  /** Every decision was the agent's pick: the two lines are one search. */
  followedAll: boolean;
  /** Minutes the visitor's find came after the agent's (negative: sooner), when both found. */
  deltaMin: number | null;
  verdict: string;
}

const ms = (iso: string) => new Date(iso).getTime();

export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** "2 min 14 s", "48 s", "1.6 s". */
export function fmtDuration(msv: number): string {
  const s = msv / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  const r = Math.round(s);
  if (r < 60) return `${r} s`;
  const m = Math.floor(r / 60);
  return `${m} min ${String(r % 60).padStart(2, "0")} s`;
}

export const fmtMin = (n: number) => (n < 60 ? `${Math.round(n)} min` : `${Math.floor(n / 60)} h ${String(Math.round(n % 60)).padStart(2, "0")} min`);

/**
 * One line's numbers from its passes, on the fixtures' clock: `until` is the find (or last light), and
 * `real` maps a fixture time to the mission clock (the visitor's costs stretch it; the agent's are zero).
 */
export function sideStats(passes: readonly Pass[], until: number, poa: ReadonlyMap<string, number>, real: (f: number) => number = (f) => f): Pick<SideStats, "sectors" | "teamHours" | "covered"> {
  const sectors = new Set<string>();
  let teamMs = 0;
  const miss = new Map<string, number>();
  for (const p of passes) {
    if (p.start >= until) continue;
    const end = Math.min(p.end, until);
    teamMs += real(end) - real(p.start);
    if (p.cut || p.end > until) continue;
    sectors.add(p.sector);
    if (!p.detected) miss.set(p.sector, 1 - (1 - (miss.get(p.sector) ?? 0)) * (1 - p.pod));
  }
  const total = [...poa.values()].reduce((n, x) => n + x, 0);
  const got = [...miss.entries()].reduce((n, [s, pod]) => n + (poa.get(s) ?? 0) * pod, 0);
  return {
    sectors: sectors.size,
    teamHours: teamMs / 3600_000,
    covered: total > 0 ? got / total : 0,
  };
}

/** The comparison, from the hot wash and the run's input. */
export function compare(input: GuideInput, wash: HotWash, lastLight: number): Comparison {
  const { full, choices } = input;
  const call = ms(CHECKPOINTS[0]!.at);
  const costs = costsOf(choices);
  const real = (f: number) => f + costs.filter((c) => c.f < f).reduce((n, c) => n + c.ms, 0);
  const poa = poaOf(full);
  const subject = subjectOf(full);

  // the visitor's line: every pass, cut ones too (the team walked)
  const mine = passesFrom(input.seed, subject, input.user);
  const hit = mine.find((p) => p.detected && !p.cut);
  const youUntil = wash.outcome.foundAt !== null && hit ? hit.end : lastLight;
  const agentUntil = wash.agent.foundAt ?? lastLight;

  const tri = choices.filter((c) => c.inject === "triage");
  const triAgent = new Set(tri.map((c) => c.card)).size;
  const differed = choices.filter((c) => !c.agent).length;
  const you: SideStats = {
    findMin: wash.outcome.foundAt !== null ? (wash.outcome.foundAt - call) / 60_000 : null,
    ...sideStats(mine, youUntil, poa, real),
    candidates: tri.length,
    differed,
    decisions: choices.length,
  };
  const agent: SideStats = {
    findMin: wash.agent.foundAt !== null ? (wash.agent.foundAt - call) / 60_000 : null,
    ...sideStats(wash.agent.passes, agentUntil, poa),
    candidates: triAgent,
    differed: 0,
    decisions: choices.length,
  };

  const pip = (id: string) => PIPS.find((x) => x.id === id)?.label ?? id;
  const label = (c: (typeof choices)[number]) => (c.inject === "triage" ? pip("triage") : c.key.startsWith("assign-") ? `Assign ${c.key.slice(7)}` : pip(c.inject));
  const think = (c: (typeof choices)[number]) => (!c.watched && c.shownAt !== undefined && c.decidedAt !== undefined ? Math.max(0, c.decidedAt - c.shownAt) : null);
  const times: DecisionTime[] = choices.flatMap((c) => {
    const t = think(c);
    return t === null ? [] : [{ key: c.key, label: label(c), ms: t, agent: c.agent }];
  });
  const totalMs = times.reduce((n, t) => n + t.ms, 0);
  const rows: DecisionRow[] = choices.map((c) => ({
    key: c.key,
    label: label(c),
    you: c.label,
    // a photo's AI pick without the photo's name again (the row's own answer names it)
    agent: c.inject === "triage" ? c.agentLabel.replace(/^Photo \d+ \([^)]*\): /, "") : c.agentLabel,
    same: c.agent,
    costMin: c.costMs / 60_000,
    thinkMs: think(c),
  }));
  const followedAll = choices.length > 0 && differed === 0;
  const deltaMin = you.findMin !== null && agent.findMin !== null ? Math.round(you.findMin - agent.findMin) : null;

  let verdict: string;
  if (followedAll) verdict = "Every decision went the AI's way, so your search and the AI's choices are the same search.";
  else if (deltaMin !== null)
    verdict =
      deltaMin === 0
        ? `Your search and the AI's choices found the subject at the same mission minute, with ${differed} of your ${choices.length} decisions different from its picks.`
        : deltaMin < 0
          ? `Your search found the subject ${fmtMin(-deltaMin)} sooner than the AI's choices.`
          : `The AI's choices found the subject ${fmtMin(deltaMin)} sooner; ${differed} of your ${choices.length} decisions went another way.`;
  else if (you.findMin === null && agent.findMin !== null) verdict = "Your search suspended at last light; the AI's choices found the subject before it.";
  else if (you.findMin !== null && agent.findMin === null) verdict = "Your search found the subject; the AI's choices suspended at last light.";
  else verdict = "Neither line found the subject before last light.";

  return {
    you,
    agent,
    times,
    totalMs,
    medianMs: median(times.map((t) => t.ms)),
    watched: choices.filter((c) => c.watched).length,
    rows,
    followedAll,
    deltaMin,
    verdict,
  };
}
