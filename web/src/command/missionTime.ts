// Mission time on the demo mission: the one timeline the story and the console share. The demo mission
// is one set of fixtures (demoMission.ts) dated on one afternoon; this module says what of it is
// visible at a given mission clock, so the story's seven checkpoints are seven clock readings of the same
// mission, not seven screens. `demoAt(full, clock, user)` is pure: the console's store (`useMission`) is
// loaded with it whenever the scrubber moves. What the coach marks say at each checkpoint is in
// storyCopy.ts, read off the loaded scenario.

import type { Clue, FleetState, MapBase, MapUpdate, MissionEvent, Proposal, SectorTask, Team } from "../contract";
import type { SectorNow } from "../lib/api";
import { applyEvent, EMPTY, fleetLinksFromEvents, type MissionData } from "../lib/mission";
import { LiveHeat, lookedAt } from "../search/live";
import { agentPick, passesFrom, poaAfter, realOf, type Cost, type Pass, type Subject } from "./sim";

export type Checkpoint = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const CHECKPOINTS_ALL: readonly Checkpoint[] = [0, 1, 2, 3, 4, 5, 6];
/** The last checkpoint: the debrief, at the end of the timeline ("now"). */
export const LAST: Checkpoint = 6;

/** What the right-hand side of the console shows (the view switch). */
export type StoryView = "map" | "photos" | "debrief";

export interface CheckpointDef {
  t: Checkpoint;
  id: "call" | "photos" | "confirm" | "next" | "run" | "find" | "debrief";
  /** The scrubber's tick label. */
  label: string;
  /** The mission clock at this checkpoint (ISO, UTC as the fixtures are dated; shown in Vancouver time). */
  at: string;
  /** The view the story shows here. */
  view: StoryView;
}

const DAY = "2026-10-24T";
/** The survey flight: 500 photos land between these two times (the fixtures' photo.processed events). */
export const FLIGHT = { start: `${DAY}20:42:00Z`, end: `${DAY}21:18:00Z` } as const;
/** The planner seeds the task board from the map when the photos are in and reviewed. */
export const BOARD_AT = `${DAY}21:42:00Z`;
/** The drones leave the trailhead for their legs once the run is approved. */
export const FLEET_OUT = `${DAY}21:44:00Z`;
/** The end of the timeline: the fixtures' "now", half a minute after the find. */
export const NOW_AT = `${DAY}22:00:00Z`;
/** Where everyone waits before the run: the trailhead lot, where the subject's car is (the call). */
export const TRAILHEAD = { lat: 49.373, lon: -122.949 } as const;
/**
 * The overdue hiker's first assignment (scripts/make_command_fixtures.py; p001 is the second look's
 * promotion). The story itself never names it: it reads the loaded scenario's first assignment.
 */
export const STORY_PROPOSAL = "p002";
/** The sector it proposes (the fixture's; missionTime.test checks the two agree). */
export const STORY_SECTOR = "C2";

/**
 * The seven moments of the search. Every scenario keeps the overdue hiker's rhythm on the same afternoon
 * (scenarios.ts moves a generator fixture onto it), so the clock readings are the same for all of them:
 * the call, the survey's photos in, the review, the planner's tick, the run with the teams out, the find
 * (the fixtures put it at 21:59:30), and the end of the timeline.
 */
export const CHECKPOINTS: readonly CheckpointDef[] = [
  { t: 0, id: "call", label: "The call", at: `${DAY}20:35:00Z`, view: "map" },
  { t: 1, id: "photos", label: "Photos land", at: FLIGHT.end, view: "map" },
  { t: 2, id: "confirm", label: "Confirm", at: `${DAY}21:31:00Z`, view: "map" },
  { t: 3, id: "next", label: "Where next", at: BOARD_AT, view: "map" },
  { t: 4, id: "run", label: "Run", at: `${DAY}21:58:30Z`, view: "map" },
  { t: 5, id: "find", label: "The find", at: `${DAY}21:59:45Z`, view: "map" },
  { t: 6, id: "debrief", label: "Debrief", at: NOW_AT, view: "debrief" },
];

