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
 * The overdue hiker's first assignment (scripts/make_command_fixtures.py; p001 and p002 are the second
 * look's promotions). The story itself never names it: it reads the loaded scenario's first assignment.
 */
export const STORY_PROPOSAL = "p003";
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
export function demoAt(full: DemoFull, clock: string, user: readonly MissionEvent[] = []): Partial<MissionData> {
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
