// Scenarios on the demo mission (`#m/demo?s=<seed>`): four named presets and any other seed, each a
// different search on the same ground and the same photos. A scenario fixture written by the demo fixture
// generator (`__fixtures__/scenarios/<seed>.json`, the same shape as demo_mission.json) is used as it is;
// until one exists for a seed, the scenario is derived here, deterministically, from the demo mission: the
// last known point and its prior move, base camp moves with it, the clues are the scenario's own (each
// reweights the map around where it was found, as the server does), and the agent's three assignments go
// to the three likeliest open sectors on that map. Pure apart from the fixture lookup. Built by lane A.
import type { Clue, Conditions, MapBase, MapUpdate, Mission, MissionEvent, Proposal, SectorTask } from "../contract";
import { cellsWithinRadius } from "../search/update";
import type { DemoFull } from "./missionTime";
import { BOARD_AT, sectorsAt } from "./missionTime";

export interface Preset {
  seed: string;
  /** The generator's seed for this scenario (Mission.scenario_seed). */
  num: number;
  name: string;
  subject: string;
  /** The last known point's move from the demo's, in cells (rows south, columns east). */
  shift: [number, number];
  /** Base camp from the new last known point, in cells. */
  camp: [number, number];
  /** How far the subject's profile tends to travel (metres): the spread of the prior around the last known point. */
  spreadM: number;
  /** The scenario's four clues, in the demo's clue order (their times), placed from the last known point in cells. */
  clues: { kind: Clue["kind"]; text: string; at: [number, number] }[];
}

export const DEFAULT_SEED = "overdue-hiker";

export const PRESETS: readonly Preset[] = [
  {
    seed: DEFAULT_SEED, num: 1101, name: "Overdue hiker", subject: "adult, red jacket, day hiker", shift: [0, 0], camp: [0, 0], spreadM: 0,
    clues: [],
  },
  {
    seed: "missing-child", num: 2202, name: "Missing child", subject: "child, 7, blue rain jacket, wandered from a picnic", shift: [-14, -18], camp: [8, -10], spreadM: 220,
    clues: [
      { kind: "other", text: "parent last saw her by the picnic tables heading for the creek", at: [2, 4] },
      { kind: "object", text: "small blue mitten on the creek trail", at: [10, 14] },
      { kind: "track", text: "small shoe prints in the mud going downhill", at: [18, 20] },
      { kind: "sound", text: "possible crying heard to the south-east", at: [26, 28] },
    ],
  },
  {
    seed: "despondent", num: 3303, name: "Despondent", subject: "adult, 45, grey coat, left a note in the car", shift: [16, 18], camp: [-12, -14], spreadM: 380,
    clues: [
      { kind: "other", text: "note in the car mentions the viewpoint", at: [-8, -6] },
      { kind: "object", text: "grey scarf on the viewpoint bench", at: [6, 10] },
      { kind: "track", text: "boot prints off-trail toward the bluffs", at: [12, 18] },
      { kind: "sound", text: "phone last pinged near the bluffs, 300 m accuracy", at: [10, 22] },
    ],
  },
  {
    seed: "dementia", num: 4404, name: "Dementia walk-away", subject: "adult, 78, dementia, slippers, walked from the care home", shift: [12, -16], camp: [-6, 8], spreadM: 160,
    clues: [
      { kind: "other", text: "care home staff saw him at the back gate at 11:00", at: [-2, 2] },
      { kind: "object", text: "a slipper on the service road", at: [8, -4] },
      { kind: "track", text: "shuffling prints along the road shoulder", at: [14, -10] },
      { kind: "sound", text: "a voice heard calling a name, west of the road", at: [20, -18] },
    ],
  },
];

/** A seed's preset, or one derived from it (a shuffle): the same seed always gives the same scenario. */
export function presetFor(seed: string | null | undefined): Preset {
  const named = PRESETS.find((p) => p.seed === (seed || DEFAULT_SEED));
  if (named) return named;
  const r = rng(seed!);
  const base = PRESETS[1 + Math.floor(r() * 3)]!;
  const j = () => Math.round((r() - 0.5) * 30);
  return { ...base, seed: seed!, num: Math.floor(r() * 9000) + 1000, name: `Shuffled (${base.name.toLowerCase()})`, shift: [j(), j()], camp: [Math.round((r() - 0.5) * 30), Math.round((r() - 0.5) * 30)], spreadM: 150 + Math.round(r() * 300) };
}

