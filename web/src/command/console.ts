// The command post's arithmetic (COMMAND_POST.md §5), pure: how long the search has run, daylight left,
// flyability in one word, who is out, when each team was last heard and whether it is overdue, when a
// returning team is back, the resources in the order a search manager reads them, and what needs a person.
// Built by lane A.
import type { Clue, Conditions, Drone, FleetState, Mission, MissionEvent, Proposal, RadioTurn, SectorTask, Team, TimelineEvent } from "../contract";
import { clock, type Tz } from "../lib/time";
import type { FleetLinks } from "../lib/mission";
import { teamOf } from "./timeline";

const MIN = 60_000;
const ms = (iso: string) => new Date(iso).getTime();

/** "1 h 25 min", "25 min", "0 min". */
export function duration(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  return h ? `${h} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`;
}

/** Minutes since the mission was opened. */
export const elapsedMin = (mission: Pick<Mission, "created_at"> | null, now: Date) => (mission ? Math.max(0, (now.getTime() - ms(mission.created_at)) / MIN) : null);

/** Minutes of daylight left (to the end of civil twilight); null when unknown, 0 after dark. */
export function daylightMin(c: Conditions | null, now: Date): number | null {
  if (!c?.civil_twilight_end) return null;
  return Math.max(0, (ms(c.civil_twilight_end) - now.getTime()) / MIN);
}

/** Flyability in plain words with the gate time ("Drones can fly until 18:36"), its tone, and the reason (the tooltip). */
export function flyWord(c: Conditions | null, tz: Tz): { word: string; tone: "ok" | "alert" | "muted"; reason: string } {
  if (!c || c.flyable === null) return { word: "Drone flying: not known", tone: "muted", reason: c?.flyability_reason || "conditions not looked up yet" };
  if (!c.flyable) return { word: "Drones grounded", tone: "alert", reason: c.flyability_reason };
  return { word: c.flyable_until ? `Drones can fly until ${clock(c.flyable_until, tz)}` : "Drones can fly", tone: "ok", reason: c.flyability_reason };
}

const OUT: readonly Team["status"][] = ["assigned", "searching", "returning", "overdue"];
/** People in the field and the teams they are in. */
export function peopleOut(teams: readonly Team[]): { people: number; teams: number } {
  const out = teams.filter((t) => OUT.includes(t.status));
  return { people: out.reduce((n, t) => n + t.members, 0), teams: out.length };
}

/**
 * When a team was last heard: the newest of its `last_heard_at` (when the server sends it), its radio turns,
 * its check-ins (task and team updates, relayed positions) in the mission's events, and its radio calls and
 * check-ins in the server's timeline. Never its position. One clock for the row, Needs you, the toasts and
 * the bell (the cold test: a row "heard 0 min" while a toast said "not heard 45 min").
 */
export function lastHeard(team: Team, events: readonly MissionEvent[], timeline: readonly TimelineEvent[] = []): string | null {
  let best: string | null = team.last_heard_at ?? null;
  const newer = (at: string) => {
    if (!best || ms(at) > ms(best)) best = at;
  };
  for (const e of events) {
    const d = e.data as Record<string, unknown> | null;
    let mine = false;
    if (e.type === "team.updated") mine = e.ref === team.id;
    else if (e.type === "radio.turn") mine = (d as unknown as RadioTurn | null)?.direction === "in" && teamOf([team], (d as unknown as RadioTurn).callsign) === team.id;
    else if (e.type === "task.updated") mine = (d as { team_id?: string } | null)?.team_id === team.id && (d as { state?: string }).state !== "assigned";
    else if (e.type === "mission.note") mine = (d?.relay as { team_id?: string } | undefined)?.team_id === team.id;
    if (mine) newer(e.at);
  }
  for (const e of timeline) {
    if (teamOf([team], e.team) !== team.id) continue;
    // a call from the team, or a check-in (a relayed position counts; "no signal" is not hearing them)
    if ((e.kind === "radio" && e.direction === "in") || (e.kind === "checkin" && !/no signal/i.test(e.text))) newer(e.at);
  }
  return best;
}

