// The command view's demo mission (LANE_E §7, E-04): no API needed, so the Vercel site can show it at
// `#m/demo/command`. Fixtures from `scripts/make_command_fixtures.py` (validated against the contract
// there) plus the demo cache's map: its frame steps become the map log, then the two ground searches.
// Everything is a demo and says so on screen. Built by lane A for lane E (#70).
import type { Conditions, MapBase, MapFile, MapUpdate } from "../contract";
import type { MissionData } from "../lib/mission";
import { parseTrace } from "./trace";
import { latestLookup } from "./conditions";
import type { ConditionsData } from "./ConditionsPanel";
import type { TraceRun } from "./TraceView";

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

/**
 * The demo's Trace tab: two recorded runs, not this demo mission's own (its proposals are fixtures with
 * no trace). The showcase chain (`docs/architecture/av-chain`: a 0.18 detection on a val photo, a second
 * look with zoom_native, Nemotron VL's verdict, the promotion, the approval) and a live conditions lookup
 * (`docs/evidence/conditions-live-20261021`: Tavily searches and the extraction). Copied as they were.
 */
export async function loadDemoTrace(): Promise<{ runs: TraceRun[]; imageUrl: (rel: string) => string | null }> {
  const [chain, conditions, crop, zoom] = await Promise.all([
    import("./__fixtures__/demo_trace.jsonl?raw"),
    import("./__fixtures__/demo_trace_conditions.jsonl?raw"),
    import("./__fixtures__/trace_crop.jpg?url"),
    import("./__fixtures__/trace_zoom_native.jpg?url"),
  ]);
  const images: Record<string, string> = { "relook/f0001-d01-crop.jpg": crop.default, "relook/f0001-d01-zoom_native.jpg": zoom.default };
  return {
    runs: [
      { label: "Recorded 21 Oct 2026: a second look on a val photo", source: "docs/architecture/av-chain/trace.jsonl", entries: parseTrace(chain.default) },
      { label: "Recorded 22 Oct 2026: a live conditions lookup", source: "docs/evidence/conditions-live-20261021/trace.jsonl", entries: parseTrace(conditions.default) },
    ],
    imageUrl: (rel) => images[rel] ?? null,
  };
}

/**
 * The demo console's Conditions panel: a real recorded lookup (docs/evidence/conditions-live-20261021: its
 * conditions.json and trace.jsonl, copied as they were). The demo mission's own conditions are a fixture
 * with no sources, so the panel says it shows the recorded run instead.
 */
export async function loadDemoConditions(): Promise<ConditionsData> {
  const [c, trace] = await Promise.all([import("./__fixtures__/demo_conditions_recorded.json"), import("./__fixtures__/demo_trace_conditions.jsonl?raw")]);
  const conditions = c.default as unknown as Conditions;
  return {
    conditions,
    lookup: latestLookup(parseTrace(trace.default)),
    recorded: `Recorded live lookup for Mount Seymour, ${conditions.fetched_at.slice(0, 10)} ${conditions.fetched_at.slice(11, 16)} UTC (the demo mission's own conditions are a fixture with no sources)`,
    limitKmh: null,
    drone: null,
  };
}