const ms = (iso: string) => new Date(iso).getTime();
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");

export function checkpoint(t: Checkpoint): CheckpointDef {
  return CHECKPOINTS[t] as CheckpointDef;
}

/**
 * The mission clock on the way into checkpoint `t`: `progress` 0 is the previous checkpoint's time, 1 is
 * t's own. t0 has no way in.
 */
export function clockAt(t: Checkpoint, progress = 1): string {
  const to = ms(checkpoint(t).at);
  if (t === 0 || progress >= 1) return iso(to);
  const from = ms(checkpoint((t - 1) as Checkpoint).at);
  return iso(from + (to - from) * Math.max(0, progress));
}

/** "?t=3" in a hash ("#m/demo?t=3") → 3; none or out of range → null. */
export function tFromHash(hash: string): Checkpoint | null {
  const q = hash.split("?")[1];
  if (!q) return null;
  const v = new URLSearchParams(q).get("t");
  if (v === null || !/^[0-6]$/.test(v)) return null;
  return Number(v) as Checkpoint;
}

/** The demo mission as loaded (demoMission.ts): everything up to the fixtures' "now". */
export interface DemoFull {
  data: Partial<MissionData>;
  now: string;
}

/** When a frame step lands: the 500 photos are spread evenly over the flight, in flight order. */
export function frameTime(index: number, count: number): number {
  const a = ms(FLIGHT.start);
  const b = ms(FLIGHT.end);
  return count <= 1 ? b : a + ((b - a) * index) / (count - 1);
}

/** When an update becomes visible: frames by flight order, the clues and ground searches at their own time. */
function updateTimes(updates: readonly MapUpdate[]): number[] {
  // the survey flight's photos are spread over the flight; a leg's photos (after it) land at their own time
  const legPhoto = (u: MapUpdate) => u.source === "frame" && ms(u.at) > ms(FLIGHT.end);
  const frames = updates.filter((u) => u.source === "frame" && !legPhoto(u)).length;
  let k = 0;
  return updates.map((u) => {
    if (u.source === "frame" && !legPhoto(u)) return frameTime(k++, frames);
    return ms(u.at);
  });
}

type LL = { lat: number; lon: number };
/** Where teams stage and drones launch and land: the mission's base camp (the trailhead lot by default). */
let HOME: LL = { ...TRAILHEAD };

const taskTime = (t: SectorTask) => ms(t.updated_at);
const eventTime = (e: MissionEvent) => ms(e.at);

/** A proposal as it stood at `c`: decided later → still pending. */
function proposalAt(p: Proposal, c: number): Proposal {
  if (!p.decided_at || ms(p.decided_at) <= c) return p;
  return { ...p, status: "pending", decided_at: null, decided_by: null, decision_reason: null, edits: null };
}

/** A team before it goes out: on standby at the trailhead since the call. */
function atTrailhead(t: Team): Team {
  return { ...t, status: "standby", position: { ...HOME }, position_at: checkpoint(0).at };
}

/** The point a fraction `f` (0..1) of the way along a path, by distance (flat earth; a few km). */
export function alongPath(path: readonly LL[], f: number): LL {
  if (path.length === 0) return { ...HOME };
  if (path.length === 1 || f <= 0) return { ...path[0]! };
  const k = Math.cos((path[0]!.lat * Math.PI) / 180);
  const d = (a: LL, b: LL) => Math.hypot(b.lat - a.lat, (b.lon - a.lon) * k);
  const segs = path.slice(1).map((b, i) => d(path[i]!, b));
  let left = Math.min(1, f) * segs.reduce((n, x) => n + x, 0);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (left <= s || i === segs.length - 1) {
      const t = s > 0 ? Math.min(1, left / s) : 1;
      const [a, b] = [path[i]!, path[i + 1]!];
      return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
    }
    left -= s;
  }
  return { ...path[path.length - 1]! };
}

