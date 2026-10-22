// The command view's demo mission (LANE_E §7, E-04): no API needed, so the Vercel site can show it at
// the landing (`#m/demo`). Fixtures from `scripts/make_command_fixtures.py` (validated against the contract
// there) plus the demo cache's map: its frame steps become the map log, then the clues and the ground searches.
// Everything is a demo and says so on screen. Built by lane A for lane E (#70).
import type { Conditions, MapBase, MapFile, MapUpdate } from "../contract";
import type { MissionData } from "../lib/mission";
import { parseTrace } from "./trace";
import { latestLookup } from "./conditions";
import type { ConditionsData } from "./ConditionsPanel";
import type { TraceRun } from "./TraceView";
import cropUrl from "./__fixtures__/trace_crop.jpg?url";
import zoomUrl from "./__fixtures__/trace_zoom_native.jpg?url";

export const DEMO_MISSION_ID = "demo";
export const DEMO_CACHE = "/cache/demo";

type Fixture = Pick<MissionData, "mission" | "teams" | "tasks" | "clues" | "proposals" | "conditions" | "events" | "sectors"> & {
  /** The simulated fleet (scripts/make_fleet_fixture.py); null in an older fixture. */
  fleet?: MissionData["fleet"];
  now: string;
  /** The map log after the cache's frame steps: the clues' reweights and the ground searches, as the API logged them. */
  map_updates: MapUpdate[];
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
  /** The demo cache's map when it is already loaded (the console loads the whole cache for its rails). */
  loaded?: Promise<MapFile>,
): Promise<{ data: Partial<MissionData>; now: string }> {
  const [fx, map] = await Promise.all([
    fixture(),
    loaded ?? fetchFn(`${DEMO_CACHE}/map.json`).then((r) => {
      if (!r.ok) throw new Error(`the demo map is missing (${r.status})`);
      return r.json() as Promise<MapFile>;
    }),
  ]);
  const frames = cacheUpdates(map, fx.mission?.created_at ?? fx.now);
  const { now, map_updates, ...rest } = fx;
  return {
    data: { ...rest, verdicts: [], fleet: fx.fleet ?? null, mapBase: cacheBase(map), mapUpdates: [...frames, ...map_updates] },
    now,
  };
}

/** The second look's images: the demo mission's own (`__fixtures__/relook/`, from the generator's run) and the recorded av-chain's two. */
const RELOOK_IMAGES: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(import.meta.glob<string>("./__fixtures__/relook/*.jpg", { query: "?url", import: "default", eager: true })).map(([path, url]) => [
      `relook/${path.split("/").pop()}`,
      url,
    ]),
  ),
  "relook/f0001-d01-crop.jpg": cropUrl,
  "relook/f0001-d01-zoom_native.jpg": zoomUrl,
};

/** An evidence image on the demo: a second look's image from the fixtures, else a file of the demo cache. */
export function demoImageUrl(rel: string): string {
  return RELOOK_IMAGES[rel] ?? `${DEMO_CACHE}/${rel}`;
}

/** The label the demo mission's own trace carries: run through the product, with fake models, scripted people. */
export const DEMO_TRACE_LABEL =
  "This demo mission's own trace: the mission API and the agent's code, run offline by scripts/make_command_fixtures.py with fake models (scripted VL answers and briefings) and a scripted search manager and image reviewer";

/**
 * The demo's Trace tab: the demo mission's own trace first (`__fixtures__/demo_trace.jsonl`, written by
 * `scripts/make_command_fixtures.py` with the fixture: every proposal in it has its chain, from the tool
 * and model calls to the scripted decision), then two recorded runs copied as they were: the showcase
 * chain (`docs/architecture/av-chain`: a 0.18 detection on a val photo, a second look with zoom_native,
 * Nemotron VL's verdict, the promotion, the approval) and a live conditions lookup
 * (`docs/evidence/conditions-live-20261021`: Tavily searches and the extraction).
 */
export async function loadDemoTrace(): Promise<{ runs: TraceRun[]; imageUrl: (rel: string) => string | null }> {
  const [own, chain, conditions] = await Promise.all([
    import("./__fixtures__/demo_trace.jsonl?raw"),
    import("./__fixtures__/demo_trace_avchain.jsonl?raw"),
    import("./__fixtures__/demo_trace_conditions.jsonl?raw"),
  ]);
  return {
    runs: [
      { label: DEMO_TRACE_LABEL, source: "web/src/command/__fixtures__/demo_trace.jsonl", mode: "demo", entries: parseTrace(own.default) },
      { label: "Recorded 21 Oct 2026: a second look on a val photo", source: "docs/architecture/av-chain/trace.jsonl", entries: parseTrace(chain.default) },
      { label: "Recorded 22 Oct 2026: a live conditions lookup", source: "docs/evidence/conditions-live-20261021/trace.jsonl", entries: parseTrace(conditions.default) },
    ],
    imageUrl: (rel) => RELOOK_IMAGES[rel] ?? null,
  };
}

/**
 * The demo console's Conditions panel: a real recorded lookup (docs/evidence/conditions-live-20261021: its
 * conditions.json and trace.jsonl, copied as they were). The demo mission's own conditions are a fixture
 * with no sources, so the panel says it shows the recorded run instead.
 */
/**
 * The demo console's Conditions panel, telling the same story as its conditions row: the demo mission's
 * own conditions (a fixture, so no quotes) on top, and the real recorded lookup folded under them as an
 * example of how sources are read, on its own evening with its own verdict.
 */
export function demoConditionsData(own: Conditions, example: ConditionsData, limit: { kmh: number | null; drone: string | null } = { kmh: null, drone: null }): ConditionsData {
  return {
    conditions: own,
    lookup: null,
    recorded: null,
    fixture: "The demo mission's own conditions: a fixture, no pages read",
    example,
    limitKmh: limit.kmh,
    drone: limit.drone,
  };
}

export async function loadDemoConditions(): Promise<ConditionsData> {
  const [c, trace] = await Promise.all([import("./__fixtures__/demo_conditions_recorded.json"), import("./__fixtures__/demo_trace_conditions.jsonl?raw")]);
  const conditions = c.default as unknown as Conditions;
  return {
    conditions,
    lookup: latestLookup(parseTrace(trace.default)),
    recorded: `Recorded live lookup for Mount Seymour, ${conditions.fetched_at.slice(0, 10)} ${conditions.fetched_at.slice(11, 16)} UTC`,
    limitKmh: null,
    drone: null,
  };
}