export interface Heard {
  /** When the team was last heard (ISO; null: never). */
  at: string | null;
  /** Minutes since the team was last heard (null: never). */
  min: number | null;
  /** Past the mission's check-in interval. */
  overdue: boolean;
  /** Within ten minutes of it. */
  due: boolean;
}

export function heard(team: Team, events: readonly MissionEvent[], now: Date, checkInMin = 30, timeline: readonly TimelineEvent[] = []): Heard {
  const at = lastHeard(team, events, timeline);
  const min = at ? Math.max(0, (now.getTime() - ms(at)) / MIN) : null;
  const inField = OUT.includes(team.status);
  const overdue = team.status === "overdue" || (inField && min !== null && min > checkInMin);
  return { at, min, overdue, due: inField && !overdue && min !== null && min > checkInMin - 10 };
}

const WALK_M_PER_MIN = 50; // 3 km/h on a trail

/** Minutes until a team is back at base camp, only while it is returning: the server's (or the simulation's) ETA, else its distance on foot. */
export function etaMin(team: Team, base: { lat: number; lon: number } | null | undefined): number | null {
  if (team.status !== "returning") return null;
  if (team.eta_min !== undefined && team.eta_min !== null) return team.eta_min;
  if (!team.position || !base) return null;
  return Math.max(1, Math.round(metres(team.position, base) / WALK_M_PER_MIN));
}

/** Metres between two points (flat earth: a few km). */
export function metres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const k = Math.cos((b.lat * Math.PI) / 180);
  return Math.hypot(a.lat - b.lat, (a.lon - b.lon) * k) * 111_320;
}

/** Within this of base camp, a team is at base camp. */
export const AT_BASE_M = 150;
/** A free team is at base camp unless its position says it is out in the field (the map and the list agree). */
export const atBase = (team: Team, base: { lat: number; lon: number } | null | undefined): boolean => !team.position || !base || metres(team.position, base) <= AT_BASE_M;

/** A drone's legs so far: the current one's place among them ("leg 2/3"), the last done one when idle. */
export function legOf(d: Drone, fleet: FleetState | null): { n: number; m: number; id: string | null } {
  const legs = (fleet?.legs ?? []).filter((l) => l.drone_id === d.id && l.status !== "cancelled" && l.status !== "proposed");
  const i = legs.findIndex((l) => l.id === d.leg_id);
  return { n: i >= 0 ? i + 1 : legs.filter((l) => l.status === "done").length, m: legs.length, id: d.leg_id };
}

/**
 * A team's status as its tasks say it (the judges' Team Four: assigned C4 and B4, searching B4, and still
 * "Standby"): a team on standby with a task assigned to it is assigned; with one in progress, searching.
 * Overdue and returning stand as they are.
 */
export function withTaskStatus<T extends Team>(teams: readonly T[], tasks: readonly SectorTask[]): T[] {
  return teams.map((t) => {
    if (t.status !== "standby" && t.status !== "off_duty" && t.status !== "assigned") return t;
    const mine = tasks.filter((x) => x.team_id === t.id);
    if (mine.some((x) => x.state === "in_progress")) return { ...t, status: "searching" };
    if (t.status !== "assigned" && mine.some((x) => x.state === "assigned")) return { ...t, status: "assigned" };
    return t;
  });
}

/** The board's groups, in reading order: out in the field, then free, then off duty. */
const GROUP: Record<Team["status"], number> = { overdue: 0, searching: 0, assigned: 0, returning: 0, standby: 1, off_duty: 2 };

/**
 * Every team with when it was last heard, in a stable order (the cold test: rows re-sorted on every event):
 * by group (out, free, off duty), then the roster's order. A team moves only when it goes out or comes
 * back. The one computation the Resources rows, Needs you, the toasts and the bell all read.
 */
