// The guided search's consequence model (`?guide=1`, .documents/SIM_DESIGN.md §4), pure. The subject's
// position is the scenario's (its fixture's find, never shown before it happens). A team the manager
// sends walks out and sweeps its sector; when the sector holds the subject, the pass detects them with
// probability POD, and the draw is fixed by the scenario's seed and the pass (the same choices always give
// the same result; the end screen prints every draw). A pass that does not detect the subject marks the
// sector searched at that POD and the agent proposes the likeliest open sector next. There is no fail
// state: at last light the search suspends. The same engine plays the agent's own line, the baseline the
// end screen compares with. Decisions that take mission minutes (a bearing, a confirmation) stop the
// fixtures' clock for that long: `fixtureOf` and `realOf` map the mission clock to the fixtures' and back.
// Built by lane A.

import type { MissionEvent, SectorTask } from "../contract";

/** A team's chance of detecting the subject on one pass of the sector that holds them. */
export const TEAM_POD = 0.6;
/** From base camp to the sector. */
export const WALK_MS = 6 * 60_000;
/** One pass of a sector, once the team is there. */
export const SWEEP_MS = 10 * 60_000;
/** Back to base camp from the sector once a pass ends with no find (from part of the way: that part of it). */
export const RETURN_MS = WALK_MS;

export interface Subject {
  sector: string;
  lat: number;
  lon: number;
}

/** One pass: a team, a sector, its draw, and when it ends (the find partway through, or the sweep's end). */
export interface Pass {
  team: string;
  sector: string;
  /** The n-th pass of this sector (1-based). */
  n: number;
  start: number;
  arrive: number;
  end: number;
  pod: number;
  /** The seeded uniform draw; detected when the sector holds the subject and draw < pod. */
  draw: number;
  inside: boolean;
  detected: boolean;
  /** Re-tasked before the pass ended. */
  cut: boolean;
}

