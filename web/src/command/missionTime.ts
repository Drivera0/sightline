// Mission time on the demo mission: the one timeline the story and the console share. The demo mission
// is one set of fixtures (demoMission.ts) dated on a scripted evening; this module says what of it is
// visible at a given mission clock, so the story's six checkpoints are six clock readings of the same
// mission, not six screens. `demoAt(full, clock, user)` is pure: the console's store (`useMission`) is
// loaded with it whenever the scrubber moves.

import type { Clue, FleetState, MapBase, MapUpdate, MissionEvent, Proposal, SectorTask, Team } from "../contract";
import type { SectorNow } from "../lib/api";
import { applyEvent, EMPTY, fleetLinksFromEvents, type MissionData } from "../lib/mission";
import { cellCenter } from "../map/heat/geometry";
import { LiveHeat, lookedAt } from "../search/live";

export type Checkpoint = 0 | 1 | 2 | 3 | 4 | 5;
export const CHECKPOINTS_ALL: readonly Checkpoint[] = [0, 1, 2, 3, 4, 5];

/** What the right-hand side of the console shows (the view switch). */
export type StoryView = "map" | "photos" | "review" | "debrief";

export interface CheckpointDef {
  t: Checkpoint;
  id: "call" | "photos" | "confirm" | "next" | "run" | "results";
  /** The scrubber's tick label. */
  label: string;
  /** The mission clock at this checkpoint (the fixtures' scripted evening, UTC). */
  at: string;
  /** The view the story shows here. */
  view: StoryView;
  /**
   * The coach mark: one sentence, in the mission's voice (null at t0, where the pitch bar speaks).
   * `target` is a CSS selector on the real console.
   */
  mark: { text: string; target: string; aside?: string } | null;
  /** The action on the real console that moves the story on (the coach mark waits for it, or Skip). */
  gate?: "approve";
  /** A mark shown once before this checkpoint's own (t3: the clue log, then the proposal). */
  pre?: { text: string; target: string; aside?: string };
}

const DAY = "2026-10-24T";
/** The survey flight: 500 photos land between these two times (the fixtures' photo.processed events). */
export const FLIGHT = { start: `${DAY}20:42:00Z`, end: `${DAY}21:18:00Z` } as const;
/** The planner seeds the task board from the map when the photos are in and reviewed. */
export const BOARD_AT = `${DAY}21:42:00Z`;
/** The drones leave the trailhead for their legs once the run is approved. */
export const FLEET_OUT = `${DAY}21:44:00Z`;
/** Where everyone waits before the run: the trailhead lot (clue c001, the subject's car). */
export const TRAILHEAD = { lat: 49.373, lon: -122.949 } as const;
/** The proposal the story asks the visitor to approve at t3. */
export const STORY_PROPOSAL = "p001";

/**
 * Story pacing: the two ground searches happen during the run (t3 → t4) rather than before the board
 * exists. Every other item keeps the fixtures' own time.
 */
export const RETIME: Readonly<Record<string, string>> = {
  B4: `${DAY}21:56:00Z`,
  C4: `${DAY}21:50:00Z`,
};

export const CHECKPOINTS: readonly CheckpointDef[] = [
  { t: 0, id: "call", label: "The call", at: `${DAY}20:35:00Z`, view: "map", mark: null },
  {
    t: 1,
    id: "photos",
    label: "Photos land",
    at: FLIGHT.end,
    view: "photos",
    mark: { text: "Photos are landing: the detector reads each one, and the map updates as it is placed.", target: '[data-tour="photos"]' },
  },
  {
    t: 2,
    id: "confirm",
    label: "Confirm",
    at: `${DAY}21:31:00Z`,
    view: "review",
    mark: { text: "A person confirms every candidate; the third scored only 0.18, and a second look caught it.", target: '[data-tour="review"]' },
  },
  {
    t: 3,
    id: "next",
    label: "Where next",
    at: BOARD_AT,
    view: "map",
    mark: { text: "The agent proposes Team One for A1, says why, and waits for your approval.", target: `[data-proposal="${STORY_PROPOSAL}"]` },
    gate: "approve",
    pre: { text: "Clues move the map too: each confirmed clue changes where the person could be.", target: '[aria-label="Clue log"]' },
  },
  {
    t: 4,
    id: "run",
    label: "Run",
    at: `${DAY}22:00:00Z`,
    view: "map",
    mark: { text: "Eighteen minutes on: teams are out, and B4 is searched at POD 60 %, lowered but never ruled out.", target: '[data-tour="tasks"]', aside: "Teams report by radio: open Radio." },
  },
  {
    t: 5,
    id: "results",
    label: "Results",
    at: `${DAY}22:00:00Z`,
    view: "debrief",
    mark: { text: "The debrief: what the detector found, how fast, and what breaks first.", target: '[data-tour="debrief"]' },
  },
];

