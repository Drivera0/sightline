// Open play (`#play`): the visitor sets up their own search before the console opens on it. The setup is
// a checklist of six steps (who is missing, where they were last seen, base camp, ground teams, drones and
// their photos, review); this file is its model, pure: the steps and when each is done, the search area
// and the staging points it can use, and the setup remembered in this browser. openPlayMission.ts applies a
// setup to the mission; front/OpenPlay.tsx is the page. Built by lane A.
//
// What a setup can change is bounded by what the site carries: the drone survey's photos and the 1 km
// search grid are on Mount Seymour, so the last known point goes anywhere inside that grid, and base camp
// is one of the staging points the scenario generator uses (sightline/search/demo_scenario.py, STAGING).
import { PRESETS } from "./scenarios";
import { SCENARIO_CARDS } from "../front/scenarios";
import { scenarioHash } from "../shell/flow";

/** The seed free play runs an open-play setup under (`#m/demo/map?s=play`). */
export const PLAY_SEED = "play";
/** The console on the visitor's own setup: free play, paused at the call. */
export const PLAY_CONSOLE_HASH = scenarioHash(PLAY_SEED, false);

/**
 * The surveyed search area: the demo cache's grid (public/cache/demo/map.json: 200 × 200 cells of 5 m from
 * this north-west corner), split into 16 sectors of 250 m (A–D west to east, 1–4 north to south).
 */
export const SEARCH_AREA = { origin_nw: { lat: 49.374492, lon: -122.951898 }, cell_m: 5, rows: 200, cols: 200 } as const;
const M_PER_DEG = 111_320;
const M_PER_DEG_LON = M_PER_DEG * Math.cos((SEARCH_AREA.origin_nw.lat * Math.PI) / 180);
/** The area's edges in degrees. */
export const AREA_BOUNDS = {
  north: SEARCH_AREA.origin_nw.lat,
  south: SEARCH_AREA.origin_nw.lat - (SEARCH_AREA.rows * SEARCH_AREA.cell_m) / M_PER_DEG,
  west: SEARCH_AREA.origin_nw.lon,
  east: SEARCH_AREA.origin_nw.lon + (SEARCH_AREA.cols * SEARCH_AREA.cell_m) / M_PER_DEG_LON,
} as const;
/** The area in words, from the grid's own size. */
export const AREA_WORDS = `${(SEARCH_AREA.rows * SEARCH_AREA.cell_m) / 1000} km × ${(SEARCH_AREA.cols * SEARCH_AREA.cell_m) / 1000} km, 16 sectors of ${(SEARCH_AREA.rows * SEARCH_AREA.cell_m) / 4} m`;

export interface LatLon {
  lat: number;
  lon: number;
}

/** The sectors as [id, ring] (lon/lat), for the map preview. */
export function sectorRings(): { id: string; ring: [number, number][] }[] {
  const { north, south, west, east } = AREA_BOUNDS;
  const out: { id: string; ring: [number, number][] }[] = [];
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) {
      const n = north - ((north - south) * r) / 4;
      const s = north - ((north - south) * (r + 1)) / 4;
      const w = west + ((east - west) * c) / 4;
      const e = west + ((east - west) * (c + 1)) / 4;
      out.push({ id: `${"ABCD"[c]}${r + 1}`, ring: [[w, n], [e, n], [e, s], [w, s], [w, n]] });
    }
  return out;
}

/** Inside the surveyed area. */
export function inArea(p: LatLon): boolean {
  return p.lat <= AREA_BOUNDS.north && p.lat >= AREA_BOUNDS.south && p.lon >= AREA_BOUNDS.west && p.lon <= AREA_BOUNDS.east;
}

/** A point moved to the nearest place inside the surveyed area (half a cell in from the edge). */
export function snapToArea(p: LatLon): LatLon {
  const inLat = (SEARCH_AREA.cell_m / 2) / M_PER_DEG;
  const inLon = (SEARCH_AREA.cell_m / 2) / M_PER_DEG_LON;
  const lat = Math.min(AREA_BOUNDS.north - inLat, Math.max(AREA_BOUNDS.south + inLat, p.lat));
  const lon = Math.min(AREA_BOUNDS.east - inLon, Math.max(AREA_BOUNDS.west + inLon, p.lon));
  return { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) };
}