/** A new random seed for Shuffle. */
export const shuffleSeed = () => `s${Math.floor(Math.random() * 1e6).toString(36)}`;

/** mulberry32 over the seed's characters: small, deterministic, good enough to place a scenario. */
function rng(seed: string): () => number {
  let a = [...seed].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 2654435761) >>> 0, 1779033703);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const M_PER_DEG = 111_320;
const move = (base: MapBase, lat: number, lon: number, [dr, dc]: [number, number]) => ({
  lat: lat - (dr * base.grid.cell_m) / M_PER_DEG,
  lon: lon + (dc * base.grid.cell_m) / (M_PER_DEG * Math.cos((base.grid.origin_nw.lat * Math.PI) / 180)),
});

/**
 * The scenario's prior: the last known point moved by whole cells, and the probability spread around it the
 * way the subject's profile travels (a Gaussian of `spreadM`, on the same share of the probability inside
 * the grid as the demo's), so each scenario's heat has its own centre and its own reach.
 */
export function shiftPrior(base: MapBase, [dr, dc]: [number, number], spreadM = 300): MapBase {
  if (!dr && !dc && !spreadM) return base;
  const { rows, cols, cell_m } = base.grid;
  const lkp = move(base, base.lkp.lat, base.lkp.lon, [dr, dc]);
  const r0 = (base.grid.origin_nw.lat - lkp.lat) * (M_PER_DEG / cell_m) - 0.5;
  const c0 = (lkp.lon - base.grid.origin_nw.lon) * ((M_PER_DEG * Math.cos((base.grid.origin_nw.lat * Math.PI) / 180)) / cell_m) - 0.5;
  const s = Math.max(1, spreadM / cell_m);
  const out = new Array<number>(rows * cols);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out[r * cols + c] = Math.exp(-((r - r0) ** 2 + (c - c0) ** 2) / (2 * s * s)) + 1e-6;
  const inside = base.prior.p.reduce((a, b) => a + b, 0);
  const now = out.reduce((a, b) => a + b, 0);
  return { ...base, lkp, prior: { ...base.prior, p: out.map((v) => (v * inside) / now) } };
}

/** Swap sector ids everywhere in a value (fields that are an id, and ids named inside text). */
function remap<T>(value: T, ids: ReadonlyMap<string, string>): T {
  if (ids.size === 0) return value;
  const re = new RegExp(`\\b(${[...ids.keys()].join("|")})\\b`, "g");
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return ids.get(v) ?? v.replace(re, (m) => ids.get(m) ?? m);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "polygon" || k === "cells" || k === "waypoints" ? x : walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** The demo mission as a scenario: derived from the demo's own (see the file's head). */
export function deriveScenario(full: DemoFull, preset: Preset): DemoFull {
  const d = full.data;
  if (preset.seed === DEFAULT_SEED || !d.mapBase || !d.mission) return withSeed(full, preset);
  const base = shiftPrior(d.mapBase, preset.shift, preset.spreadM);
  const camp = move(base, base.lkp.lat, base.lkp.lon, preset.camp);
  // the scenario's clues, at the demo's clue times, each reweighting the map as the demo's did
  const oldClues = d.clues ?? [];
  const clues: Clue[] = oldClues.map((c, i) => {
    const sc = preset.clues[i];
    if (!sc) return c;
    const at = move(base, base.lkp.lat, base.lkp.lon, sc.at);
    return { ...c, kind: sc.kind, text: sc.text, lat: at.lat, lon: at.lon };
  });
  const updates: MapUpdate[] = (d.mapUpdates ?? []).map((u) => {
    if (u.source !== "clue") return u;
    const c = clues.find((x) => x.id === u.ref);
    if (!c) return u;
    const factor = u.cells[0]?.[1] ?? 1.5;
    return { ...u, cells: cellsWithinRadius(base.grid, c.lat, c.lon, c.radius_m).map((i) => [i, factor] as [number, number]) };
  });
  const events: MissionEvent[] = (d.events ?? []).map((e) => {
    if (e.type === "clue.added") {
      const c = clues.find((x) => x.id === e.ref);
      return c ? { ...e, summary: `${c.kind}: ${c.text}`, data: c as unknown as MissionEvent["data"] } : e;
    }
    if (e.type === "map.updated" && e.data) {
      const u = updates.find((x) => x.seq === (e.data as unknown as MapUpdate).seq);
      return u ? { ...e, data: u as unknown as MissionEvent["data"] } : e;
    }
    return e;
  });
  // the clues by radio: the teams' words say the scenario's clues
  const byRadio = clues.filter((c) => c.source === "radio");
  let k = 0;
  const radioEvents = events.map((e) => {
    if (e.type !== "radio.turn" || !e.data) return e;
    const c = byRadio[k++];
    if (!c) return e;
    const t = e.data as Record<string, unknown>;
    const cs = String(t.callsign ?? "");
    return { ...e, summary: `${cs}, Sightline. Copy ${c.text}. Confirm, over.`, data: { ...t, transcript: `Sightline, ${cs}. ${c.text[0]!.toUpperCase()}${c.text.slice(1)}, over.`, reply: `${cs}, Sightline. Copy ${c.text}, logging it as a clue. Confirm, over.` } };
  });
  const mission: Mission = { ...d.mission, subject: preset.subject, area: { ...d.mission.area, lkp: base.lkp }, base_camp: { lat: camp.lat, lon: camp.lon, name: "Base camp" } };
  return withSeed({ now: full.now, data: { ...d, mission, mapBase: base, mapUpdates: updates, clues, ...replan({ ...d, events: radioEvents }, base, updates, "derived for this scenario") } }, preset);
}