/** How long a team takes to walk from the trailhead to where the fixtures last saw it (at least). */
const WALK_MS = 6 * 60_000;

/** Teams wait at the trailhead until their first task, then walk out to their last reported position. */
function teamsAt(teams: readonly Team[], tasks: readonly SectorTask[], c: number): Team[] {
  return teams.map((t) => {
    const own = tasks.filter((x) => x.team_id === t.id).map(taskTime);
    const out = own.length ? Math.min(...own) : Infinity;
    if (c < out || !t.position) return atTrailhead(t);
    const there = Math.max(out + WALK_MS, t.position_at ? ms(t.position_at) : 0);
    if (c >= there) return t;
    return { ...t, position: alongPath([HOME, t.position], (c - out) / (there - out)), position_at: iso(c) };
  });
}

/**
 * The fleet as it stood: none before the survey flight, landed at the trailhead after it, then from
 * FLEET_OUT each drone flies out to its leg and along it, reaching the fixtures' position at `end`.
 */
function fleetAt(fleet: FleetState | null | undefined, c: number, end: number): FleetState | null {
  if (!fleet) return null;
  if (c >= end) return fleet;
  if (c >= ms(FLEET_OUT)) {
    const f = (c - ms(FLEET_OUT)) / Math.max(1, end - ms(FLEET_OUT));
    return {
      ...fleet,
      drones: fleet.drones.map((d) => {
        if (!d.position) return d;
        const leg = fleet.legs.find((l) => l.id === d.leg_id);
        const wps = (leg?.waypoints ?? []).map(([lon, lat]) => ({ lat, lon }));
        // along the leg's sweep lines as far as the waypoint nearest where it ends up, then there
        const near = wps.reduce((best, w, i) => (Math.hypot(w.lat - d.position!.lat, w.lon - d.position!.lon) < Math.hypot(wps[best]!.lat - d.position!.lat, wps[best]!.lon - d.position!.lon) ? i : best), 0);
        const path = [{ ...HOME }, ...wps.slice(0, wps.length ? near + 1 : 0), d.position];
        return { ...d, status: "flying" as const, position: alongPath(path, f) };
      }),
    };
  }
  // before the survey flight nothing has flown: no drone on the map (no marker, no battery label) until t1
  if (c < ms(FLIGHT.start)) return { ...fleet, legs: [], drones: [] };
  // landed at the trailhead, the survey's photos off their cards; no leg yet
  return {
    ...fleet,
    legs: [],
    drones: fleet.drones.map((d) => ({ ...d, status: "idle", leg_id: null, position: { ...HOME } })),
  };
}

export { sectorCells } from "../search/sectorCells";
import { sectorCells } from "../search/sectorCells";

/** One incremental replay per map, so scrubbing forward applies only the new updates. */
const heatCache = new WeakMap<MapBase, LiveHeat>();

/** Each sector's POA and drone coverage on the map as it stood (the fixtures carry only "now"'s). */
export function sectorsAt(base: MapBase, sectors: readonly SectorNow[], updates: readonly MapUpdate[]): SectorNow[] {
  let heat = heatCache.get(base);
  if (!heat) {
    heat = new LiveHeat(base);
    heatCache.set(base, heat);
  }
  const { p } = heat.sync(updates);
  const looked = lookedAt(base, updates);
  const cells = sectorCells(base, sectors);
  return sectors.map((s) => {
    const own = cells.get(s.sector_id);
    if (!own?.length) return s;
    let poa = 0;
    let seen = 0;
    for (const i of own) {
      poa += p[i] ?? 0;
      seen += looked[i] ?? 0;
    }
    return { ...s, poa, drone_coverage: seen / own.length };
  });
}

/**
 * The demo mission as it stood at mission clock `clock`, with the visitor's own actions (`user`, events
 * the console made in demo mode) replayed on top where they had happened by then. Arrays keep the
 * fixtures' objects, so the map's incremental replay sees the same updates.
 */
