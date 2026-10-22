// The command view's demo mission (LANE_E §7, E-04): no API needed, so the Vercel site can show it at
// `#m/demo/command`. Fixtures from `scripts/make_command_fixtures.py` (validated against the contract
// there) plus the demo cache's map: its frame steps become the map log, then the two ground searches.
// Everything is a demo and says so on screen. Built by lane A for lane E (#70).
import type { MapBase, MapFile, MapUpdate } from "../contract";
import type { MissionData } from "../lib/mission";

export const DEMO_MISSION_ID = "demo";
export const DEMO_CACHE = "/cache/demo";

type Fixture = Pick<MissionData, "mission" | "teams" | "tasks" | "clues" | "proposals" | "conditions" | "events" | "sectors"> & {
  now: string;
  ground_updates: MapUpdate[];
};

/** The map log for a cache's map file: one frame step per photo, in flight order. */
export function cacheUpdates(map: MapFile, at: string): MapUpdate[] {
  return map.steps.map((s, k) => ({ seq: k + 1, kind: "step", source: "frame", ref: s.frame_id, cells: s.cells, canopy: null, at }));
}

export function cacheBase(map: MapFile): MapBase {
  const { contract_version, grid, lkp, params, prior, canopy } = map;
  return { contract_version, grid, lkp, params, prior, canopy };
}

export async function loadDemoMission(
  fetchFn: typeof fetch = fetch,
  fixture: () => Promise<Fixture> = async () => (await import("./__fixtures__/demo_mission.json")).default as unknown as Fixture,
): Promise<{ data: Partial<MissionData>; now: string }> {
  const [fx, map] = await Promise.all([
    fixture(),
    fetchFn(`${DEMO_CACHE}/map.json`).then((r) => {
      if (!r.ok) throw new Error(`the demo map is missing (${r.status})`);
      return r.json() as Promise<MapFile>;
    }),
  ]);
  const frames = cacheUpdates(map, fx.mission?.created_at ?? fx.now);
  const { now, ground_updates, ...rest } = fx;
  return {
    data: { ...rest, verdicts: [], fleet: null, mapBase: cacheBase(map), mapUpdates: [...frames, ...ground_updates] },
    now,
  };
}