export function teamOrder(teams: readonly Team[], events: readonly MissionEvent[], now: Date, checkInMin = 30, timeline: readonly TimelineEvent[] = []): { team: Team; heard: Heard }[] {
  return teams
    .map((team, i) => ({ team, heard: heard(team, events, now, checkInMin, timeline), i }))
    .sort((a, b) => GROUP[a.team.status] - GROUP[b.team.status] || a.i - b.i)
    .map(({ team, heard: h }) => ({ team, heard: h }));
}

/** The teams past their check-in, longest not heard first (never heard counts as longest). */
export const overdueTeams = <T extends { heard: Heard }>(board: readonly T[]): T[] =>
  board.filter((x) => x.heard.overdue).sort((a, b) => (b.heard.min ?? 1e9) - (a.heard.min ?? 1e9));

export type Need =
  | { kind: "proposal"; id: string; proposal: Proposal }
  | { kind: "overdue"; id: string; team: Team; min: number | null; at: string | null }
  | { kind: "readback"; id: string; clue: Clue | null; turn: RadioTurn | null; team: string | null }
  | { kind: "review"; id: string; count: number };

/**
 * What needs a person (decisions only, never news): the agent's pending proposals, detections waiting for
 * review (`toReview`), overdue teams, clues awaiting read-back. Repeats merge: one card per team, per clue.
 */
export function needs(
  proposals: readonly Proposal[],
  teams: readonly Team[],
  events: readonly MissionEvent[],
  clues: readonly Clue[],
  now: Date,
  checkInMin = 30,
  toReview = 0,
  board: readonly { team: Team; heard: Heard }[] | null = null,
): Need[] {
  const out: Need[] = proposals
    .filter((p) => p.status === "pending")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((p) => ({ kind: "proposal", id: p.id, proposal: p }));
  if (toReview > 0) out.push({ kind: "review", id: "review", count: toReview });
  for (const { team, heard: h } of overdueTeams(board ?? teamOrder(teams, events, now, checkInMin))) out.push({ kind: "overdue", id: `overdue-${team.id}`, team, min: h.min, at: h.at });
  for (const c of clues) if (!c.confirmed) out.push({ kind: "readback", id: `clue-${c.id}`, clue: c, turn: null, team: teamOf(teams, c.reported_by) });
  // a radio call held for read-back: one card, and none once its clue is on the board (the clue's card, or
  // confirmed: the cold test's water bottle "confirmed" in the timeline and "holding" in Needs you)
  const latest = new Map<string, RadioTurn>();
  for (const e of events) if (e.type === "radio.turn" && e.data) latest.set((e.data as unknown as RadioTurn).id, e.data as unknown as RadioTurn);
  const linked = new Set(clues.map((c) => c.confirmed_by_turn).filter(Boolean));
  for (const t of latest.values()) if (t.state === "awaiting_confirm" && !linked.has(t.id)) out.push({ kind: "readback", id: `turn-${t.id}`, clue: null, turn: t, team: teamOf(teams, t.callsign) });
  return out;
}

/**
 * The probability outside the search grid ("rest of the world"): what the sectors do not hold. The sectors
 * tile the grid, so this is 1 − their POA; null with no sectors. The prior puts most of it outside on
 * purpose (a 1 km grid around the last known point; judges 2026-10-23: the POA summed to 25 % unexplained).
 */
export function outsideGrid(sectors: readonly { poa: number }[]): number | null {
  if (!sectors.length) return null;
  return Math.min(1, Math.max(0, 1 - sectors.reduce((n, s) => n + s.poa, 0)));
}

/** A team's radio words that report the subject ("Subject located in Charlie Two", "we found her"). */
export const REPORTS_SUBJECT = /\bsubject (?:located|found)\b|\bfound (?:him|her|them|the subject|the hiker|the child)\b|\bwe have (?:him|her|the subject)\b/i;