/**
 * The agent's assignments re-planned on a new map (`base`, with its updates): each goes to the likeliest
 * open sectors at the planner's tick, the sector ids swapped everywhere they are named, and each sector's
 * POA read from that map. `why` closes the proposal's reason ("derived for this scenario").
 */
export function replan(d: DemoFull["data"], base: MapBase, updates: MapUpdate[], why: string): Pick<DemoFull["data"], "sectors" | "events" | "proposals" | "tasks" | "fleet"> {
  const assigns = (d.proposals ?? []).filter((p) => p.kind === "assign_sector" && p.target.sector);
  const fixed = new Set((d.tasks ?? []).filter((t) => t.state === "searched").map((t) => t.sector_id));
  const board = sectorsAt(base, d.sectors ?? [], updates.filter((u) => u.source !== "ground" && new Date(u.at).getTime() <= new Date(BOARD_AT).getTime()));
  const best = [...board].filter((s) => !fixed.has(s.sector_id)).sort((a, b) => b.poa - a.poa);
  const ids = new Map<string, string>();
  assigns.forEach((p, i) => {
    const to = best[i]?.sector_id;
    const from = p.target.sector!;
    if (to && to !== from) ids.set(from, to);
  });
  // a swap needs both directions (C2 → B3 and B3 → C2), so the ids stay unique
  for (const [from, to] of [...ids]) if (!ids.has(to)) ids.set(to, from);
  const poaOf = new Map(board.map((s) => [s.sector_id, s.poa]));
  const proposals: Proposal[] = remap(d.proposals ?? [], ids).map((p) =>
    p.kind === "assign_sector" && p.target.sector
      ? { ...p, reason: `${p.target.sector} holds ${((poaOf.get(p.target.sector) ?? 0) * 100).toFixed(1)} % of the probability on the map now, the most of any open sector with a team free; a ground team adds the most there (${why}).` }
      : p,
  );
  return {
    // each sector's POA on this map (the fixture's are its own)
    sectors: sectorsAt(base, d.sectors ?? [], updates),
    events: remap(d.events ?? [], ids),
    proposals,
    tasks: remap(d.tasks ?? [], ids) as SectorTask[],
    fleet: d.fleet ? remap(d.fleet, ids) : d.fleet,
  };
}

/** The grid cell a point falls in, as fractional (row, column) of its centre-based index. */
function cellOf(base: MapBase, p: { lat: number; lon: number }): [number, number] {
  const { cell_m, origin_nw } = base.grid;
  return [(origin_nw.lat - p.lat) * (M_PER_DEG / cell_m) - 0.5, (p.lon - origin_nw.lon) * ((M_PER_DEG * Math.cos((origin_nw.lat * Math.PI) / 180)) / cell_m) - 0.5];
}

/**
 * The prior carried to a new last known point (open play): the same shape (the profile's own prior, its
 * rings or its spread), moved by whole cells so it sits around `lkp`; the cells it leaves take the prior's
 * floor, and the share of the probability inside the grid stays as it was.
 */