export function demoAt(full: DemoFull, clock: string, user: readonly MissionEvent[] = [], guided: GuidedOpts | null = null): Partial<MissionData> {
  if (guided) return guidedAt(full, clock, user, guided);
  const d = full.data;
  const c = ms(clock);
  const now = c >= ms(full.now);
  HOME = d.mission?.base_camp ? { lat: d.mission.base_camp.lat, lon: d.mission.base_camp.lon } : { ...TRAILHEAD };
  // the find, and when each team was last heard, as they stood at the clock
  const found = d.mission?.found && ms(d.mission.found.at) <= c ? d.mission.found : null;
  const mission = d.mission ? { ...d.mission, found, status: found ? ("found" as const) : d.mission.status === "found" ? ("searching" as const) : d.mission.status } : d.mission;
  const heardBy = (t: Team): Team => (t.last_heard_at && ms(t.last_heard_at) > c ? { ...t, last_heard_at: null } : t);
  const allTasks = d.tasks ?? [];
  const allUpdates = d.mapUpdates ?? [];
  const times = updateTimes(allUpdates);
  const mapUpdates = now ? allUpdates : allUpdates.filter((_, i) => (times[i] as number) <= c);
  const tasks = now
    ? allTasks
    : c < ms(BOARD_AT)
      ? []
      : allTasks.map((t) => (taskTime(t) <= c ? t : { ...t, state: "proposed" as const, team_id: null, pod: null, note: null, updated_at: BOARD_AT }));
  const clues: Clue[] = (d.clues ?? []).filter((x) => ms(x.at) <= c);
  const proposals = (d.proposals ?? []).filter((p) => ms(p.created_at) <= c).map((p) => proposalAt(p, c));
  const events = (d.events ?? [])
    .filter((e) => eventTime(e) <= c)
    .sort((a, b) => a.at.localeCompare(b.at));
  const sectors = now || !d.mapBase ? (d.sectors ?? []) : sectorsAt(d.mapBase, d.sectors ?? [], mapUpdates);
  const base: MissionData = {
    ...EMPTY,
    ...d,
    mission: mission ?? null,
    tasks,
    teams: (now ? (d.teams ?? []).map((t) => (t.position ? t : atTrailhead(t))) : teamsAt(d.teams ?? [], allTasks, c)).map(heardBy),
    clues,
    proposals,
    fleet: now ? (d.fleet ?? null) : fleetAt(d.fleet, c, ms(full.now)),
    events,
    mapUpdates,
    sectors,
    verdicts: [],
    // the server's timeline, as it stood at the clock
    timeline: (d.timeline ?? []).filter((e) => ms(e.at) <= c),
    links: fleetLinksFromEvents(events),
  };
  return user.filter((e) => ms(e.at) <= c).reduce(applyEvent, base);
}

/** The checkpoint at or before a clock reading (where the scrubber's thumb sits). */
export function checkpointAtOrBefore(clock: string): Checkpoint {
  const c = ms(clock);
  let found: Checkpoint = 0;
  for (const cp of CHECKPOINTS) if (ms(cp.at) <= c) found = cp.t;
  return found;
}

// ---- The guided search (`?guide=1`): the same fixtures, the manager's decisions the visitor's ----
//
// The fixtures' own search manager steps aside after the board is seeded: every proposal waits for the
// visitor, the teams stay at base camp until the visitor assigns them, and the find happens only when a
// team the visitor sent detects the subject (sim.ts: a pass of the subject's sector at POD, a seeded
// draw) and the visitor marks it. The radio clue waits for its read-back and moves the map only once it
// is confirmed (never, when it is only logged).

/** What the guided search changes in the fixtures. */
export interface GuidedOpts {
  /** The scenario's seed: the draws. */
  seed: string;
  /** The clue the manager reads back (its radio call is in the fixtures; it waits for a decision). */
  readback?: string | null;
  /** The read-back clue moves the map (confirmed); false: logged only, or not decided yet. */
  mapClue?: boolean;
}

