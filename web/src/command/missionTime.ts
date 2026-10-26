// Mission time on the demo mission: the one timeline the story and the console share. The demo mission
// is one set of fixtures (demoMission.ts) dated on one afternoon; this module says what of it is
// visible at a given mission clock, so the story's seven checkpoints are seven clock readings of the same
// mission, not seven screens. `demoAt(full, clock, user)` is pure: the console's store (`useMission`) is
// loaded with it whenever the scrubber moves. What the coach marks say at each checkpoint is in
// storyCopy.ts, read off the loaded scenario.

import type { Clue, Conditions, FleetState, MapBase, MapUpdate, MissionEvent, Proposal, SectorTask, Team, TimelineEvent } from "../contract";
import type { SectorNow } from "../lib/api";
import { applyEvent, EMPTY, fleetLinksFromEvents, type MissionData } from "../lib/mission";
import { teamOf } from "./timeline";
import { LiveHeat, lookedAt } from "../search/live";
import { agentPick, passesFrom, poaAfter, realOf, RETURN_MS, SWEEP_MS, type Cost, type Pass, type Subject } from "./sim";
import { flightNotes, flights, fleetNow, legPhotos, legSortie, surveySorties, userSorties, type Sortie } from "./fleetSim";
import { committed, metres, nearestTeam, sectorAt, sightings } from "./console";

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

/** On foot on a trail: 3 km/h. */
const WALK_M_PER_MS = 50 / 60_000;
const MIN_MS = 60_000;

/** Where a team is and how it is at one moment (the map and the Resources row read the same one). */
export interface Place {
  status: Team["status"];
  pos: LL;
  /** When it was last heard (ms). */
  heard: number;
  /** Minutes until it is back at base camp (returning only). */
  eta: number | null;
  note?: string | null;
}

/** A hasty team's radio check-in, every this often while it is out. */
export const HASTY_CHECKIN_MS = 20 * MIN_MS;

/**
 * A team that radioed clues before the board was seeded was out on a hasty search: it went out along the
 * trail at the call, was where each clue was when it called it in, radioed its position every 20 minutes,
 * then walked back (the cold test: teams radioed clues while the list said "Free · at base camp").
 */
function hastyTrip(team: Pick<Team, "id" | "callsign">, clues: readonly Clue[]): { leave: number; stops: { at: number; pos: LL }[]; back: number; checkins: number[] } | null {
  const visits = clues
    .filter((c) => c.reported_by !== "command" && teamOf([{ id: team.id, callsign: team.callsign }], c.reported_by) === team.id && ms(c.at) <= ms(BOARD_AT))
    .sort((a, b) => a.at.localeCompare(b.at));
  if (!visits.length) return null;
  const stops = visits.map((c) => ({ at: ms(c.at), pos: { lat: c.lat, lon: c.lon } }));
  // sent out on the trail at the call, before the manager takes over (or in time to reach its first clue)
  const leave = Math.min(ms(CHECKPOINTS[0]!.at), stops[0]!.at - metres(HOME, stops[0]!.pos) / WALK_M_PER_MS);
  const last = stops.at(-1)!;
  const back = last.at + metres(last.pos, HOME) / WALK_M_PER_MS;
  const checkins: number[] = [];
  for (let t = leave + HASTY_CHECKIN_MS; t < back; t += HASTY_CHECKIN_MS) checkins.push(t);
  return { leave, stops, back, checkins };
}

/** The teams the scenario sent on a hasty search before the visitor took over, and when each left. */
export function hastyLeaves(full: DemoFull | null): { team: Team; leave: number }[] {
  const teams = full?.data.teams ?? [];
  return teams.flatMap((t) => {
    const trip = hastyTrip(t, full?.data.clues ?? []);
    return trip ? [{ team: t, leave: trip.leave }] : [];
  });
}

/** How a scenario's own move before the visitor took over is said in the log. */
export const PRE_PLANNED = "pre-planned in the scenario, before you took over";

/** Where a hasty team is at `t` (null: at base camp then). */
export function hastyAt(team: Pick<Team, "id" | "callsign">, clues: readonly Clue[], t: number): Place | null {
  const trip = hastyTrip(team, clues);
  if (!trip || t < trip.leave || t >= trip.back) return null;
  const { leave, stops, back } = trip;
  const heard = Math.max(leave, ...trip.checkins.filter((x) => x <= t), ...stops.map((s) => s.at).filter((x) => x <= t));
  if (t < stops[0]!.at) return { status: "searching", pos: alongPath([HOME, stops[0]!.pos], (t - leave) / Math.max(1, stops[0]!.at - leave)), heard, eta: null, note: "hasty search" };
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, b] = [stops[i]!, stops[i + 1]!];
    if (t < b.at) return { status: "searching", pos: alongPath([a.pos, b.pos], (t - a.at) / Math.max(1, b.at - a.at)), heard, eta: null, note: "hasty search" };
  }
  const last = stops.at(-1)!;
  return { status: "returning", pos: alongPath([last.pos, HOME], (t - last.at) / Math.max(1, back - last.at)), heard, eta: Math.max(1, Math.ceil((back - t) / MIN_MS)), note: null };
}

/** The hasty teams' going out and their check-ins as timeline rows, up to `c` (what the row's "heard N min" counts). */
export function hastyRows(teams: readonly Team[], clues: readonly Clue[], c: number, sentAt: (team: string) => number = () => Infinity): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const t of teams) {
    const trip = hastyTrip(t, clues);
    if (!trip) continue;
    // sent on to a sector before it was back: the hasty search ends there
    const until = Math.min(c, sentAt(t.id));
    const row = (at: number, text: string, i: number): TimelineEvent => ({ id: `hasty-${t.id}-${i}`, at: iso(at), kind: "checkin", team: t.id, sector: null, text, direction: null, refs: [], turn_id: null, drone: null, by: null });
    if (trip.leave <= until) out.push(row(trip.leave, `${t.callsign} out on a hasty search along the trail (${PRE_PLANNED})`, 0));
    trip.checkins.forEach((x, i) => x <= until && out.push(row(x, `${t.callsign}: position report (hasty search)`, i + 1)));
    // its walk home says why (the cold test: teams went back while a sighting waited, with nothing logged)
    const last = trip.stops.at(-1)!;
    if (last.at <= until && trip.back > last.at) out.push(row(last.at + 1000, `${t.callsign} heads back to base camp: the hasty search along the trail is done (${PRE_PLANNED})`, 98));
    if (trip.back <= until) out.push(row(trip.back, `${t.callsign} back at base camp`, 99));
  }
  return out;
}

/** A team as a place says. */
const placed = (t: Team, p: Place, c: number): Team => ({
  ...t,
  status: p.status,
  position: p.pos,
  position_at: iso(c),
  last_heard_at: t.last_heard_at && ms(t.last_heard_at) > p.heard && ms(t.last_heard_at) <= c ? t.last_heard_at : iso(p.heard),
  eta_min: p.eta,
  note: p.note ?? null,
});