/** A uniform draw in [0, 1) fixed by the seed, the sector and the pass (mulberry32 over an FNV hash). */
export function draw(seed: string, sector: string, n: number): number {
  let h = 2166136261;
  for (const ch of `${seed}|${sector}|${n}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  let a = h;
  a = (a + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** One pass from its start: walk, sweep, detect (partway through the sweep, at draw/POD of it) or not. */
export function pass(seed: string, subject: Subject | null, team: string, sector: string, n: number, start: number): Pass {
  const u = draw(seed, sector, n);
  const inside = !!subject && subject.sector === sector;
  const detected = inside && u < TEAM_POD;
  const arrive = start + WALK_MS;
  return { team, sector, n, start, arrive, end: detected ? arrive + Math.round((SWEEP_MS * u) / TEAM_POD / 1000) * 1000 : arrive + SWEEP_MS, pod: TEAM_POD, draw: u, inside, detected, cut: false };
}

/** A recall (the console's Recall: a mission note with action "recall"): the team stops where it is and walks back. */
function recallOf(e: MissionEvent): string | null {
  if (e.type !== "mission.note") return null;
  const d = e.data as { action?: string; team?: string } | null;
  return d?.action === "recall" && d.team ? d.team : null;
}

/**
 * The visitor's assignments (task.updated to assigned, from their own events), as passes in time order. A
 * recall cuts the team's pass where it is (no find, no POD: it did not finish).
 */
export function passesFrom(seed: string, subject: Subject | null, user: readonly MissionEvent[]): Pass[] {
  const out: Pass[] = [];
  for (const e of [...user].sort((a, b) => a.at.localeCompare(b.at))) {
    const recalled = recallOf(e);
    if (recalled) {
      const at = new Date(e.at).getTime();
      for (const o of out) if (o.team === recalled && !o.cut && o.end > at) Object.assign(o, { end: at, cut: true, detected: false });
      continue;
    }
    if (e.type !== "task.updated") continue;
    const t = e.data as unknown as SectorTask | null;
    if (!t || t.state !== "assigned" || !t.team_id) continue;
    const start = new Date(e.at).getTime();
    // a team re-tasked leaves its earlier pass where it was
    for (const o of out) if (o.team === t.team_id && !o.cut && o.end > start) Object.assign(o, { end: start, cut: true, detected: false });
    const n = out.filter((o) => o.sector === t.sector_id && !o.cut).length + 1;
    out.push(pass(seed, subject, t.team_id, t.sector_id, n, start));
  }
  return out;
}

/** Each sector's probability after the passes that ended by `at` (each lowers it by its POD). */
export function poaAfter(poa: ReadonlyMap<string, number>, passes: readonly Pass[], at: number): Map<string, number> {
  const out = new Map(poa);
  for (const p of passes) if (!p.cut && !p.detected && p.end <= at) out.set(p.sector, (out.get(p.sector) ?? 0) * (1 - p.pod));
  return out;
}

/** The agent's next pick: the likeliest sector nobody is searching now. */
export function agentPick(poa: ReadonlyMap<string, number>, passes: readonly Pass[], at: number): string | null {
  const busy = new Set(passes.filter((p) => !p.cut && p.start <= at && p.end > at).map((p) => p.sector));
  const now = poaAfter(poa, passes, at);
  return [...now.entries()].filter(([s]) => !busy.has(s)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

export interface Line {
  passes: Pass[];
  /** When the subject is detected (ms), or null: suspended at last light. */
  found: number | null;
}

const isoOf = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");

/** An assignment as the console logs it (task.updated to assigned). */
export function assignmentEvent(id: string, team: string, sector: string, at: number, note: string | null = null): MissionEvent {
  const when = isoOf(at);
  return { id, type: "task.updated", at: when, summary: `sector ${sector}: assigned`, ref: sector, data: { sector_id: sector, state: "assigned", team_id: team, poa: 0, pod: null, note, updated_at: when } as never };
}

/**
 * Standing approval: from `from` on, whenever a pass ends with no find, that team and every team with
 * nothing to do go to the agent's next picks (assignment events of their own, `auto-…`), until a pass
 * detects the subject, the find is marked, or light runs out. Returns the events with them added.
 */
export function playStanding(seed: string, subject: Subject | null, poa: ReadonlyMap<string, number>, events: readonly MissionEvent[], teams: readonly string[], from: number, lastLight: number, stop: (e: MissionEvent) => boolean = () => false, kick = false, note = "the agent's pick, approved in turn"): MissionEvent[] {
  const out = [...events];
  // nothing is sent after the find is marked
  const until = Math.min(lastLight, ...events.filter(stop).map((e) => new Date(e.at).getTime()));
  // the approval itself sends every team that has nothing to do
  if (kick && from < until) {
    const passes = passesFrom(seed, subject, out);
    for (const team of teams) {
      if (passes.some((p) => p.team === team && !p.cut && p.end > from) || out.some((e) => e.id === `auto-${team}-${from}`)) continue;
      const sector = agentPick(poa, passesFrom(seed, subject, out), from);
      if (sector) out.push(assignmentEvent(`auto-${team}-${from}`, team, sector, from, note));
    }
  }
  for (let guard = 0; guard < 60; guard++) {
    const passes = passesFrom(seed, subject, out);
    if (passes.some((p) => p.detected && !p.cut)) break;
    const last = new Map<string, Pass>();
    for (const p of passes) if (!p.cut) last.set(p.team, p);
    const done = [...last.values()].filter((p) => !p.detected && p.end >= from && p.end < until).sort((a, b) => a.end - b.end || a.team.localeCompare(b.team))[0];
    if (!done) break;
    const at = done.end;
    const idle = teams.filter((t) => t === done.team || !passes.some((p) => p.team === t && !p.cut && p.end > at));
    let added = 0;
    for (const team of idle) {
      if (out.some((e) => e.id === `auto-${team}-${at}`)) continue;
      const sector = agentPick(poa, passesFrom(seed, subject, out), at);
      if (!sector) break;
      out.push(assignmentEvent(`auto-${team}-${at}`, team, sector, at, note));
      added += 1;
    }
    if (!added) break;
  }
  return out;
}

/**
 * The agent's own line through the same engine: its first assignment approved when proposed with every
 * other free team sent to its next picks at once (the guide's "send all"), then, after a pass with no
 * find, that team's next pick, until a pass detects the subject or light runs out.
 */
export function agentLine(seed: string, subject: Subject | null, first: { team: string; sector: string; at: number } | null, poa: ReadonlyMap<string, number>, lastLight: number, teams: readonly string[] = []): Line {
  if (!first) return { passes: [], found: null };
  const events = playStanding(seed, subject, poa, [assignmentEvent("agent-1", first.team, first.sector, first.at)], teams.length ? teams : [first.team], first.at, lastLight, () => false, true);
  const passes = passesFrom(seed, subject, events);
  const hit = passes.find((p) => p.detected && !p.cut);
  return { passes, found: hit && hit.end < lastLight ? hit.end : null };
}

/** A decision that took mission minutes: the fixtures' clock stood still at `f` for `ms`. */
export interface Cost {
  f: number;
  ms: number;
}

/** The fixtures' clock at mission clock `r` (it stands still through each cost). */
export function fixtureOf(r: number, costs: readonly Cost[]): number {
  let offset = 0;
  for (const c of [...costs].sort((a, b) => a.f - b.f)) {
    const start = c.f + offset;
    if (r <= start) return r - offset;
    if (r <= start + c.ms) return c.f;
    offset += c.ms;
  }
  return r - offset;
}

/** The mission clock of a fixture time `f` (after the costs before it). */
export function realOf(f: number, costs: readonly Cost[]): number {
  return f + costs.filter((c) => c.f < f).reduce((n, c) => n + c.ms, 0);
}
