// The drones' physics on the demo mission (the guided search and a played clock), pure: every flight is
// a sortie that flies out from where the drone is to its leg at its speed, sweeps the leg for the leg's
// own minutes, flies home and lands; the battery drains by the minute in the air; after landing the pack
// is swapped (Charging) and the drone waits At base with a full one. A drone re-tasked in the air flies on
// from where it is, its old leg cancelled; a recall flies it straight home. The survey flight is a sortie
// too (the 500 photos land while it flies). What a leg the manager sends photographs lowers the map under
// it, photo by photo, at the time each is taken. The cold test: a leg logged "done" the minute it was
// sent, drones "Flying" for two hours on one leg with a frozen battery. Built by lane A.
import type { Drone, FleetState, Leg, MapBase, MapUpdate, MissionEvent } from "../contract";
import { DRONE_FOOTPRINT_M, DRONE_POD, sweep } from "../lib/mission";
import type { SectorNow } from "../lib/api";
import { cellsWithinRadius } from "../search/update";

/** Battery used per minute in the air (a 45-minute pack, kept 10 % in reserve). */
export const DRAIN_PCT_PER_MIN = 2;
/** The lowest a battery reads (the reserve the autopilot lands on). */
export const RESERVE_PCT = 5;
/** Landed: the pack swap before the drone is ready again. */
export const SWAP_MS = 3 * 60_000;
/** Photos a leg takes over its sweep (each a map step under it). */
export const LEG_PHOTOS = 24;

const MIN = 60_000;
type LL = { lat: number; lon: number };

export interface Sortie {
  drone: string;
  /** The leg flown (null: the survey flight or a recall). */
  leg: string | null;
  sector: string | null;
  kind: "survey" | "leg" | "recall";
  /** Launch (or re-task) time, ms. */
  start: number;
  /** The sweep's waypoints (empty for a recall). */
  path: LL[];
  /** How long the sweep takes once there (ms). */
  sweepMs: number;
  /** Whose decision sent it (the timeline names them). */
  by: string;
}

/** Where a drone is and how it is, at one moment. */
export interface DroneNow {
  status: Drone["status"];
  position: LL;
  battery: number;
  leg: string | null;
}

/** Metres between two points (flat earth: a few km). */
function metres(a: LL, b: LL): number {
  const k = Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(a.lat - b.lat, (a.lon - b.lon) * k) * 111_320;
}
const pathLength = (path: readonly LL[]) => path.slice(1).reduce((n, p, i) => n + metres(path[i]!, p), 0);