/** Teams wait at the trailhead until their first task (or go out on a hasty search), then walk out to their last reported position. */
function teamsAt(teams: readonly Team[], tasks: readonly SectorTask[], c: number, clues: readonly Clue[] = []): Team[] {
  return teams.map((t) => {
    const own = tasks.filter((x) => x.team_id === t.id).map(taskTime);
    const out = own.length ? Math.min(...own) : Infinity;
    if (c < out || !t.position) {
      const hasty = hastyAt(t, clues, c);
      return hasty ? placed(atTrailhead(t), hasty, c) : atTrailhead(t);
    }
    const there = Math.max(out + WALK_MS, t.position_at ? ms(t.position_at) : 0);
    if (c >= there) return t;
    return { ...t, position: alongPath([HOME, t.position], (c - out) / (there - out)), position_at: iso(c) };
  });
}

/** The fixtures' flights: the survey (FLIGHT), then each leg from when it started (its "started" note), until its "done" note or its own minutes. */
const fixtureFlights = new WeakMap<object, Sortie[]>();
function fixtureSorties(d: Partial<MissionData>, by: string): Sortie[] {
  const key = d.fleet as object | undefined;
  if (!key || !d.fleet) return [];
  const hit = fixtureFlights.get(key);
  if (hit) return hit;
  const fleet = d.fleet;
  const events = d.events ?? [];
  const timeOf = (re: RegExp) => events.find((e) => re.test(e.summary))?.at ?? null;
  const out: Sortie[] = surveySorties(fleet.drones, d.sectors ?? [], ms(FLIGHT.start), ms(FLIGHT.end), HOME);
  for (const l of fleet.legs.filter((x) => x.status !== "proposed")) {
    const started = timeOf(new RegExp(`leg ${l.id} .*started`)) ?? timeOf(new RegExp(`^${l.id} approved`)) ?? FLEET_OUT;
    const done = timeOf(new RegExp(`leg ${l.id} .*done`));
    const drone = fleet.drones.find((x) => x.id === l.drone_id);
    const speed = Math.max(1, drone?.speed_ms ?? 8);
    const first = l.waypoints[0];
    const outMs = first ? (metres(HOME, { lat: first[1], lon: first[0] }) / speed) * 1000 : 0;
    out.push(legSortie(l, ms(started), by, done ? ms(done) - outMs : null, speed));
  }
  fixtureFlights.set(key, out);
  return out;
}

/**
 * The fleet as it stood at `c` (fleetSim.ts): no drone before the survey flight, the survey flight, landed
 * and swapped at base camp, then the legs from when each started: out, the sweep, back, landed; with the
 * manager's own legs and recalls (`user`, null: the console's own flights are wall-clock, the clock pinned).
 * The fleet's own notes for each leg's end and landing, and the photos the manager's legs take, come with it.
 */
export function fleetAt(d: Partial<MissionData>, c: number, user: readonly MissionEvent[] | null, by = "the search manager", stopAt: number | null = null): { fleet: FleetState | null; notes: MissionEvent[]; photos: MapUpdate[]; skipped: Set<string> } {
  const fleet = d.fleet;
  const skipped = new Set<string>();
  if (!fleet) return { fleet: null, notes: [], photos: [], skipped };
  // before the survey flight nothing has flown: no drone on the map (no marker, no battery label) until t1
  if (c < ms(FLIGHT.start)) return { fleet: { ...fleet, legs: [], drones: [] }, notes: [], photos: [], skipped };
  const mine = user ? userSorties(user.filter((e) => ms(e.at) <= c)) : [];
  // a scenario leg for a drone the manager has in the air on a leg of their own is not flown: theirs stands
  const own = flights(fleet.drones, mine, HOME);
  for (const x of fixtureSorties(d, by)) if (x.kind === "leg" && x.leg && own.some((f) => f.sortie.drone === x.drone && f.sortie.start <= x.start && f.landed > x.start)) skipped.add(x.leg);
  // (after the find no scenario flight line starts: the drones are on their way home)
  const sorties = [...fixtureSorties(d, by).filter((x) => (!x.leg || !skipped.has(x.leg)) && (stopAt === null || x.start <= stopAt)), ...mine].filter((x) => x.start <= c);
  const all = flights(fleet.drones, sorties, HOME);
  const userLegs = (user ?? []).flatMap((e) => (e.type === "fleet.updated" && ms(e.at) <= c ? ((e.data as unknown as FleetState | null)?.legs ?? []).filter((l) => mine.some((m) => m.leg === l.id)) : []));
  const legs = [...fleet.legs.filter((l) => !skipped.has(l.id)), ...userLegs.filter((l, i) => userLegs.findIndex((x) => x.id === l.id) === i && !fleet.legs.some((x) => x.id === l.id))];
  const now = fleetNow(fleet, all, c, HOME, legs);
  const notes = flightNotes(all, fleet.drones, c, d.events ?? []);
  const photos = d.mapBase && user ? all.filter((f) => mine.includes(f.sortie)).flatMap((f) => legPhotos(d.mapBase!, f)).filter((u) => ms(u.at) <= c) : [];
  return { fleet: now, notes, photos, skipped };
}

/** The fleet's own notes (a leg's sweep done, a drone back at base camp) as timeline rows at their own times. */
const noteRows = (notes: readonly MissionEvent[]): TimelineEvent[] =>
  notes.map((n) => ({ id: n.id, at: n.at, kind: "drone", team: null, sector: null, text: n.summary, direction: null, refs: n.ref ? [n.ref] : [], turn_id: null, drone: null, by: null }));

/** A fleet event or note about a scenario leg that was not flown (the manager's own leg had the drone). */
const aboutSkipped = (e: MissionEvent, skipped: ReadonlySet<string>) => skipped.size > 0 && [...skipped].some((id) => new RegExp(`(^|leg |re-task: )${id}\\b`).test(e.summary));