/** The subject's sector and position: the scenario's find (null: a scenario without one). */
export function subjectOf(full: DemoFull | null): Subject | null {
  const f = full?.data.mission?.found;
  return f?.sector ? { sector: f.sector, lat: f.lat, lon: f.lon } : null;
}

/** Each sector's probability as the agent ranks them (the fixtures' sectors). */
export function poaOf(full: DemoFull | null): Map<string, number> {
  return new Map((full?.data.sectors ?? []).map((s) => [s.sector_id, s.poa]));
}

/** The visitor's "found" (the store logs it as a mission note carrying the mission). */
export function isFoundEvent(e: MissionEvent): boolean {
  return e.type === "mission.note" && (e.data as { action?: string } | null)?.action === "found";
}

/** "C2" said on the radio: "Charlie Two". */
export function sectorSpoken(sector: string): string {
  const NATO: Record<string, string> = { A: "Alpha", B: "Bravo", C: "Charlie", D: "Delta", E: "Echo", F: "Foxtrot", G: "Golf", H: "Hotel" };
  const NUM = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
  const m = /^([A-Z])(\d)$/.exec(sector);
  return m ? `${NATO[m[1]!] ?? m[1]} ${NUM[Number(m[2])]}` : sector;
}

/** The fixtures' own manager: its decisions and the teams' moves, and after the board is seeded the teams' radio and the find. */
function managersOwn(e: MissionEvent): boolean {
  if (e.type === "proposal.decided" || e.type === "task.updated" || e.type === "team.updated") return true;
  const late = ms(e.at) > ms(BOARD_AT);
  if (e.type === "radio.turn") return late;
  // the fleet's own notes stay (legs, links); the teams' (position reports, relays, searched, the find) go
  return e.type === "mission.note" && !/^(Drone|D\d|L\d)/.test(e.summary) && (late || /Search manager|position report|assigned to sector|searched at POD/.test(e.summary));
}

function guidedAt(full: DemoFull, clock: string, user: readonly MissionEvent[], opts: GuidedOpts): Partial<MissionData> {
  const d = full.data;
  const c = ms(clock);
  HOME = d.mission?.base_camp ? { lat: d.mission.base_camp.lat, lon: d.mission.base_camp.lon } : { ...TRAILHEAD };
  const mission = d.mission ? { ...d.mission, found: null, status: d.mission.status === "found" ? ("searching" as const) : d.mission.status } : null;
  const held = (u: MapUpdate) => u.source === "ground" || (u.source === "clue" && !!opts.readback && u.ref === opts.readback && !opts.mapClue);
  const allUpdates = (d.mapUpdates ?? []).filter((u) => !held(u));
  const times = updateTimes(allUpdates);
  const mapUpdates = allUpdates.filter((_, i) => (times[i] as number) <= c);
  const tasks: SectorTask[] = c < ms(BOARD_AT) ? [] : (d.tasks ?? []).map((t) => ({ ...t, state: "proposed" as const, team_id: null, pod: null, note: null, updated_at: BOARD_AT }));
  const clues = (d.clues ?? []).filter((x) => ms(x.at) <= c).map((x) => (x.id === opts.readback ? { ...x, confirmed: false } : x));
  const proposals = (d.proposals ?? []).filter((p) => ms(p.created_at) <= c).map((p) => proposalAt(p, -Infinity));
  const events = (d.events ?? [])
    .filter((e) => eventTime(e) <= c && !managersOwn(e))
    // the read-back clue waits for the manager's decision in the log too
    .map((e) => (e.type === "clue.added" && e.ref === opts.readback && e.data ? { ...e, data: { ...(e.data as object), confirmed: false } as MissionEvent["data"] } : e))
    .sort((a, b) => a.at.localeCompare(b.at));
  // the manager's decisions, the teams' check-ins and the find are the visitor's now; after the board is seeded the teams' radio too
  const timeline = (d.timeline ?? []).filter((e) => ms(e.at) <= c && e.kind !== "decision" && e.kind !== "checkin" && e.kind !== "found" && !(ms(e.at) > ms(BOARD_AT) && e.kind === "radio"));
  const base: MissionData = {
    ...EMPTY,
    ...d,
    mission,
    tasks,
    teams: (d.teams ?? []).map((t) => ({ ...atTrailhead(t), last_heard_at: t.last_heard_at && ms(t.last_heard_at) <= Math.min(c, ms(BOARD_AT)) ? t.last_heard_at : null })),
    clues,
    proposals,
    fleet: fleetAt(d.fleet, c, ms(full.now)),
    events,
    mapUpdates,
    sectors: d.sectors ?? [],
    verdicts: [],
    timeline,
    links: fleetLinksFromEvents(events),
  };
  const mine = user.filter((e) => ms(e.at) <= c);
  const s = simulate(mine.reduce(applyEvent, base), full, mine, c, opts.seed);
  return { ...s, sectors: d.mapBase ? sectorsAt(d.mapBase, s.sectors, s.mapUpdates) : s.sectors };
}

