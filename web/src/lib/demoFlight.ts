// The demo's drone legs fly (no server): a leg sent from the console's sector popover takes off from base
// camp, sweeps its sector, photographs the ground as it goes and lands back at base camp. Each photo is a
// map step over the drone's footprint at the drone's POD, so the heat lowers under the leg photo by photo
// and rises everywhere else (the same Bayesian step the server applies). Every tick is a demo event, so
// the story's replay keeps the flight. Wall-clock time: about 18 s a leg. Built by lane A.
import type { FleetState, MapUpdate } from "../contract";
import { TRAILHEAD } from "../command/missionTime";
import { alongPath, type LonLat } from "../map/base/fleetMotion";
import { cellsWithinRadius } from "../search/update";
import { demoFlights, DRONE_FOOTPRINT_M, DRONE_POD, useMission } from "./mission";

/** Ticks a leg takes (one fleet report each), and how far apart in ms. */
export const FLIGHT_TICKS = 30;
export const TICK_MS = 600;

const timers = new Map<string, number>();

/**
 * When the demo's clock runs (the guided search, a played clock), a leg flies by that clock instead
 * (command/fleetSim.ts, in missionTime's demoAt): no wall-clock ticks, which were all stamped with the paused
 * clock (the cold test: a leg "done" the minute it was sent).
 */
let clocked = false;
export function setClockedFlights(on: boolean): void {
  clocked = on;
  if (on) stopAllDemoFlights();
}

/** Where drones launch and land: the mission's base camp, else the trailhead lot. */
export function baseCamp(): { lat: number; lon: number } {
  const b = useMission.getState().mission?.base_camp;
  return b ? { lat: b.lat, lon: b.lon } : { ...TRAILHEAD };
}

export function startDemoFlight(legId: string, ticks = FLIGHT_TICKS, ms = TICK_MS): void {
  if (clocked || timers.has(legId) || typeof window === "undefined") return;
  const store = useMission.getState;
  const fleet0 = store().fleet;
  const leg = fleet0?.legs.find((l) => l.id === legId);
  if (!fleet0 || !leg) return;
  const home = baseCamp();
  const sweep: LonLat[] = leg.waypoints.map(([lon, lat]) => [lon, lat]);
  const path: LonLat[] = [[home.lon, home.lat], ...sweep, [home.lon, home.lat]];
  // the share of the path that is the sweep (photos are taken only there)
  const lens = path.slice(1).map((p, i) => Math.hypot(p[0] - path[i]![0], p[1] - path[i]![1]));
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  const sweepFrom = lens[0]! / total;
  const sweepTo = 1 - lens.at(-1)! / total;
  const seen = new Set<number>();
  let k = 0;
  const tick = () => {
    const s = store();
    if (s.status !== "demo" || !s.fleet?.legs.some((l) => l.id === legId)) return stop(legId);
    k += 1;
    const f = Math.min(1, k / ticks);
    const [lon, lat] = alongPath(path, f);
    const done = f >= 1;
    const fleet: FleetState = {
      ...s.fleet,
      legs: s.fleet.legs.map((l) => (l.id === legId ? { ...l, status: done ? "done" : "flying" } : l)),
      drones: s.fleet.drones.map((d) =>
        d.id === leg.drone_id
          ? { ...d, position: { lat, lon }, battery_pct: Math.max(5, d.battery_pct - 0.4), status: done ? "idle" : "flying", leg_id: done ? null : legId }
          : d,
      ),
    };
    s.emit("fleet.updated", done ? `${leg.drone_id} back at base camp (${legId} done)` : `${leg.drone_id} on ${legId}`, legId, fleet);
    const base = s.mapBase;
    if (base && f > sweepFrom && f <= sweepTo + 1e-9) {
      const cells = cellsWithinRadius(base.grid, lat, lon, DRONE_FOOTPRINT_M).filter((i) => !seen.has(i));
      for (const i of cells) seen.add(i);
      if (cells.length) {
        const seq = (s.mapUpdates.at(-1)?.seq ?? 0) + 1;
        const u: MapUpdate = { seq, kind: "step", source: "frame", ref: `${legId}-p${String(k).padStart(2, "0")}`, cells: cells.map((i) => [i, DRONE_POD] as [number, number]), at: fleet.updated_at };
        s.emit("map.updated", `map update ${seq} (photo ${u.ref})`, u.ref, u);
      }
    }
    if (done) stop(legId);
  };
  timers.set(legId, window.setInterval(tick, ms));
}

export function stop(legId: string): void {
  const t = timers.get(legId);
  if (t !== undefined) window.clearInterval(t);
  timers.delete(legId);
}

export function stopAllDemoFlights(): void {
  for (const id of [...timers.keys()]) stop(id);
}

demoFlights.start = (id) => startDemoFlight(id);
demoFlights.stop = (id) => stop(id);