/** The fixtures' fleet approvals named: "L001 approved for Drone 1" said who approved it. */
function approver(e: MissionEvent, who: string): MissionEvent {
  if (e.type !== "fleet.updated" || !/^L\d+ approved for /.test(e.summary) || / by |auto-approved/.test(e.summary)) return e;
  // the fixture's words kept (plainWords turns them into "Drone 1: flight line approved"), who said after them
  return { ...e, summary: `${e.summary.replace(/ \(simulated fleet\)$/, "")} (${who})` };
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

export interface DemoOptions {
  /**
   * The visitor decides (guided or playing; judges 2026-10-23: p003 and p004 were approved "by Search
   * manager" with no click): the scenario's own approvals are held, their proposals stay pending, and what
   * followed from them (the team's tasks, its walk out, its radio, the find it made) does not happen unless
   * the visitor assigns the team; then the guided search's engine plays it (sim.ts via `simulate`: the walk,
   * the sweep, the seeded draw at POD, the find or the sector searched). One engine for both modes.
   */
  hold?: boolean;
  /** The draws' seed (the scenario's), with `hold`. */
  seed?: string;
}

/**
 * The demo mission as it stood at mission clock `clock`, with the visitor's own actions (`user`, events
 * the console made in demo mode) replayed on top where they had happened by then. Arrays keep the
 * fixtures' objects, so the map's incremental replay sees the same updates. A proposal the visitor
 * decided is theirs alone: the scenario's own decision of it is not shown as well (it was logged twice).
 */
export function demoAt(full: DemoFull, clock: string, user: readonly MissionEvent[] = [], guided: GuidedOpts | null = null, opts: DemoOptions = {}): Partial<MissionData> {
  if (guided) return guidedAt(full, clock, user, guided);
  const c = ms(clock);
  const d = holdFor(full.data, user, c, opts);
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
  const fly = fleetAt(d, c, opts.hold ? user : null);
  const events = [...(d.events ?? []).filter((e) => eventTime(e) <= c && !aboutSkipped(e, fly.skipped)).map((e) => approver(e, "by the search manager"))]
    .sort((a, b) => a.at.localeCompare(b.at));
  // every reading from the same map log, the end of the timeline too (the fixture's own "now" POA came from
  // the server before the last legs and searches were applied: B1 jumped 0.4 → 1.6 % at 15:00, judges 2026-10-23)
  const sectors = !d.mapBase ? (d.sectors ?? []) : sectorsAt(d.mapBase, d.sectors ?? [], mapUpdates);
  const base: MissionData = {
    ...EMPTY,
    ...d,
    mission: mission ?? null,
    conditions: now ? (conditionsAt(d, Infinity) ?? d.conditions ?? null) : conditionsAt(d, c),
    tasks,
    teams: (now ? (d.teams ?? []).map((t) => (t.position ? t : atTrailhead(t))) : teamsAt(d.teams ?? [], allTasks, c, d.clues ?? [])).map(heardBy),
    clues,
    proposals,
    fleet: now && !opts.hold ? (d.fleet ?? null) : fly.fleet,
    events,
    mapUpdates,
    sectors,
    verdicts: [],
    // the server's timeline, as it stood at the clock
    timeline: [
      ...(d.timeline ?? [])
        .filter((e) => ms(e.at) <= c && !aboutSkipped({ summary: e.text } as MissionEvent, fly.skipped))
        .map((e) => (e.kind === "drone" ? { ...e, text: approver({ type: "fleet.updated", summary: e.text } as MissionEvent, "by the search manager").summary } : e)),
      ...(now ? [] : hastyRows(d.teams ?? [], d.clues ?? [], c, (id) => Math.min(...allTasks.filter((x) => x.team_id === id).map(taskTime)))),
      ...(now ? [] : noteRows(fly.notes)),
    ].sort((a, b) => a.at.localeCompare(b.at)),
    links: fleetLinksFromEvents(events),
  };
  const mine = user.filter((e) => ms(e.at) <= c);
  const out = mine.reduce(applyEvent, base);
  if (!opts.hold) return out;
  // the visitor's assignments play through the guided search's engine
  const sim = simulate(out, full, mine, c, opts.seed ?? "demo");
  // the manager's legs fly by the clock (fleetSim.ts), their photos lowering the map as they are taken
  const played = { ...sim, fleet: fly.fleet ?? sim.fleet, mapUpdates: [...sim.mapUpdates, ...fly.photos] };
  return rankPending(played, d.mapBase ? sectorsAt(d.mapBase, played.sectors, played.mapUpdates) : played.sectors);
}

const decidedBy = (user: readonly MissionEvent[], c: number) => new Set(user.filter((e) => e.type === "proposal.decided" && ms(e.at) <= c && e.ref).map((e) => e.ref as string));

/**
 * The fixtures with what the visitor decides taken out of the scenario's hands: a proposal the visitor
 * decided loses the scenario's decision of it; with `hold`, every proposal the scenario decided by itself
 * is pending and what followed from it is gone. Pure.
 */
export function holdFor(d: Partial<MissionData>, user: readonly MissionEvent[], c: number, opts: DemoOptions = {}): Partial<MissionData> {
  const mine = decidedBy(user, c);
  const held = new Set((d.proposals ?? []).filter((p) => p.decided_at && (mine.has(p.id) || (opts.hold && p.status !== "pending"))).map((p) => p.id));
  if (!held.size) return d;
  // a held assignment: the team and sector it sent, and from when
  const heldAssign = (d.proposals ?? []).filter((p) => opts.hold && held.has(p.id) && !mine.has(p.id) && p.kind === "assign_sector" && p.target.team && p.target.sector);
  const heldTeams = new Map(heldAssign.map((p) => [p.target.team as string, ms(p.decided_at as string)]));
  const heldSectors = new Set(heldAssign.map((p) => `${p.target.team}|${p.target.sector}`));
  const teamOfEvent = (e: { team?: string | null; ref?: string | null; data?: unknown; type?: string }) => {
    const x = e.data as Record<string, unknown> | null | undefined;
    return (e.team ?? (x?.team_id as string | undefined) ?? (e.type === "team.updated" ? e.ref : null) ?? null) as string | null;
  };
  const afterHeld = (team: string | null, at: string) => team !== null && heldTeams.has(team) && ms(at) >= heldTeams.get(team)!;
  const found = d.mission?.found;
  const findHeld = !!found && heldTeams.has(found.team);
  const decidedHere = (refs: readonly (string | null | undefined)[]) => refs.some((r) => r && held.has(r));
  const subjectLine = (text: string) => /subject located|subject found/i.test(text);
  const events = (d.events ?? []).filter((e) => {
    if (e.type === "proposal.decided" && e.ref && held.has(e.ref)) return false;
    if (afterHeld(teamOfEvent({ ...e, team: null }), e.at)) return false;
    if (e.type === "radio.turn" && afterHeld(teamOf(d.teams ?? [], (e.data as { callsign?: string } | null)?.callsign), e.at)) return false;
    if (findHeld && (((e.data as { action?: string } | null)?.action === "found") || subjectLine(e.summary) || (e.type === "radio.turn" && subjectLine(JSON.stringify(e.data ?? ""))))) return false;
    return true;
  });
  const timeline = (d.timeline ?? []).filter((e) => {
    if (e.kind === "decision" && decidedHere(e.refs ?? [])) return false;
    if (afterHeld(teamOf(d.teams ?? [], e.team ?? null), e.at)) return false;
    if (findHeld && (e.kind === "found" || subjectLine(e.text))) return false;
    return true;
  });
  const proposals = (d.proposals ?? []).map((p) => (held.has(p.id) ? { ...p, status: "pending" as const, decided_at: null, decided_by: null, decision_reason: null, edits: null } : p));
  const tasks = (d.tasks ?? []).map((t) => (t.team_id && heldSectors.has(`${t.team_id}|${t.sector_id}`) ? { ...t, state: "proposed" as const, team_id: null, pod: null, note: null } : t));
  const teams = (d.teams ?? []).map((t) => (heldTeams.has(t.id) ? { ...t, position: null, position_at: null, status: "standby" as const, last_heard_at: null } : t));
  const mission = d.mission && findHeld ? { ...d.mission, found: null, status: "searching" as const } : d.mission;
  return { ...d, events, timeline, proposals, tasks, teams, mission };
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
  /** The survey decision (the flight lines' approver in the log): the AI's lines or the lawnmower, and by whom. */
  survey?: { option: string; watched: boolean } | null;
  /**
   * The drones stay on the ground: the conditions at the call grounded them and nobody chose "Fly anyway".
   * No survey flies, no photo lands, no flight line or relay is proposed; the ground teams carry the search.
   * `recheck` is when the wind is looked at again (fixtures' clock, ms).
   */
  dronesWait?: { recheck: number } | null;
}

/**
 * Who approved the scenario's flight lines, in the log's words: the guided survey only when the visitor (or
 * Watch instead) chose the AI's flight lines; else they were pre-planned in the scenario.
 */
export function legApprover(survey: GuidedOpts["survey"]): string {
  if (survey?.option === "planner") return survey.watched ? "auto-approved: guided survey, Watch instead chose the AI's flight lines" : "auto-approved: guided survey, you chose the AI's flight lines";
  // the lawnmower pattern is the visitor's choice too (round 3: its lines said "pre-planned in the scenario")
  if (survey?.option === "serpentine") return survey.watched ? "auto-approved: guided survey, Watch instead chose the lawnmower pattern" : "auto-approved: guided survey, you chose the lawnmower pattern";
  // "Fly anyway": the AI's flight lines flown on the manager's override of the grounding
  if (survey?.option === "override") return survey.watched ? "approved on an override of the grounding, Watch instead chose it" : "approved on your override of the grounding";
  return PRE_PLANNED;
}

/** A drone's own line in the fixtures (its flight lines, its link, a relay through it, the survey's photos and their review). */
function aboutDrones(e: MissionEvent): boolean {
  if (e.type === "fleet.updated" || e.type === "photo.processed" || e.type === "detection.new" || e.type === "verdict") return true;
  if (e.type === "proposal.new" || e.type === "proposal.decided") return DRONE_KINDS.has((e.data as unknown as Proposal | null)?.kind ?? "");
  return e.type === "mission.note" && /^(Drone|D\d|L\d)|\bvia D\d|\blink (lost|degraded)|\bno signal\b|^review f\d/.test(e.summary);
}
const DRONE_KINDS = new Set(["drone_leg", "retask_drone", "promote_detection", "dismiss_detection"]);

/** The fixtures with the drones on the ground the whole time (GuidedOpts.dronesWait). */
function onTheGround(d: Partial<MissionData>): Partial<MissionData> {
  return {
    ...d,
    events: (d.events ?? []).filter((e) => !aboutDrones(e)),
    timeline: (d.timeline ?? []).filter((e) => e.kind !== "drone" && e.kind !== "detection" && !/\bvia D\d|\blink (lost|degraded)/.test(e.text)),
    proposals: (d.proposals ?? []).filter((p) => !DRONE_KINDS.has(p.kind)),
    mapUpdates: (d.mapUpdates ?? []).filter((u) => u.source !== "frame" && u.source !== "review"),
    fleet: d.fleet ? { ...d.fleet, legs: [] } : d.fleet,
  };
}

/**
 * The conditions as they stood at `c`: the latest reading by then (each `conditions.updated` event, the
 * fixture's own `conditions` for the one that carries none), never a later one (usability test round 2:
 * Missing child said "Drones grounded" from the call, its gusts came 87 minutes in). A reading without
 * sun times keeps the day's. Null before the first reading.
 */
export function conditionsAt(d: Partial<MissionData>, c: number): Conditions | null {
  const final = d.conditions ?? null;
  const readings = (d.events ?? [])
    .filter((e) => e.type === "conditions.updated")
    .map((e) => (e.data ? (e.data as unknown as Conditions) : final && ms(final.fetched_at) <= ms(e.at) + 60_000 ? final : null))
    .filter((x): x is Conditions => !!x);
  if (final && !readings.includes(final)) readings.push(final);
  const by = readings.filter((x) => ms(x.fetched_at) <= c).sort((a, b) => ms(a.fetched_at) - ms(b.fetched_at));
  const now = by.at(-1) ?? null;
  if (!now || (now.sunset && now.civil_twilight_end)) return now;
  const sun = [...readings].reverse().find((x) => x.sunset || x.civil_twilight_end);
  return sun ? { ...now, sunset: now.sunset ?? sun.sunset, civil_twilight_end: now.civil_twilight_end ?? sun.civil_twilight_end } : now;
}

/** A grounding the manager overrode ("Fly anyway"): the reading says who approved the flight. */
function withOverride(cond: Conditions | null, user: readonly MissionEvent[], c: number): Conditions | null {
  if (!cond || cond.flyable !== false) return cond;
  const o = user.filter((e) => e.type === "mission.note" && (e.data as { action?: string } | null)?.action === "fly_override" && ms(e.at) <= c).at(-1);
  const by = (o?.data as { by?: string } | null)?.by;
  return o ? { ...cond, flyability_reason: `${cond.flyability_reason}; flying on an override approved by ${by ?? "the search manager"}` } : cond;
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
  const d = opts.dronesWait ? onTheGround(full.data) : full.data;
  const c = ms(clock);
  HOME = d.mission?.base_camp ? { lat: d.mission.base_camp.lat, lon: d.mission.base_camp.lon } : { ...TRAILHEAD };
  const mission = d.mission ? { ...d.mission, found: null, status: d.mission.status === "found" ? ("searching" as const) : d.mission.status } : null;
  const held = (u: MapUpdate) => u.source === "ground" || (u.source === "clue" && !!opts.readback && u.ref === opts.readback && !opts.mapClue);
  const allUpdates = (d.mapUpdates ?? []).filter((u) => !held(u));
  const times = updateTimes(allUpdates);
  const mapUpdates = allUpdates.filter((_, i) => (times[i] as number) <= c);
  const tasks: SectorTask[] = c < ms(BOARD_AT) ? [] : (d.tasks ?? []).map((t) => ({ ...t, state: "proposed" as const, team_id: null, pod: null, note: null, updated_at: BOARD_AT }));
  const clues = (d.clues ?? []).filter((x) => ms(x.at) <= c).map((x) => (x.id === opts.readback ? { ...x, confirmed: false } : x));
  // the fixtures' later assignment proposals for a team or a sector the visitor has already sent are moot: the agent does
  // not propose them (the cold test: "C3 to Team Three" right after Team Three went to B3)
  const sent = user.filter((e) => e.type === "task.updated" && (e.data as { state?: string } | null)?.state === "assigned").map((e) => ({ at: ms(e.at), team: (e.data as { team_id?: string }).team_id, sector: (e.data as { sector_id?: string }).sector_id }));
  // (never the first assignment: the guided search's Assign step is about it)
  const firstAssign = [...(d.proposals ?? [])].filter((p) => p.kind === "assign_sector").sort((a, b) => a.created_at.localeCompare(b.created_at))[0]?.id;
  const moot = (p: Proposal) => p.kind === "assign_sector" && p.id !== firstAssign && sent.some((x) => x.at <= ms(p.created_at) && (x.team === p.target.team || x.sector === p.target.sector));
  const mootIds = new Set((d.proposals ?? []).filter(moot).map((p) => p.id));
  const proposals = (d.proposals ?? []).filter((p) => ms(p.created_at) <= c && !mootIds.has(p.id)).map((p) => proposalAt(p, -Infinity));
  const mine = user.filter((e) => ms(e.at) <= c);
  const legBy = legApprover(opts.survey);
  // grounded: every drone at base camp, nothing in the air (no survey, no flight line of the manager's either)
  const back = opts.dronesWait ? [] : findRecalls(d, mine, legBy);
  const fly = opts.dronesWait ? { fleet: d.fleet ? fleetNow(d.fleet, [], c, HOME, []) : null, notes: [] as MissionEvent[], photos: [] as MapUpdate[], skipped: new Set<string>() } : fleetAt(d, c, [...mine, ...back], legBy, back.length ? ms(back[0]!.at) : null);
  const notMoot = (e: MissionEvent) => !(e.type === "proposal.new" && e.ref && mootIds.has(e.ref));
  const events = [...(d.events ?? []).filter((e) => eventTime(e) <= c && !managersOwn(e) && notMoot(e) && !aboutSkipped(e, fly.skipped)).map((e) => approver(e, legBy))]
    // the read-back clue waits for the manager's decision in the log too
    .map((e) => (e.type === "clue.added" && e.ref === opts.readback && e.data ? { ...e, data: { ...(e.data as object), confirmed: false } as MissionEvent["data"] } : e))
    .sort((a, b) => a.at.localeCompare(b.at));
  // the manager's decisions, the teams' check-ins and the find are the visitor's now; after the board is seeded the teams' radio too
  const timeline = (d.timeline ?? [])
    .filter((e) => ms(e.at) <= c && e.kind !== "decision" && e.kind !== "checkin" && e.kind !== "found" && !(ms(e.at) > ms(BOARD_AT) && e.kind === "radio"))
    .filter((e) => !aboutSkipped({ summary: e.text } as MissionEvent, fly.skipped))
    .map((e) => (e.kind === "drone" ? { ...e, text: approver({ type: "fleet.updated", summary: e.text } as MissionEvent, legBy).summary } : e));
  // a hasty team sent on by the manager stops its hasty rows there
  const sentAt = (id: string) => Math.min(...sent.filter((x) => x.team === id).map((x) => x.at));
  timeline.push(...hastyRows(d.teams ?? [], d.clues ?? [], c, sentAt), ...noteRows(fly.notes));
  if (back.length) {
    const grounded = conditionsAt(d, ms(back[0]!.at))?.flyable === false;
    const names = back.map((e) => (d.fleet?.drones ?? []).find((x) => x.id === e.ref)?.name ?? e.ref ?? "");
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]!;
    timeline.push({ id: "find-recall", at: back[0]!.at, kind: "drone", team: null, sector: null, direction: null, refs: [], turn_id: null, drone: null, by: null, text: `${list} recalled to base camp at the find${grounded ? ": the drones are grounded, the safety recall stands" : ""}` });
  }
  // the wind looked at again when the manager was told it would be: the reading as it stands then
  const w = opts.dronesWait && c >= opts.dronesWait.recheck ? conditionsAt(d, opts.dronesWait.recheck) : null;
  if (opts.dronesWait && w) {
    timeline.push({
      id: "wind-recheck", at: iso(opts.dronesWait.recheck), kind: "drone", team: null, sector: null, direction: null, refs: [], turn_id: null, drone: null, by: null,
      text: w.flyable === false ? `Wind re-checked: ${w.gust_kmh !== null ? `gusts ${Math.round(w.gust_kmh)} km/h, ` : ""}still over the drones' limit; the drones stay on the ground` : "Wind re-checked: under the drones' limit now; the drones stay on the ground until you choose to fly them",
    });
  }
  timeline.sort((a, b) => a.at.localeCompare(b.at));
  const base: MissionData = {
    ...EMPTY,
    ...d,
    mission,
    conditions: withOverride(conditionsAt(d, c), user, c),
    tasks,
    teams: (d.teams ?? []).map((t) => {
      const base = { ...atTrailhead(t), last_heard_at: t.last_heard_at && ms(t.last_heard_at) <= Math.min(c, ms(BOARD_AT)) ? t.last_heard_at : null };
      const hasty = hastyAt(t, d.clues ?? [], c);
      return hasty ? placed(base, hasty, c) : base;
    }),
    clues,
    proposals,
    fleet: fly.fleet,
    events,
    mapUpdates,
    sectors: d.sectors ?? [],
    verdicts: [],
    timeline,
    links: fleetLinksFromEvents(events),
  };
  const s0 = simulate(mine.reduce(applyEvent, base), full, mine, c, opts.seed);
  // the drones fly by the clock (fleetSim.ts); the manager's legs photograph the map as they go
  const s = relayed({ ...s0, fleet: fly.fleet, mapUpdates: [...s0.mapUpdates, ...fly.photos] }, mine);
  const ranked = rankPending(s, d.mapBase ? sectorsAt(d.mapBase, s.sectors, s.mapUpdates) : s.sectors);
  const told = opts.readback && !opts.mapClue ? unmappedReason(ranked, opts.readback) : ranked;
  return closedOnFind(told, mine);
}