/**
 * The teams that reported the subject on the radio while the mission is not yet marked found: who, in which
 * sector (its task's, else none), and the words. Needs you offers Record find for each (judges 2026-10-23).
 * The server's timeline counts too: the guided search's teams report there (missionTime.ts simulate).
 */
export function sightingReports(events: readonly MissionEvent[], teams: readonly Team[], tasks: readonly { sector_id: string; state: string; team_id: string | null }[], timeline: readonly TimelineEvent[] = []): { team: Team; sector: string | null; words: string; at: string }[] {
  const out = new Map<string, { team: Team; sector: string | null; words: string; at: string }>();
  for (const e of timeline) {
    if (e.kind !== "radio" || e.direction !== "in" || !REPORTS_SUBJECT.test(e.text)) continue;
    const team = teams.find((x) => x.id === e.team);
    if (!team) continue;
    const task = tasks.find((x) => x.team_id === team.id && (x.state === "in_progress" || x.state === "assigned"));
    out.set(team.id, { team, sector: task?.sector_id ?? e.sector ?? null, words: e.text, at: e.at });
  }
  for (const e of events) {
    if (e.type !== "radio.turn") continue;
    const t = e.data as unknown as RadioTurn | null;
    if (!t || t.direction !== "in" || !REPORTS_SUBJECT.test(t.transcript)) continue;
    const id = teamOf(teams, t.callsign);
    const team = teams.find((x) => x.id === id);
    if (!team) continue;
    const task = tasks.find((x) => x.team_id === team.id && (x.state === "in_progress" || x.state === "assigned"));
    out.set(team.id, { team, sector: task?.sector_id ?? null, words: t.transcript.replace(/\s*\(typed for the demo fixture\)$/, ""), at: e.at });
  }
  return [...out.values()];
}

/** A sector holding a point (its outline, ray casting), or null. */
export function sectorAt(sectors: readonly { sector_id: string; polygon?: readonly (readonly number[])[] | null }[], at: { lat: number; lon: number }): string | null {
  for (const s of sectors) {
    const ring = s.polygon ?? [];
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = [ring[i]![0]!, ring[i]![1]!];
      const [xj, yj] = [ring[j]![0]!, ring[j]![1]!];
      if (yi > at.lat !== yj > at.lat && at.lon < ((xj - xi) * (at.lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return s.sector_id;
  }
  return null;
}

/**
 * The team to send to a point: the nearest one that can go (not off duty, not with the subject), free teams
 * before teams already out at an equal distance; a team with no position counts as at base camp.
 */
export function nearestTeam(teams: readonly Team[], at: { lat: number; lon: number }, base: { lat: number; lon: number } | null | undefined, not: readonly string[] = []): { team: Team; m: number } | null {
  const can = teams.filter((t) => t.status !== "off_duty" && !not.includes(t.id));
  const dist = (t: Team) => metres(t.position ?? base ?? at, at);
  const best = can.map((team) => ({ team, m: dist(team) })).sort((a, b) => a.m - b.m || Number(a.team.status !== "standby") - Number(b.team.status !== "standby"))[0];
  return best ?? null;
}

/** A reviewer's "Person" on a photo: a sighting clue (kind "sighting"), the newest first. */
export const sightings = (clues: readonly Clue[]): Clue[] => clues.filter((c) => c.kind === "sighting").sort((a, b) => b.at.localeCompare(a.at));

/** The subject's status before the find: "Possible sighting · 14:31" once a reviewer has marked a person, else "not found". */
export function subjectWord(clues: readonly Clue[], time: (iso: string) => string): string {
  const s = sightings(clues)[0];
  return s ? `Possible sighting · ${time(s.at)}` : "not found";
}

/** The agent's proposal to send a team to a sighting (missionTime.ts makes them): its id starts "sight-". */
export const isSightingProposal = (p: Pick<Proposal, "id">): boolean => p.id.startsWith("sight-");

/** The drone's link in one word. */
export const linkWord = (links: FleetLinks, id: string) => links.drones[id]?.link ?? "connected";