/** The sector a point is in ("C2"), or null outside the area. */
export function sectorOf(p: LatLon): string | null {
  if (!inArea(p)) return null;
  const c = Math.min(3, Math.floor(((p.lon - AREA_BOUNDS.west) / (AREA_BOUNDS.east - AREA_BOUNDS.west)) * 4));
  const r = Math.min(3, Math.floor(((AREA_BOUNDS.north - p.lat) / (AREA_BOUNDS.north - AREA_BOUNDS.south)) * 4));
  return `${"ABCD"[c]}${r + 1}`;
}

/** Where a team can drive to and the drones launch from: the generator's staging points (demo_scenario.py STAGING). */
export const STAGING: readonly { name: string; lat: number; lon: number; note: string }[] = [
  { name: "Trailhead lot", lat: 49.36585, lon: -122.9484, note: "at the area's south edge, by the trail" },
  { name: "Viewpoint lot", lat: 49.36416, lon: -122.94832, note: "on Mount Seymour Road, below the area" },
  { name: "Creek bridge pull-out", lat: 49.36186, lon: -122.9508, note: "on Mount Seymour Road, by the creek" },
  { name: "Power-line access", lat: 49.3608, lon: -122.95297, note: "on Mount Seymour Road, the lowest stop" },
];

/** Metres between two points (flat earth: a few km). */
export function metres(a: LatLon, b: LatLon): number {
  return Math.hypot((a.lat - b.lat) * M_PER_DEG, (a.lon - b.lon) * M_PER_DEG_LON);
}

/** A profile: one of the scenario presets, the subject's words as its scenario says them, and how its prior was made. */
export interface Profile {
  seed: string;
  name: string;
  subject: string;
  /** Where the probability map starts, in words (sightline/search/demo_scenario.py: the prior's source per category). */
  prior: string;
  /** The prior is shaped around the last known point (distance rings); false: even over the area. */
  rings: boolean;
}

/** Only hikers and dementia have checked Koester distance rings; the others use the labelled even placeholder. */
const RINGS = new Set(["overdue-hiker", "dementia"]);
export const PROFILES: readonly Profile[] = PRESETS.map((p) => ({
  seed: p.seed,
  name: p.name,
  subject: SCENARIO_CARDS.find((c) => c.seed === p.seed)?.subject ?? p.subject,
  rings: RINGS.has(p.seed),
  prior: RINGS.has(p.seed)
    ? "Koester lost-person distance rings for this category, centred on the last known point"
    : "an even spread over the whole search area: there is no checked source for this category yet, so the last known point does not shape it",
}));

/** How a drone's photos reach the console. */
export type FeedKind = "survey" | "upload" | "folder" | "video";
export const FEEDS: readonly { id: FeedKind; label: string; here: boolean; what: string; run?: string }[] = [
  { id: "survey", label: "Fly the survey here", here: true, what: "The drone flies the survey over the search area; its photos are the site's real aerial photographs of Mount Seymour, ranked by the detector as they land." },
  { id: "upload", label: "Upload photos after a flight", here: true, what: "After landing, drop the SD card's photos on the console (or load the 20 sample photos): each is read for its GPS, ranked by the detector in this browser and pinned on the map." },
  {
    id: "folder",
    label: "Watch the SD card folder on the field laptop",
    here: false,
    what: "Needs the field kit: the mission server on the command-post laptop, and the client watching the card's folder, so each photo is sent as it lands.",
    run: "uv run python -m sightline.pipeline serve --mission-root missions\nuv run python -m sightline.client watch /path/to/DCIM --api SERVER_ADDRESS --mission MISSION_ID",
  },
  { id: "video", label: "Live video feed", here: false, what: "Sightline reads geotagged stills, not video: a hiker is about 70 px wide in a still and about 15 px in a video frame. Use the drone's photo mode." },
];

/** The radio check-in intervals offered (the scenarios use 30 minutes). */
export const CHECK_INS = [15, 30, 45, 60] as const;
export const MIN_TEAMS = 2;
export const MAX_TEAMS = 6;
export const MAX_DRONES = 3;
export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 10;

export interface PlayTeam {
  callsign: string;
  members: number;
}

export interface PlaySetup {
  /** A profile's seed, or null before one is picked. */
  profile: string | null;
  subject: string;
  lkp: LatLon | null;
  /** "10:30", local time on the day of the search, before the call. */
  lastSeen: string;
  /** A staging point's name. */
  camp: string | null;
  teams: PlayTeam[];
  checkInMin: number;
  /** One feed per drone. */
  drones: FeedKind[];
  /** Steps 4 and 5 start filled in; each counts once the visitor has looked at it and confirmed it. */
  confirmed: { teams: boolean; drones: boolean };
}