/** The coach marks: one per checkpoint after the call (five). */
export const MARK_COUNT = CHECKPOINTS.filter((c) => c.mark).length;

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
  if (v === null || !/^[0-5]$/.test(v)) return null;
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

/** When an update becomes visible: frames by flight order, ground searches at their (retimed) task time. */
function updateTimes(updates: readonly MapUpdate[], tasks: readonly SectorTask[]): number[] {
  const frames = updates.filter((u) => u.source === "frame").length;
  let k = 0;
  return updates.map((u) => {
    if (u.source === "frame") return frameTime(k++, frames);
    const task = tasks.find((t) => t.sector_id === u.ref);
    const at = (u.ref && RETIME[u.ref]) ?? task?.updated_at ?? u.at;
    return ms(at);
  });
}

const taskTime = (t: SectorTask) => ms(RETIME[t.sector_id] ?? t.updated_at);
const eventTime = (e: MissionEvent) => ms((e.type === "task.updated" || e.type === "map.updated") && e.ref && RETIME[e.ref] ? RETIME[e.ref]! : e.at);

/** A proposal as it stood at `c`: decided later → still pending. */
function proposalAt(p: Proposal, c: number): Proposal {
  if (!p.decided_at || ms(p.decided_at) <= c) return p;
  return { ...p, status: "pending", decided_at: null, decided_by: null, decision_reason: null, edits: null };
}

/** A team before it goes out: on standby at the trailhead since the call. */
function atTrailhead(t: Team): Team {
  return { ...t, status: "standby", position: { ...TRAILHEAD }, position_at: checkpoint(0).at };
}

type LL = { lat: number; lon: number };

/** The point a fraction `f` (0..1) of the way along a path, by distance (flat earth; a few km). */
export function alongPath(path: readonly LL[], f: number): LL {
  if (path.length === 0) return { ...TRAILHEAD };
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
    return { ...t, position: alongPath([TRAILHEAD, t.position], (c - out) / (there - out)), position_at: iso(c) };
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
        const path = [{ ...TRAILHEAD }, ...wps.slice(0, wps.length ? near + 1 : 0), d.position];
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
    drones: fleet.drones.map((d) => ({ ...d, status: "idle", leg_id: null, position: { ...TRAILHEAD } })),
  };
}

/** Each sector's cells (its outline's bounding box on the grid), worked out once per map. */
const sectorCellCache = new WeakMap<MapBase, Map<string, number[]>>();
function sectorCells(base: MapBase, sectors: readonly SectorNow[]): Map<string, number[]> {
  let byId = sectorCellCache.get(base);
  if (byId && sectors.every((s) => byId!.has(s.sector_id))) return byId;
  byId = new Map();
  const n = base.grid.rows * base.grid.cols;
  const centers = Array.from({ length: n }, (_, i) => cellCenter(base.grid, i));
  for (const s of sectors) {
    if (!s.polygon?.length) continue;
    const lons = s.polygon.map((p) => p[0]);
    const lats = s.polygon.map((p) => p[1]);
    const [w, e, south, north] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
    const cells: number[] = [];
    centers.forEach((p, i) => {
      if (p.lon > w && p.lon < e && p.lat > south && p.lat < north) cells.push(i);
    });
    byId.set(s.sector_id, cells);
  }
  sectorCellCache.set(base, byId);
  return byId;
}

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
  const allTasks = d.tasks ?? [];
  const allUpdates = d.mapUpdates ?? [];
  const times = updateTimes(allUpdates, allTasks);
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
    .map((e) => (eventTime(e) === ms(e.at) ? e : { ...e, at: iso(eventTime(e)) }))
    .sort((a, b) => a.at.localeCompare(b.at));
  const sectors = now || !d.mapBase ? (d.sectors ?? []) : sectorsAt(d.mapBase, d.sectors ?? [], mapUpdates);
  const base: MissionData = {
    ...EMPTY,
    ...d,
    tasks,
    teams: now ? (d.teams ?? []).map((t) => (t.position ? t : atTrailhead(t))) : teamsAt(d.teams ?? [], allTasks, c),
    clues,
    proposals,
    fleet: now ? (d.fleet ?? null) : fleetAt(d.fleet, c, ms(full.now)),
    events,
    mapUpdates,
    sectors,
    verdicts: [],
    links: fleetLinksFromEvents(events),
  };
  return user.filter((e) => ms(e.at) <= c).reduce(applyEvent, base);
}

/** The checkpoint at or before a clock reading (where the scrubber's thumb sits). */
export function checkpointAtOrBefore(clock: string): Checkpoint {
  const c = ms(clock);
  let found: Checkpoint = 0;
  for (const cp of CHECKPOINTS) if (ms(cp.at) <= c && cp.t !== 5) found = cp.t;
  return found;
}