/**
 * The relay the manager chose (the link step's "Divert drone three as a relay", a mission note with action
 * "relay"): from then the relay drone holds over the ridge ("Relay" on its row, not its old flight line), its
 * own line stops, and the drone that lost its link is heard again.
 */
function relayed(s: MissionData, mine: readonly MissionEvent[]): MissionData {
  const e = [...mine].reverse().find((x) => x.type === "mission.note" && (x.data as { action?: string } | null)?.action === "relay");
  const r = e?.data as { drone?: string; lost?: string } | null;
  if (!e || !r?.drone || !s.fleet) return s;
  // the find recalls the relay drone with the others (findRecalls): its row says Returning, not Relay
  const home = mine.some(isFoundEvent);
  const lost = s.fleet.drones.find((x) => x.id === r.lost);
  const legs = s.fleet.legs.map((l) => (l.drone_id === r.drone && l.status === "flying" ? { ...l, status: "cancelled" as const } : l));
  const over = lost?.position ? { lat: (lost.position.lat + HOME.lat) / 2, lon: (lost.position.lon + HOME.lon) / 2 } : { ...HOME };
  const drones = home ? s.fleet.drones : s.fleet.drones.map((x) => (x.id === r.drone ? ({ ...x, status: "flying" as const, leg_id: null, position: over, relay: true } as typeof x) : x));
  const links = { ...s.links, drones: { ...s.links.drones } };
  if (r.lost && links.drones[r.lost]) links.drones[r.lost] = { ...links.drones[r.lost]!, link: "connected" };
  // from the relay on, its old flight line's ending and landing are not what happened: the log leaves them out
  const name = s.fleet.drones.find((x) => x.id === r.drone)?.name ?? r.drone;
  const short = `D${/(\d+)$/.exec(r.drone)?.[1] ?? ""}`;
  const aboutIt = (text: string, at: string) => at >= e.at && (text.startsWith(`${name}:`) || text.startsWith(`${name} back at base camp`) || text.startsWith(`${name} ·`)) && !/link/.test(text);
  const timeline = s.timeline.filter((x) => !(x.kind === "drone" && aboutIt(x.text, x.at)));
  const events = s.events.filter((x) => !(x.type === "mission.note" && x.id !== e.id && (aboutIt(x.summary, x.at) || (x.at >= e.at && x.summary.startsWith(`${short} `) && !/link/.test(x.summary)))));
  return { ...s, fleet: { ...s.fleet, drones, legs }, links, timeline, events };
}