/** The call comes in at 13:35 (missionTime CHECKPOINTS[0]); the subject was last seen before it. */
export const CALL_LOCAL = "13:35";
/** The scenarios' last-seen time (the demo mission's last_seen_at, 10:30 local). */
export const DEFAULT_LAST_SEEN = "10:30";

const NUMBER_WORDS = ["One", "Two", "Three", "Four", "Five", "Six"];
/** The scenarios' roster: four teams of three. */
export const DEFAULT_TEAMS: readonly PlayTeam[] = NUMBER_WORDS.slice(0, 4).map((n) => ({ callsign: `Team ${n}`, members: 3 }));

export const EMPTY_SETUP: PlaySetup = {
  profile: null,
  subject: "",
  lkp: null,
  lastSeen: DEFAULT_LAST_SEEN,
  camp: null,
  teams: DEFAULT_TEAMS.map((t) => ({ ...t })),
  checkInMin: 30,
  drones: ["survey", "survey", "survey"],
  confirmed: { teams: false, drones: false },
};

/** A new team's callsign: the first "Team N" not taken. */
export function nextCallsign(teams: readonly PlayTeam[]): string {
  const taken = new Set(teams.map((t) => t.callsign.trim().toLowerCase()));
  return NUMBER_WORDS.map((n) => `Team ${n}`).find((c) => !taken.has(c.toLowerCase())) ?? `Team ${teams.length + 1}`;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutes = (hhmm: string) => {
  const m = HHMM.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

export type StepId = "who" | "where" | "camp" | "teams" | "drones" | "review";

export interface Step {
  id: StepId;
  n: number;
  title: string;
  /** What it says once done ("Missing child · child, 8, …"), or what it still needs. */
  status: string;
  done: boolean;
  required: boolean;
}

/** What is wrong with the roster, or null. */
export function teamsProblem(teams: readonly PlayTeam[]): string | null {
  if (teams.length < MIN_TEAMS) return `Add at least ${MIN_TEAMS} teams.`;
  if (teams.length > MAX_TEAMS) return `At most ${MAX_TEAMS} teams.`;
  if (teams.some((t) => !t.callsign.trim())) return "Every team needs a callsign.";
  const names = teams.map((t) => t.callsign.trim().toLowerCase());
  if (new Set(names).size !== names.length) return "Two teams have the same callsign.";
  if (teams.some((t) => !Number.isInteger(t.members) || t.members < MIN_MEMBERS || t.members > MAX_MEMBERS)) return `Each team has ${MIN_MEMBERS} to ${MAX_MEMBERS} people.`;
  return null;
}

/** What is wrong with the drones, or null. */
export function dronesProblem(drones: readonly FeedKind[]): string | null {
  if (drones.length < 1 || drones.length > MAX_DRONES) return `Choose 1 to ${MAX_DRONES} drones.`;
  if (drones.some((f) => !FEEDS.find((x) => x.id === f)?.here)) return "One drone's photos need the field kit; choose a way that works in this console.";
  if (!drones.includes("survey")) return "At least one drone flies the survey: it brings the area's aerial photos in.";
  return null;
}

/** What is wrong with the last-seen time, or null. */
export function lastSeenProblem(lastSeen: string): string | null {
  const m = minutes(lastSeen);
  if (m === null) return "Give the time as HH:MM.";
  if (m >= minutes(CALL_LOCAL)!) return `The call comes in at ${CALL_LOCAL}: last seen has to be before it.`;
  return null;
}

/** The checklist: each step, whether it is done and what it says. */
export function steps(s: PlaySetup): Step[] {
  const profile = PROFILES.find((p) => p.seed === s.profile) ?? null;
  const who = !!profile && s.subject.trim().length >= 3;
  const seenBad = lastSeenProblem(s.lastSeen);
  const where = !!s.lkp && inArea(s.lkp) && !seenBad;
  const camp = !!STAGING.find((x) => x.name === s.camp);
  const tp = teamsProblem(s.teams);
  const teams = s.confirmed.teams && !tp;
  const dp = dronesProblem(s.drones);
  const drones = s.confirmed.drones && !dp;
  const people = s.teams.reduce((n, t) => n + t.members, 0);
  const list: Step[] = [
    { id: "who", n: 1, title: "Who is missing", required: true, done: who, status: who ? `${profile!.name} · ${s.subject.trim()}` : profile ? "Describe them: age, clothing" : "Pick a profile" },
    {
      id: "where",
      n: 2,
      title: "Where they were last seen",
      required: true,
      done: where,
      status: where ? `Sector ${sectorOf(s.lkp!)} · last seen ${s.lastSeen}` : seenBad && s.lkp ? seenBad : "Click the map inside the search area",
    },
    { id: "camp", n: 3, title: "Base camp", required: true, done: camp, status: camp ? s.camp! : "Choose a staging point" },
    {
      id: "teams",
      n: 4,
      title: "Ground teams",
      required: true,
      done: teams,
      status: tp ?? `${s.teams.length} teams · ${people} people · check-in every ${s.checkInMin} min${teams ? "" : " (confirm)"}`,
    },
    {
      id: "drones",
      n: 5,
      title: "Drones and photo feeds",
      required: true,
      done: drones,
      status: dp ?? `${s.drones.length} ${s.drones.length === 1 ? "drone" : "drones"} · ${s.drones.filter((f) => f === "survey").length} flying the survey${drones ? "" : " (confirm)"}`,
    },
  ];
  const left = list.filter((x) => x.required && !x.done).length;
  list.push({ id: "review", n: 6, title: "Review and start", required: false, done: false, status: left ? `${left} ${left === 1 ? "step" : "steps"} to go` : "Ready to start" });
  return list;
}

/** Every required step done: Start the search is on. */
export function ready(s: PlaySetup): boolean {
  return steps(s).every((x) => x.done || !x.required);
}

// ---- remembered in this browser (Edit setup returns to it) ----

const KEY = "sightline.openPlay.v1";

/** A stored value back as a setup, or null when it is not one (an old or broken entry). */
export function asSetup(v: unknown): PlaySetup | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const ll = (x: unknown): LatLon | null => {
    const p = x as Record<string, unknown> | null;
    const lat = num(p?.lat);
    const lon = num(p?.lon);
    return lat !== null && lon !== null ? { lat, lon } : null;
  };
  const teams = Array.isArray(o.teams) ? o.teams.map((t) => ({ callsign: String((t as PlayTeam)?.callsign ?? ""), members: num((t as PlayTeam)?.members) ?? 3 })).slice(0, MAX_TEAMS) : null;
  const drones = Array.isArray(o.drones) ? o.drones.filter((f): f is FeedKind => FEEDS.some((x) => x.id === f)).slice(0, MAX_DRONES) : null;
  if (!teams || !drones) return null;
  const c = (o.confirmed ?? {}) as Record<string, unknown>;
  return {
    profile: PROFILES.some((p) => p.seed === o.profile) ? (o.profile as string) : null,
    subject: typeof o.subject === "string" ? o.subject.slice(0, 160) : "",
    lkp: ll(o.lkp),
    lastSeen: typeof o.lastSeen === "string" ? o.lastSeen : DEFAULT_LAST_SEEN,
    camp: STAGING.some((x) => x.name === o.camp) ? (o.camp as string) : null,
    teams,
    checkInMin: CHECK_INS.includes(num(o.checkInMin) as (typeof CHECK_INS)[number]) ? (o.checkInMin as number) : 30,
    drones: drones.length ? drones : ["survey"],
    confirmed: { teams: c.teams === true, drones: c.drones === true },
  };
}

/** The setup this browser remembers, or null (none, storage blocked, or not a setup). */
export function loadSetup(storage: Pick<Storage, "getItem"> | null = safeStorage()): PlaySetup | null {
  try {
    const raw = storage?.getItem(KEY);
    return raw ? asSetup(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** Remember the setup (quietly does nothing where storage is blocked). */
export function saveSetup(s: PlaySetup, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(s));
  } catch {
    /* a private window or blocked storage: the setup still starts, it is just not remembered */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The setup the console runs (`?s=play`): the one this page started, else the one this browser remembers,
 * else a complete default (a shared link with nothing stored: the overdue hiker at the scenario's own point).
 */
let current: PlaySetup | null = null;
export function startSetup(s: PlaySetup): void {
  current = s;
  saveSetup(s);
}
export function activeSetup(): PlaySetup {
  const s = current ?? loadSetup();
  return s && ready(s) ? s : READY_DEFAULT;
}

/** The search's name on the console: "Your search: Missing child". */
export function playName(s: PlaySetup): string {
  return `Your search: ${PROFILES.find((p) => p.seed === s.profile)?.name ?? PROFILES[0]!.name}`;
}

/** A complete setup: the overdue hiker at the demo mission's last known point, base camp at the trailhead lot. */
export const READY_DEFAULT: PlaySetup = {
  ...EMPTY_SETUP,
  profile: "overdue-hiker",
  subject: PROFILES[0]!.subject,
  lkp: { lat: 49.37, lon: -122.945 },
  camp: "Trailhead lot",
  confirmed: { teams: true, drones: true },
};