/** Where a sector's teams walk to: the middle of its outline. */
function centreOf(sectors: readonly SectorNow[], id: string): LL | null {
  const ring = sectors.find((s) => s.sector_id === id)?.polygon?.slice(0, -1);
  if (!ring?.length) return null;
  return { lon: ring.reduce((a, p) => a + p[0], 0) / ring.length, lat: ring.reduce((a, p) => a + p[1], 0) / ring.length };
}

/** A pass with no find lowers its sector's cells at its POD, one update per pass (kept, so the map replays incrementally). */
const groundUpdates = new Map<string, MapUpdate>();
function groundUpdate(base: MapBase, sectors: readonly SectorNow[], p: Pass, seq: number): MapUpdate | null {
  const key = `${p.team}|${p.sector}|${p.start}|${seq}`;
  const hit = groundUpdates.get(key);
  if (hit) return hit;
  const cells = sectorCells(base, sectors).get(p.sector) ?? [];
  if (!cells.length) return null;
  const u: MapUpdate = { seq, kind: "step", source: "ground", ref: p.sector, cells: cells.map((i) => [i, p.pod] as [number, number]), at: iso(p.end) };
  groundUpdates.set(key, u);
  return u;
}

/**
 * The passes the visitor sent, played to the clock `c` (sim.ts): teams walk out and sweep; a pass that
 * detects the subject ends in the team's radio call (the visitor marks the find); a pass without a find
 * marks its sector searched at its POD, lowers it on the map, and the agent proposes its next pick to
 * that team. Pure apart from keeping the map updates it makes.
 */