/**
 * A radio clue logged without mapping moves nothing: the agent's reasons stop citing it as what raised a
 * sector (the cold test: "Log without mapping" and the card still said the whistle "raised" C2), and the
 * sector's share is the one the map shows.
 */
export function unmappedReason(s: MissionData, clueId: string): MissionData {
  const cite = new RegExp(`(?:,? and )?\\b${clueId} \\([^)]*\\)(?: and )?`, "g");
  const retell = (p: Proposal): Proposal => {
    if (!new RegExp(`\\b${clueId}\\b`).test(p.reason)) return p;
    let reason = p.reason.replace(cite, (m) => (/^,? and /.test(m) || / and $/.test(m) ? (/^,? and /.test(m) && / and $/.test(m) ? " and " : "") : ""));
    reason = reason.replace(/:\s+raised it;/, ": no new evidence mapped;");
    const sector = p.target.sector;
    const now = s.sectors.find((x) => x.sector_id === sector);
    if (sector && now) reason = reason.replace(new RegExp(`^${sector} · [\\d.]+ % of remaining probability(?:, up from [\\d.]+ %)?`), `${sector} · ${(now.poa * 100).toFixed(1)} % of remaining probability`);
    const said = s.clues.find((x) => x.id === clueId)?.text;
    return { ...p, reason: `${reason} The radio clue${said ? ` “${said}”` : ""} is logged without mapping: it moved nothing on the map.` };
  };
  // the card and the log's "AI suggests" line alike
  const proposals = s.proposals.map((p) => (p.status === "pending" ? retell(p) : p));
  const events = s.events.map((e) => (e.type === "proposal.new" && e.data && "reason" in (e.data as object) ? { ...e, data: retell(e.data as unknown as Proposal) as unknown as MissionEvent["data"] } : e));
  return { ...s, proposals, events };
}

