// The command post's arithmetic (COMMAND_POST.md §5), pure: how long the search has run, daylight left,
// flyability in one word, who is out, when each team was last heard and whether it is overdue, when a
// returning team is back, the resources in the order a search manager reads them, and what needs a person.
// Built by lane A.
import type { Clue, Conditions, Drone, FleetState, Mission, MissionEvent, Proposal, RadioTurn, Team } from "../contract";
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

/** Flyability as one word with the gate time ("Flyable to 18:36"), its tone, and the reason (the tooltip). */
export function flyWord(c: Conditions | null, tz: Tz): { word: string; tone: "ok" | "alert" | "muted"; reason: string } {
  if (!c || c.flyable === null) return { word: "Flyability unknown", tone: "muted", reason: c?.flyability_reason || "conditions not looked up yet" };
  if (!c.flyable) return { word: "Not flyable", tone: "alert", reason: c.flyability_reason };
  return { word: c.flyable_until ? `Flyable to ${clock(c.flyable_until, tz)}` : "Flyable", tone: "ok", reason: c.flyability_reason };
}

const OUT: readonly Team["status"][] = ["assigned", "searching", "returning", "overdue"];
/** People in the field and the teams they are in. */
export function peopleOut(teams: readonly Team[]): { people: number; teams: number } {
  const out = teams.filter((t) => OUT.includes(t.status));
  return { people: out.reduce((n, t) => n + t.members, 0), teams: out.length };
}

/**
 * When a team was last heard: its `last_heard_at` when the server sends it, else the newest of its radio
 * turns, its check-ins (task and team updates, relayed positions) in the mission's events. Never its position.
 */
export function lastHeard(team: Team, events: readonly MissionEvent[]): string | null {
  if (team.last_heard_at) return team.last_heard_at;
  let best: string | null = null;
  for (const e of events) {
    const d = e.data as Record<string, unknown> | null;
    let mine = false;
    if (e.type === "team.updated") mine = e.ref === team.id;
    else if (e.type === "radio.turn") mine = (d as unknown as RadioTurn | null)?.direction === "in" && teamOf([team], (d as unknown as RadioTurn).callsign) === team.id;
    else if (e.type === "task.updated") mine = (d as { team_id?: string } | null)?.team_id === team.id && (d as { state?: string }).state !== "assigned";
    else if (e.type === "mission.note") mine = (d?.relay as { team_id?: string } | undefined)?.team_id === team.id;
    if (mine && (!best || e.at > best)) best = e.at;
  }
  return best;
}

export interface Heard {
  /** Minutes since the team was last heard (null: never). */
  min: number | null;
  /** Past the mission's check-in interval. */
  overdue: boolean;
  /** Within ten minutes of it. */
  due: boolean;
}

export function heard(team: Team, events: readonly MissionEvent[], now: Date, checkInMin = 30): Heard {
  const at = lastHeard(team, events);
  const min = at ? Math.max(0, (now.getTime() - ms(at)) / MIN) : null;
  const inField = OUT.includes(team.status);
  const overdue = team.status === "overdue" || (inField && min !== null && min > checkInMin);
  return { min, overdue, due: inField && !overdue && min !== null && min > checkInMin - 10 };
}

const WALK_M_PER_MIN = 50; // 3 km/h on a trail

/** Minutes until a team is back at base camp: the server's ETA, else its distance on foot when it is returning. */
export function etaMin(team: Team, base: { lat: number; lon: number } | null | undefined): number | null {
  if (team.eta_min !== undefined && team.eta_min !== null) return team.eta_min;
  if (team.status !== "returning" || !team.position || !base) return null;
  const k = Math.cos((base.lat * Math.PI) / 180);
  const m = Math.hypot(team.position.lat - base.lat, (team.position.lon - base.lon) * k) * 111_320;
  return Math.max(1, Math.round(m / WALK_M_PER_MIN));
}

/** A drone's legs so far: the current one's place among them ("leg 2/3"), the last done one when idle. */
export function legOf(d: Drone, fleet: FleetState | null): { n: number; m: number; id: string | null } {
  const legs = (fleet?.legs ?? []).filter((l) => l.drone_id === d.id && l.status !== "cancelled" && l.status !== "proposed");
  const i = legs.findIndex((l) => l.id === d.leg_id);
  return { n: i >= 0 ? i + 1 : legs.filter((l) => l.status === "done").length, m: legs.length, id: d.leg_id };
}

/** Teams most overdue first (never heard counts as most), then drones by lowest battery. */
export function teamOrder(teams: readonly Team[], events: readonly MissionEvent[], now: Date, checkInMin = 30): { team: Team; heard: Heard }[] {
  return teams
    .map((team) => ({ team, heard: heard(team, events, now, checkInMin) }))
    .sort((a, b) => Number(b.heard.overdue) - Number(a.heard.overdue) || (b.heard.min ?? 1e9) - (a.heard.min ?? 1e9));
}

export type Need =
  | { kind: "proposal"; id: string; proposal: Proposal }
  | { kind: "overdue"; id: string; team: Team; min: number | null }
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
): Need[] {
  const out: Need[] = proposals
    .filter((p) => p.status === "pending")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((p) => ({ kind: "proposal", id: p.id, proposal: p }));
  if (toReview > 0) out.push({ kind: "review", id: "review", count: toReview });
  for (const { team, heard: h } of teamOrder(teams, events, now, checkInMin)) if (h.overdue) out.push({ kind: "overdue", id: `overdue-${team.id}`, team, min: h.min });
  const seen = new Set<string>();
  for (const c of clues) if (!c.confirmed) {
    seen.add(c.id);
    out.push({ kind: "readback", id: `clue-${c.id}`, clue: c, turn: null, team: teamOf(teams, c.reported_by) });
  }
  const turns = events.filter((e) => e.type === "radio.turn").map((e) => e.data as unknown as RadioTurn).filter((t) => t?.state === "awaiting_confirm");
  for (const t of turns) out.push({ kind: "readback", id: `turn-${t.id}`, clue: null, turn: t, team: teamOf(teams, t.callsign) });
  return out;
}

/** The drone's link in one word. */
export const linkWord = (links: FleetLinks, id: string) => links.drones[id]?.link ?? "connected";