export function movePrior(base: MapBase, lkp: { lat: number; lon: number }): MapBase {
  const { rows, cols } = base.grid;
  const [r0, c0] = cellOf(base, base.lkp);
  const [r1, c1] = cellOf(base, lkp);
  const dr = Math.round(r1 - r0);
  const dc = Math.round(c1 - c0);
  const p = base.prior.p;
  if (!dr && !dc) return { ...base, lkp: { lat: lkp.lat, lon: lkp.lon } };
  const floor = p.reduce((a, b) => Math.min(a, b), Infinity);
  const out = new Array<number>(rows * cols);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const rr = r - dr;
      const cc = c - dc;
      out[r * cols + c] = rr >= 0 && rr < rows && cc >= 0 && cc < cols ? p[rr * cols + cc]! : floor;
    }
  const inside = p.reduce((a, b) => a + b, 0);
  const now = out.reduce((a, b) => a + b, 0);
  return { ...base, lkp: { lat: lkp.lat, lon: lkp.lon }, prior: { ...base.prior, p: now > 0 ? out.map((v) => (v * inside) / now) : out } };
}

function withSeed(full: DemoFull, preset: Preset): DemoFull {
  const m = full.data.mission;
  return m ? { ...full, data: { ...full.data, mission: { ...m, scenario_seed: preset.num } } } : full;
}

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
/**
 * The sun's times are the ground's, not the mission's: a scenario moved onto the demo's afternoon keeps the
 * day's sunset and civil twilight (every fixture is dated 24 Oct at Mount Seymour), so they never move.
 */
const SUN_KEYS = new Set(["sunset", "civil_twilight_end", "flyable_until"]);
/** Every timestamp in a fixture moved by `ms` (but the sun's). */
export function shiftTimes<T>(value: T, ms: number): T {
  if (!ms) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return ISO.test(v) ? new Date(new Date(v).getTime() + ms).toISOString().replace(/\.\d+Z$/, "Z") : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SUN_KEYS.has(k) ? x : walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/**
 * A reading with no sun times (the scenarios' last one, the gusts) keeps the day's from the reading before
 * it: the sun sets at the same time whatever the wind does (usability test round 2: Missing child showed
 * daylight "–" and light "unknown").
 */
export function withSunTimes(full: DemoFull): DemoFull {
  const d = full.data;
  const c = d.conditions;
  if (!c || (c.sunset && c.civil_twilight_end)) return full;
  const known = (d.events ?? [])
    .filter((e) => e.type === "conditions.updated" && e.data)
    .map((e) => e.data as unknown as Conditions)
    .filter((x) => x.sunset || x.civil_twilight_end)
    .at(-1);
  if (!known) return full;
  return { ...full, data: { ...d, conditions: { ...c, sunset: c.sunset ?? known.sunset, civil_twilight_end: c.civil_twilight_end ?? known.civil_twilight_end } } };
}

/** Scenario fixtures from the generator, when there are any (lazy: each its own chunk). */
const FIXTURES = import.meta.glob<{ default: unknown }>("./__fixtures__/scenarios/*.json");

/**
 * The demo mission as the scenario `seed`: the generator's fixture for it when there is one (`load` turns
 * a fixture into the mission, as loadDemoMission does), else derived from the demo mission.
 */
export async function scenarioMission(full: DemoFull, seed: string | null | undefined, load?: (fixture: unknown) => Promise<DemoFull>): Promise<DemoFull> {
  const preset = presetFor(seed);
  const file = FIXTURES[`./__fixtures__/scenarios/${preset.seed}.json`];
  if (file && load && preset.seed !== DEFAULT_SEED) {
    try {
      const fx = (await file()).default as { t0?: string; mission?: { created_at?: string } };
      // a scenario keeps the demo's rhythm (the call, the flight 12 to 48 minutes later, the run at 90) on its
      // own afternoon: move it onto the demo mission's, so the story's checkpoints fall at the same moments
      const from = fx.t0 ?? fx.mission?.created_at;
      const to = full.data.mission?.created_at;
      const shifted = from && to ? shiftTimes(fx, new Date(to).getTime() - new Date(from).getTime()) : fx;
      return withSeed(withSunTimes(await load(shifted)), preset);
    } catch {
      /* a broken fixture: derive it instead */
    }
  }
  return deriveScenario(full, preset);
}