/**
 * The subject found (the manager's Record find): every decision still open closes with "closed: subject
 * found", each one logged (the cold test: a clue card stayed open under "nothing left to decide").
 */
export function closedOnFind(s: MissionData, mine: readonly MissionEvent[]): MissionData {
  const f = mine.find(isFoundEvent);
  if (!f) return s;
  const at = f.at;
  // a safety recall is never cancelled by closing the case: it stands (the drones come home, findRecalls)
  const recall = (p: Proposal) => p.kind === "retask_drone" && p.target.home !== undefined;
  const open = s.proposals.filter((p) => p.status === "pending" && !recall(p));
  const stands = s.proposals.filter((p) => p.status === "pending" && recall(p));
  const clues = s.clues.filter((x) => !x.confirmed && !(x as { logged?: boolean }).logged);
  if (!open.length && !clues.length && !stands.length) return s;
  const proposals = s.proposals.map((p) =>
    stands.includes(p) ? { ...p, status: "approved" as const, decided_at: at, decided_by: null, decision_reason: "the safety recall stands at the find" } : open.includes(p) ? { ...p, status: "superseded" as const, decided_at: at, decided_by: null, decision_reason: "closed: subject found" } : p,
  );
  const row = (id: string, text: string, team: string | null, sector: string | null): TimelineEvent => ({ id, at, kind: "decision", team, sector, text, direction: null, refs: [], turn_id: null, drone: null, by: null });
  const timeline = [
    ...s.timeline,
    ...open.map((p) => row(`closed-${p.id}`, `Closed: subject found: the AI's suggestion "${p.summary}"`, p.target.team ?? null, p.target.sector ?? null)),
    ...stands.map((p) => row(`stands-${p.id}`, `The safety recall stands at the find: ${p.summary}`, null, null)),
    ...clues.map((x) => row(`closed-${x.id}`, `Closed: subject found: the clue "${x.text}" left unconfirmed`, null, null)),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return { ...s, proposals, clues: s.clues.map((x) => (clues.includes(x) ? ({ ...x, closed: true } as typeof x) : x)), timeline };
}

/**
 * The find recalls every drone still in the air (a flight line, a relay): closing the case never leaves a
 * drone flying, and under "Drones grounded" never cancels the safety recall (round 3: three drones flew on
 * after the find). As recall sorties at the find (fleetSim.ts userSorties), so their rows say Returning.
 */
export function findRecalls(d: Partial<MissionData>, mine: readonly MissionEvent[], by: string): MissionEvent[] {
  const found = mine.find(isFoundEvent);
  if (!found || !d.fleet) return [];
  const at = ms(found.at);
  const before = mine.filter((e) => ms(e.at) <= at);
  const up = (fleetAt(d, at, before, by).fleet?.drones ?? []).filter((x) => x.status === "flying").map((x) => x.id);
  // the relay drone holds over the ridge (relayed): in the air too
  const relay = [...before].reverse().find((x) => x.type === "mission.note" && (x.data as { action?: string } | null)?.action === "relay");
  const r = (relay?.data as { drone?: string } | null)?.drone;
  const ids = [...new Set([...up, ...(r ? [r] : [])])];
  const name = (id: string) => d.fleet?.drones.find((x) => x.id === id)?.name ?? id;
  return ids.map((id) => ({ id: `find-recall-${id}`, type: "fleet.updated" as const, at: found.at, summary: `${name(id)} recalled to base camp by the find`, ref: id, data: null }));
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
  if (!passes.length) return withSightings(s, full, passes, c, !!found);
  const call = (id: string) => s.teams.find((t) => t.id === id)?.callsign ?? id;
  let teams = s.teams;
  let tasks = s.tasks;
  let proposals = s.proposals;
  const timeline = [...s.timeline];
  const mapUpdates = [...s.mapUpdates];
  const lastFor = new Map<string, Pass>();
  for (const x of passes) lastFor.set(x.team, x);
  let seq = 900_000;
  // each team where its passes put it: walking out, sweeping, with the subject, walking back, at base camp
  const foundAt = found ? ms(found.at) : null;
  for (const id of lastFor.keys()) {
    const team = s.teams.find((t) => t.id === id);
    if (!team) continue;
    const p = placeOf(passes.filter((x) => x.team === id), c, { centre: (sector) => centreOf(s.sectors, sector), subject, foundAt, from: (t) => hastyAt(team, full.data.clues ?? [], t)?.pos ?? null });
    teams = teams.map((t) => (t.id === id ? placed(t, p, c) : t));
  }
  for (const x of passes) {
    seq += 1;
    // once the find is marked, the passes still out stop where they are
    const ended = !x.cut && x.end <= c && !(found && ms(found.at) < x.end);
    // the board: in progress once the team is there, searched at its POD when it reports no sign
    const own = (t: SectorTask) => t.sector_id === x.sector && t.team_id === x.team;
    const stopped = foundAt !== null && foundAt < x.end && !x.detected && c >= foundAt;
    if (!x.cut && c >= x.arrive && !stopped) tasks = tasks.map((t) => (own(t) ? (ended && !x.detected ? { ...t, state: "searched" as const, pod: x.pod, updated_at: iso(x.end) } : { ...t, state: "in_progress" as const, updated_at: iso(x.arrive) }) : t));
    // stopped by the find before its pass ended: the sector stays open (not searched), the team walks back
    if (stopped && !x.cut && c >= x.arrive) tasks = tasks.map((t) => (own(t) ? { ...t, state: "proposed" as const, team_id: null, updated_at: iso(foundAt) } : t));
    if (!ended) continue;
    const said = x.detected
      ? `Sightline, ${call(x.team)}. Subject located in ${sectorSpoken(x.sector)}, conscious and talking, over.`
      : `Sightline, ${call(x.team)}. ${sectorSpoken(x.sector)} searched, no sign of the subject, over.`;
    timeline.push({ id: `g-${x.team}-${x.start}`, at: iso(x.end), kind: "radio", team: x.team, sector: x.sector, text: said, direction: "in", refs: [], turn_id: null, drone: null, by: null });
    if (x.detected) continue;
    // the walk home says why: no new task yet (a team sent on at once has its next assignment's line instead)
    if (!all.some((o) => o.team === x.team && o.start >= x.end && o.start <= x.end + 1000))
      timeline.push({ id: `g-${x.team}-${x.start}-back`, at: iso(x.end + 1000), kind: "checkin", team: x.team, sector: x.sector, text: `${call(x.team)} heads back to base camp: ${x.sector} searched with no sign, and no new task yet`, direction: null, refs: [], turn_id: null, drone: null, by: null });
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
      const seen = openSighting(s.clues, all, s.sectors, x.end);
      proposals = [
        ...proposals,
        {
          id, kind: "assign_sector", status: "pending", created_by: "planner", created_at: iso(x.end), decided_at: null, decided_by: null, decision_reason: null, edits: null, evidence: [], briefing: null,
          target: { team: x.team, sector: pick },
          summary: `Assign sector ${pick} to ${call(x.team)}`,
          reason: `${x.sector} searched at POD ${x.pod.toFixed(2)} with no sign, so its probability drops; ${pick} is now the likeliest open sector (${(poa * 100).toFixed(1)} % POA) and ${call(x.team)} is free.${seen ? sightingLine(seen) : ""}`,
        },
      ];
    }
  }
  timeline.sort((a, b) => a.at.localeCompare(b.at));
  return withSightings({ ...s, teams, tasks, timeline, proposals, mapUpdates }, full, passes, c, !!found);
}