export function simulate(s: MissionData, full: DemoFull, user: readonly MissionEvent[], c: number, seed: string): MissionData {
  const subject = subjectOf(full);
  const found = user.find(isFoundEvent);
  const all = passesFrom(seed, subject, user);
  const passes = all.filter((x) => x.start <= c);
  if (!passes.length) return s;
  const call = (id: string) => s.teams.find((t) => t.id === id)?.callsign ?? id;
  let teams = s.teams;
  let tasks = s.tasks;
  let proposals = s.proposals;
  const timeline = [...s.timeline];
  const mapUpdates = [...s.mapUpdates];
  const lastFor = new Map<string, Pass>();
  for (const x of passes) lastFor.set(x.team, x);
  let seq = 900_000;
  for (const x of passes) {
    seq += 1;
    // once the find is marked, the passes still out stop where they are
    const ended = !x.cut && x.end <= c && !(found && ms(found.at) < x.end);
    if (lastFor.get(x.team) === x) {
      const centre = centreOf(s.sectors, x.sector);
      const there = ended && x.detected && subject ? { lat: subject.lat, lon: subject.lon } : centre;
      const walked = there ? alongPath([HOME, there], (c - x.start) / WALK_MS) : null;
      const status: Team["status"] = ended ? (x.detected ? "searching" : "standby") : c >= x.arrive ? "searching" : "assigned";
      const heard = ended ? x.end : c >= x.arrive ? x.arrive : x.start;
      teams = teams.map((t) => (t.id === x.team ? { ...t, status, position: walked ?? t.position, position_at: iso(c), last_heard_at: iso(heard) } : t));
    }
    // the board: in progress once the team is there, searched at its POD when it reports no sign
    const own = (t: SectorTask) => t.sector_id === x.sector && t.team_id === x.team;
    if (!x.cut && c >= x.arrive) tasks = tasks.map((t) => (own(t) ? (ended && !x.detected ? { ...t, state: "searched" as const, pod: x.pod, updated_at: iso(x.end) } : { ...t, state: "in_progress" as const, updated_at: iso(x.arrive) }) : t));
    if (!ended) continue;
    const said = x.detected
      ? `Sightline, ${call(x.team)}. Subject located in ${sectorSpoken(x.sector)}, conscious and talking, over.`
      : `Sightline, ${call(x.team)}. ${sectorSpoken(x.sector)} searched, no sign of the subject, over.`;
    timeline.push({ id: `g-${x.team}-${x.start}`, at: iso(x.end), kind: "radio", team: x.team, sector: x.sector, text: said, direction: "in", refs: [], turn_id: null, drone: null, by: null });
    if (x.detected) continue;
    if (s.mapBase) {
      const u = groundUpdate(s.mapBase, s.sectors, x, seq);
      if (u) mapUpdates.push(u);
    }
    // no find: the agent proposes its next pick for the team, unless the visitor has already sent it on
    if (found || lastFor.get(x.team) !== x) continue;
    const pick = agentPick(poaOf(full), all, x.end);
    const id = `g${String(passes.indexOf(x) + 1).padStart(3, "0")}`;
    if (pick && !proposals.some((p) => p.id === id)) {
      const poa = poaAfter(poaOf(full), all, x.end).get(pick) ?? 0;
      proposals = [
        ...proposals,
        {
          id, kind: "assign_sector", status: "pending", created_by: "planner", created_at: iso(x.end), decided_at: null, decided_by: null, decision_reason: null, edits: null, evidence: [], briefing: null,
          target: { team: x.team, sector: pick },
          summary: `Assign sector ${pick} to ${call(x.team)}`,
          reason: `${x.sector} searched at POD ${x.pod.toFixed(2)} with no sign, so its probability drops; ${pick} is now the likeliest open sector (${(poa * 100).toFixed(1)} % POA) and ${call(x.team)} is free.`,
        },
      ];
    }
  }
  timeline.sort((a, b) => a.at.localeCompare(b.at));
  return { ...s, teams, tasks, timeline, proposals, mapUpdates };
}

/** The fixtures' times on the mission clock (sim.ts realOf): every time a panel prints, after the decisions' costs. */
export function onMissionClock(s: Partial<MissionData>, costs: readonly Cost[]): Partial<MissionData> {
  if (!costs.some((x) => x.ms > 0)) return s;
  const r = (at: string) => iso(realOf(ms(at), costs));
  const rn = (at: string | null | undefined) => (at ? r(at) : (at ?? null));
  return {
    ...s,
    mission: s.mission ? { ...s.mission, found: s.mission.found ? { ...s.mission.found, at: r(s.mission.found.at) } : s.mission.found } : s.mission,
    events: s.events?.map((e) => ({ ...e, at: r(e.at) })),
    timeline: s.timeline?.map((e) => ({ ...e, at: r(e.at) })),
    clues: s.clues?.map((x) => ({ ...x, at: r(x.at) })),
    proposals: s.proposals?.map((p) => ({ ...p, created_at: r(p.created_at), decided_at: rn(p.decided_at) })),
    tasks: s.tasks?.map((t) => ({ ...t, updated_at: r(t.updated_at) })),
    teams: s.teams?.map((t) => ({ ...t, position_at: rn(t.position_at), last_heard_at: rn(t.last_heard_at) })),
  };
}