/** The point a fraction `f` along a path, by distance. */
function along(path: readonly LL[], f: number): LL {
  if (!path.length) return { lat: 0, lon: 0 };
  if (path.length === 1 || f <= 0) return { ...path[0]! };
  const segs = path.slice(1).map((b, i) => metres(path[i]!, b));
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

/** One sortie's times: when it is over its leg, when the sweep ends, when it lands. */
export interface Flight {
  sortie: Sortie;
  from: LL;
  battery0: number;
  there: number;
  swept: number;
  landed: number;
  /** Cut short by the drone's next sortie (re-task or recall) at this time. */
  cut: number | null;
}

/**
 * Every sortie of every drone played out: where each starts (where the drone was), its battery at launch,
 * and its times. `speed` in m/s (the drone's own).
 */
export function flights(drones: readonly Drone[], sorties: readonly Sortie[], home: LL): Flight[] {
  const out: Flight[] = [];
  for (const d of drones) {
    const speed = Math.max(1, d.speed_ms || 8);
    const mine = sorties.filter((s) => s.drone === d.id).sort((a, b) => a.start - b.start);
    let prev: Flight | null = null;
    for (const s of mine) {
      let from = home;
      let battery0 = 100;
      if (prev) {
        if (s.start < prev.landed) {
          // re-tasked (or recalled) in the air: on from where it is, with what is left
          prev.cut = s.start;
          const now = stateIn(prev, s.start, home);
          from = now.position;
          battery0 = now.battery;
        } else if (s.start - prev.landed < SWAP_MS) battery0 = batteryAt(prev, prev.landed);
      }
      const first = s.path[0] ?? home;
      const out1 = (metres(from, first) / speed) * 1000;
      const there = s.start + out1;
      const swept = there + (s.path.length ? s.sweepMs : 0);
      const last = s.path.at(-1) ?? from;
      const landed = swept + (metres(last, home) / speed) * 1000;
      const f: Flight = { sortie: s, from, battery0, there, swept, landed, cut: null };
      out.push(f);
      prev = f;
    }
  }
  return out;
}

const batteryAt = (f: Flight, t: number) => Math.max(RESERVE_PCT, f.battery0 - (DRAIN_PCT_PER_MIN * Math.max(0, Math.min(t, f.landed) - f.sortie.start)) / MIN);

/** A drone during one flight at time `t` (start ≤ t). */
function stateIn(f: Flight, t: number, home: LL): DroneNow {
  const s = f.sortie;
  const battery = batteryAt(f, t);
  if (t < f.there) return { status: "flying", position: along([f.from, s.path[0] ?? home], (t - s.start) / Math.max(1, f.there - s.start)), battery, leg: s.leg };
  if (t < f.swept) return { status: "flying", position: along(s.path, (t - f.there) / Math.max(1, f.swept - f.there)), battery, leg: s.leg };
  if (t < f.landed) return { status: "returning", position: along([s.path.at(-1) ?? f.from, home], (t - f.swept) / Math.max(1, f.landed - f.swept)), battery, leg: s.leg };
  return { status: t - f.landed < SWAP_MS ? "charging" : "idle", position: { ...home }, battery: t - f.landed < SWAP_MS ? battery : 100, leg: null };
}

/** The fleet at time `c`: each drone as its flights put it, each leg flying, done or cancelled. */
export function fleetNow(fleet: FleetState, all: readonly Flight[], c: number, home: LL, legs: readonly Leg[]): FleetState {
  const started = all.filter((f) => f.sortie.start <= c);
  const drones = fleet.drones.map((d) => {
    const mine = started.filter((f) => f.sortie.drone === d.id);
    const f = mine.at(-1);
    if (!f) return { ...d, status: "idle" as const, position: { ...home }, battery_pct: 100, leg_id: null };
    const now = stateIn(f, c, home);
    return { ...d, status: d.status === "offline" ? d.status : now.status, position: now.position, battery_pct: Math.round(now.battery * 10) / 10, leg_id: now.leg };
  });
  const legStatus = (l: Leg): Leg["status"] | null => {
    const f = all.find((x) => x.sortie.leg === l.id);
    if (!f || f.sortie.start > c) return null;
    if (f.cut !== null && f.cut <= c && f.cut < f.swept) return "cancelled";
    return c < f.swept ? "flying" : "done";
  };
  const shown = legs.flatMap((l) => {
    const st = legStatus(l);
    return st ? [{ ...l, status: st }] : [];
  });
  return { ...fleet, drones, legs: shown, updated_at: new Date(c).toISOString().replace(/\.\d+Z$/, "Z") };
}

/** The survey flight: each drone sweeps its share of the sectors between `start` and `end`. */
export function surveySorties(drones: readonly Drone[], sectors: readonly SectorNow[], start: number, end: number, home: LL): Sortie[] {
  const ring = (s: SectorNow) => (s.polygon ?? []) as [number, number][];
  const withRing = [...sectors].filter((s) => ring(s).length > 2).sort((a, b) => a.sector_id.localeCompare(b.sector_id));
  return drones.map((d, i) => {
    const share = withRing.filter((_, k) => k % drones.length === i);
    const path = share.flatMap((s) => sweep(ring(s), 4).map(([lon, lat]) => ({ lat, lon })));
    const speed = Math.max(1, d.speed_ms || 8);
    const outIn = path.length ? ((metres(home, path[0]!) + metres(path.at(-1)!, home)) / speed) * 1000 : 0;
    return { drone: d.id, leg: null, sector: null, kind: "survey" as const, start, path, sweepMs: Math.max(MIN, end - start - outIn - MIN), by: "the survey" };
  });
}

/** A leg as a sortie: its waypoints, its minutes (or until it is known to have ended). */
export function legSortie(l: Leg, start: number, by: string, doneAt: number | null = null, speed = 8): Sortie {
  const path = l.waypoints.map(([lon, lat]) => ({ lat, lon }));
  const own = l.est_minutes > 0 ? l.est_minutes * MIN : (pathLength(path) / speed) * 1000;
  return { drone: l.drone_id, leg: l.id, sector: l.sector_id, kind: "leg", start, path, sweepMs: doneAt !== null ? Math.max(MIN, doneAt - start) : own, by };
}

/** The legs the manager sent on this console ("L005 for Drone 1 over B3 (sent by …)") and the recalls, from their own events. */
export function userSorties(user: readonly MissionEvent[]): Sortie[] {
  const out: Sortie[] = [];
  for (const e of user) {
    if (e.type !== "fleet.updated") continue;
    const at = new Date(e.at).getTime();
    const sent = /^(L\d+) for .+ over \S+ \(sent by (.+)\)$/.exec(e.summary);
    if (sent) {
      const leg = (e.data as unknown as FleetState | null)?.legs.find((l) => l.id === sent[1]);
      if (leg) out.push(legSortie(leg, at, sent[2]!));
      continue;
    }
    const recall = / recalled to base camp by (.+)$/.exec(e.summary);
    if (recall && e.ref) out.push({ drone: e.ref, leg: null, sector: null, kind: "recall", start: at, path: [], sweepMs: 0, by: recall[1]! });
  }
  return out;
}

/** The photos a leg takes over its sweep, each a map step under the drone at the drone's POD (kept, so the map replays incrementally). */
const photoCache = new Map<string, MapUpdate[]>();
export function legPhotos(base: MapBase, f: Flight): MapUpdate[] {
  const s = f.sortie;
  if (s.kind !== "leg" || !s.leg || !s.path.length) return [];
  const key = `${s.leg}|${s.start}|${f.cut ?? ""}`;
  const hit = photoCache.get(key);
  if (hit) return hit;
  const seen = new Set<number>();
  const out: MapUpdate[] = [];
  const end = f.cut !== null ? Math.min(f.cut, f.swept) : f.swept;
  for (let k = 1; k <= LEG_PHOTOS; k++) {
    const t = f.there + ((f.swept - f.there) * k) / LEG_PHOTOS;
    if (t > end) break;
    const p = along(s.path, k / LEG_PHOTOS);
    const cells = cellsWithinRadius(base.grid, p.lat, p.lon, DRONE_FOOTPRINT_M).filter((i) => !seen.has(i));
    for (const i of cells) seen.add(i);
    if (cells.length) out.push({ seq: 800_000 + out.length, kind: "step", source: "frame", ref: `${s.leg}-p${String(k).padStart(2, "0")}`, cells: cells.map((i) => [i, DRONE_POD] as [number, number]), at: new Date(t).toISOString().replace(/\.\d+Z$/, "Z") });
  }
  photoCache.set(key, out);
  return out;
}

/** What the timeline says of a leg as it flies: its sweep done, the drone back at base camp (once each, at its time). */
export function flightNotes(all: readonly Flight[], drones: readonly Drone[], c: number, known: readonly MissionEvent[]): MissionEvent[] {
  const name = (id: string) => drones.find((d) => d.id === id)?.name ?? id;
  const said = (re: RegExp) => known.some((e) => re.test(e.summary));
  const out: MissionEvent[] = [];
  const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
  for (const f of all) {
    const s = f.sortie;
    if (s.kind === "survey") continue;
    if (s.leg && (f.cut === null || f.cut >= f.swept) && f.swept <= c && !said(new RegExp(`leg ${s.leg} .*done`)))
      out.push({ id: `fs-${s.leg}-done`, type: "mission.note", at: iso(f.swept), summary: `${name(s.drone)}: leg ${s.leg}${s.sector ? ` (sector ${s.sector})` : ""} done`, ref: s.leg, data: null });
    if (f.cut === null && f.landed <= c)
      out.push({ id: `fs-${s.drone}-${f.sortie.start}-home`, type: "mission.note", at: iso(f.landed), summary: `${name(s.drone)} back at base camp${s.leg ? ` (${s.leg} done)` : ""}`, ref: s.drone, data: null });
  }
  return out;
}