/** Where a team's passes (in time order, the last one current) put it at `t`. */
export function placeOf(list: readonly Pass[], t: number, ctx: { centre: (sector: string) => LL | null; subject: Subject | null; foundAt: number | null; from?: (t: number) => LL | null }): Place {
  const x = list.at(-1)!;
  const prev = list.slice(0, -1);
  // it walks from where it was: its last pass, a hasty search, or base camp
  const from = prev.length ? placeOf(prev, x.start, ctx).pos : (ctx.from?.(x.start) ?? { ...HOME });
  const centre = ctx.centre(x.sector) ?? from;
  const walk = (u: number) => alongPath([from, centre], (u - x.start) / WALK_MS);
  // once the find is marked, a pass still out stops where it is and the team walks back to base camp
  if (ctx.foundAt !== null && ctx.foundAt < x.end && !x.cut && t >= ctx.foundAt && x.start <= ctx.foundAt) {
    const p0 = placeOf(list, ctx.foundAt, { ...ctx, foundAt: null }).pos;
    const backMs = Math.max(MIN_MS, RETURN_MS * Math.min(2, metres(p0, HOME) / Math.max(1, metres(from, centre))));
    if (t < ctx.foundAt + backMs) return { status: "returning", pos: alongPath([p0, HOME], (t - ctx.foundAt) / backMs), heard: ctx.foundAt, eta: Math.max(1, Math.ceil((ctx.foundAt + backMs - t) / MIN_MS)), note: "subject found" };
    return { status: "standby", pos: { ...HOME }, heard: ctx.foundAt, eta: null };
  }
  const tt = t;
  if (tt < x.end) {
    if (tt < x.arrive) return { status: "assigned", pos: walk(tt), heard: x.start, eta: null };
    return { status: "searching", pos: centre, heard: x.arrive, eta: null };
  }
  // the team with the subject: on the carry-out once the find is recorded
  if (x.detected && !x.cut) return { status: "searching", pos: ctx.subject ? { lat: ctx.subject.lat, lon: ctx.subject.lon } : centre, heard: x.end, eta: null, note: ctx.foundAt !== null && t >= ctx.foundAt ? "carry-out" : null };
  // searched with no sign, or recalled: it walks back to base camp from where it stood
  const p0 = x.end < x.arrive ? walk(x.end) : centre;
  const out = Math.max(1, metres(from, centre));
  const backMs = Math.max(MIN_MS, RETURN_MS * Math.min(2, metres(p0, HOME) / out));
  if (t < x.end + backMs) return { status: "returning", pos: alongPath([p0, HOME], (t - x.end) / backMs), heard: x.end, eta: Math.max(1, Math.ceil((x.end + backMs - t) / MIN_MS)) };
  return { status: "standby", pos: { ...HOME }, heard: x.end, eta: null };
}

/** A sighting nobody has been sent to since it was marked (a reviewer's "Person"), as of `t`, with its sector. */
function openSighting(clues: readonly Clue[], passes: readonly Pass[], sectors: readonly SectorNow[], t: number): { clue: Clue; sector: string } | null {
  for (const clue of sightings(clues)) {
    if (ms(clue.at) > t) continue;
    const sector = sectorAt(sectors, clue);
    if (!sector) continue;
    if (passes.some((p) => p.sector === sector && p.start >= ms(clue.at) && !p.cut)) continue;
    return { clue, sector };
  }
  return null;
}

/** What a proposal's reason says of a sighting still waiting for a team. */
const sightingLine = (o: { clue: Clue; sector: string }) => ` A possible sighting in ${o.sector} waits for a team: sending the nearest one there comes first.`;

/** A team's walk out and one pass, in minutes (the cost of sending it anywhere). */
export const PASS_MIN = Math.round((WALK_MS + SWEEP_MS) / MIN_MS);

/**
 * A reviewer's "Person" changes the plan: the agent proposes sending the nearest team to the sighting's
 * sector (a proposal the manager approves; it tops Needs you), until a team has been sent there.
 */
function withSightings(s: MissionData, full: DemoFull, passes: readonly Pass[], c: number, found: boolean): MissionData {
  if (found) return s;
  let proposals = s.proposals;
  const timeline = [...s.timeline];
  const call = (id: string) => s.teams.find((t) => t.id === id)?.callsign ?? id;
  // one proposal per sighting's sector (the cold test: two cards for one place, at two distances)
  for (const [sector, group] of sightingGroups(s.clues.filter((x) => ms(x.at) <= c), s.sectors)) {
    const clue = group[0]!;
    const id = `sight-${clue.id}`;
    if (proposals.some((p) => p.id === id)) continue;
    // a team the manager sent there another way: the sighting is superseded, and the log says so
    const went = passes.find((p) => p.sector === sector && p.start >= ms(clue.at) && !p.cut);
    if (went) {
      proposals = [...proposals, { id, kind: "assign_sector", status: "superseded", created_by: "planner", created_at: clue.at, decided_at: iso(went.start), decided_by: null, decision_reason: `superseded: ${call(went.team)} sent to the sighting`, edits: null, briefing: null, evidence: [{ kind: "clue", ref: clue.id, caption: clue.text }], target: { team: went.team, sector }, summary: `Send a team to the sighting in ${sector}`, reason: "" }];
      timeline.push({ id: `superseded-${id}`, at: iso(went.start), kind: "decision", team: went.team, sector, text: `Sighting in ${sector}: superseded: ${call(went.team)} sent to the sighting`, direction: null, refs: [clue.id], turn_id: null, drone: null, by: null });
      continue;
    }
    // not a team another pending assignment asks for (the first assignment's team), unless no other can go
    const asked = proposals.filter((p) => p.status === "pending" && p.kind === "assign_sector" && !p.id.startsWith("sight-") && p.target.team).map((p) => p.target.team as string);
    // the nearest team to any photo of it, and that distance
    const nearOf = (not: readonly string[]) => group.map((x) => nearestTeam(s.teams, x, HOME, not)).filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => a.m - b.m)[0] ?? null;
    // never a team already committed to a fresh task or the carry-out, while another can go
    const busy = s.teams.filter(committed).map((t) => t.id);
    const near = nearOf([...asked, ...busy]) ?? nearOf(busy) ?? nearOf(asked) ?? nearOf([]);
    if (!near) continue;
    const where = near.team.status === "standby" ? "at base camp" : near.team.status === "returning" ? "on its way back" : `out in ${s.tasks.find((t) => t.team_id === near.team.id)?.sector_id ?? "the field"}`;
    proposals = [
      ...proposals,
      {
        id, kind: "assign_sector", status: "pending", created_by: "planner", created_at: clue.at, decided_at: null, decided_by: null, decision_reason: null, edits: null, briefing: null,
        evidence: [{ kind: "clue", ref: clue.id, caption: clue.text }],
        target: { team: near.team.id, sector },
        summary: `Send ${call(near.team.id)} to the sighting in ${sector} (+${PASS_MIN} min)`,
        reason: `A reviewer marked a person on ${group.length > 1 ? `${group.length} survey photos` : "a survey photo"}: a possible sighting in ${sector}. ${call(near.team.id)} is the nearest team (${Math.round(near.m)} m, ${where}); the walk and one pass take about ${PASS_MIN} min. If it is not the subject, the plan by POA stands.`,
      },
    ];
  }
  void full;
  timeline.sort((a, b) => a.at.localeCompare(b.at));
  return proposals === s.proposals ? s : { ...s, proposals, timeline };
}

/** The sightings by the sector they are in, each sector's oldest first (its proposal's id is the oldest's). */
export function sightingGroups(clues: readonly Clue[], sectors: readonly SectorNow[]): Map<string, Clue[]> {
  const out = new Map<string, Clue[]>();
  for (const clue of [...sightings(clues)].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) {
    const sector = sectorAt(sectors, clue);
    if (sector) out.set(sector, [...(out.get(sector) ?? []), clue]);
  }
  return out;
}

/**
 * The sightings still waiting for a team at `at`, from the manager's own events (the guide's Send all sends
 * the nearest team to each first): no team sent to its sector since, no decision on its proposal.
 */
export function pendingSightings(full: DemoFull | null, user: readonly MissionEvent[], passes: readonly Pass[], at: number): { sector: string; clue: Clue }[] {
  // the scenario's own sightings (a witness) and the reviewers' (the manager's answers on photos)
  const clues = new Map<string, Clue>((full?.data.clues ?? []).filter((x) => ms(x.at) <= at).map((x) => [x.id, x]));
  for (const e of user) if (e.type === "clue.added" && e.data && ms(e.at) <= at) clues.set((e.data as unknown as Clue).id, e.data as unknown as Clue);
  const decided = new Set(user.filter((e) => e.type === "proposal.decided" && ms(e.at) <= at && e.ref).map((e) => e.ref as string));
  const out: { sector: string; clue: Clue }[] = [];
  for (const [sector, group] of sightingGroups([...clues.values()], full?.data.sectors ?? [])) {
    const clue = group[0]!;
    if (decided.has(`sight-${clue.id}`) || passes.some((p) => p.sector === sector && p.start >= ms(clue.at) && !p.cut && p.start <= at)) continue;
    out.push({ sector, clue });
  }
  return out;
}

/**
 * The agent's pending "next sector" proposals (`g…`) re-ranked on the map the table shows: the likeliest
 * open sector there, never a lower one (the cold test: A4 at 1.5 % proposed while the table's top open
 * sector was B4 at 2.5 %). Two proposals do not ask for the same sector.
 */
export function rankPending(s: MissionData, sectors: readonly SectorNow[]): MissionData {
  const taken = new Set(s.tasks.filter((t) => t.state === "assigned" || t.state === "in_progress").map((t) => t.sector_id));
  const open = [...sectors].filter((x) => !taken.has(x.sector_id) && (s.tasks.find((t) => t.sector_id === x.sector_id)?.state ?? "proposed") === "proposed").sort((a, b) => b.poa - a.poa || a.sector_id.localeCompare(b.sector_id));
  const call = (id: string | undefined) => s.teams.find((t) => t.id === id)?.callsign ?? id ?? "";
  // a sighting's sector is the sighting proposal's: the next-sector proposals ask for others
  const sightingAsks = s.proposals.filter((p) => p.status === "pending" && p.id.startsWith("sight-") && p.target.sector);
  const asked = new Set<string>(sightingAsks.map((p) => p.target.sector as string));
  const proposals = s.proposals.map((p) => {
    if (p.status !== "pending" || !/^g\d+$/.test(p.id) || p.kind !== "assign_sector") return p;
    const top = open.find((x) => !asked.has(x.sector_id));
    if (!top) return p;
    // a higher open sector skipped says why: another proposal (the sighting's, or the agent's own) asks for it
    const higher = open.filter((x) => asked.has(x.sector_id) && x.poa > top.poa).map((x) => `${x.sector_id}${sightingAsks.some((q) => q.target.sector === x.sector_id) ? ", the sighting's" : ""}`);
    asked.add(top.sector_id);
    if (top.sector_id === p.target.sector && !higher.length) return p;
    const why = p.reason.split(";")[0];
    const tail = / A possible sighting[\s\S]*$/.exec(p.reason)?.[0] ?? "";
    return {
      ...p,
      target: { ...p.target, sector: top.sector_id },
      summary: `Assign sector ${top.sector_id} to ${call(p.target.team)}`,
      reason: `${why}; ${top.sector_id} is now the likeliest open sector on the map${higher.length ? ` not already asked for (${higher.join("; ")})` : ""} (${(top.poa * 100).toFixed(1)} % POA) and ${call(p.target.team)} is free.${tail}`,
    };
  });
  // every other assignment the agent asks for says the sighting comes first (the cold test: it ignored two)
  const first = sightingAsks[0];
  const cited = first
    ? proposals.map((p) => (p.status === "pending" && p.kind === "assign_sector" && !p.id.startsWith("sight-") && !/possible sighting/i.test(p.reason) ? { ...p, reason: `${p.reason} A possible sighting in ${first.target.sector} waits for a team: the agent asks to send ${call(first.target.team)} there first.` } : p))
    : proposals;
  return { ...s, sectors: [...sectors], proposals: cited };
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
