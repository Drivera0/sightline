// B-C1: clue pins. A colour per kind; the label is the clue id and kind; a click shows what, reliability,
// radius and how it came in ("by radio" / "entered at command"). Built by lane A for lane B (#74).
// A sound a team heard with a bearing (contract 15.7: `origin`, `bearing_deg`, `bearing_spread_deg`,
// `range_m`) is an arc as well: from where the team stood, within the bearing's spread, `range_m` away give
// or take the clue's radius, the same area the map's update raises (sightline/search/live.py `_clue_cells`).
import type { Clue, LatLon, Team } from "../../contract";
import type { PolygonGeometry } from "./circle";
import { point, type MissionFeature, type Tone } from "./missionFeature";

/** Clues are amber everywhere (the v3 colour system); the kind is in the label and the popup. */
export const CLUE_TONE: Record<Clue["kind"], Tone> = { object: "clue", track: "clue", sighting: "clue", sound: "clue", other: "clue" };

/** How a clue came in, in words. */
const howCame = (c: Clue) => (c.source === "radio" ? "by radio" : c.source === "review" ? "from an image review" : "entered at command");

/** `time`: the page's clock (lib/time); by default the clue's UTC HH:MM. */
export function clueFeatures(
  clues: readonly Clue[],
  callsign: (id: string) => string = (id) => id,
  time: (iso: string) => string = (iso) => iso.slice(11, 16),
): MissionFeature[] {
  return clues.map((c) =>
    point("clue", c.id, `${c.id} ${c.kind}`, CLUE_TONE[c.kind], c.lon, c.lat,
      `${c.text}\n${c.kind} · ${c.reliability} reliability · ${bearingOf(c) ? bearingWords(c) : `within ${Math.round(c.radius_m)} m`}\n` +
        `${howCame(c)}${c.confirmed === false ? " · not confirmed yet" : ""} · ${callsign(c.reported_by)} · ${time(c.at)}`),
  );
}

/** The spread the server assumes when a bearing comes without one (live.py). */
export const DEFAULT_SPREAD_DEG = 20;

/** A bearing clue's numbers, or null for a clue that is a point and a radius. */
export function bearingOf(c: Clue): { bearing: number; spread: number; range: number; radius: number } | null {
  if (c.bearing_deg == null || !c.range_m) return null;
  return { bearing: c.bearing_deg, spread: c.bearing_spread_deg || DEFAULT_SPREAD_DEG, range: c.range_m, radius: c.radius_m || 0 };
}

/** "bearing 9° ±30°, 631 m ±631 m": what the team reported, in the order they said it. */
export function bearingWords(c: Clue): string {
  const b = bearingOf(c);
  if (!b) return "";
  return `bearing ${Math.round(b.bearing)}° ±${Math.round(b.spread)}°, ${Math.round(b.range)} m ±${Math.round(b.radius)} m`;
}

/** Where the team stood when it heard it: the clue's own origin, else the reporting team's position. */
export function bearingOrigin(c: Clue, teams: readonly Pick<Team, "id" | "callsign" | "position">[] = []): LatLon | null {
  if (c.origin) return c.origin;
  const t = teams.find((x) => x.id === c.reported_by || x.callsign === c.reported_by);
  return t?.position ?? null;
}

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** The point `dist` metres from `from` on compass bearing `brg` (great circle), as [lon, lat]. */
export function destination(from: LatLon, brg: number, dist: number): [number, number] {
  const d = dist / EARTH_RADIUS_M;
  const la = rad(from.lat);
  const lo = rad(from.lon);
  const b = rad(brg);
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return [deg(lo2), deg(la2)];
}

/**
 * The arc as a closed polygon: the outer edge (range + radius) clockwise across the spread, then the inner
 * edge (range − radius, at least 0) back; an inner edge of 0 is the team's own position (a wedge).
 */
export function bearingArc(origin: LatLon, bearing: number, spread: number, range: number, radius: number, steps = 32): PolygonGeometry {
  const outer = range + radius;
  const inner = Math.max(0, range - radius);
  const ring: number[][] = [];
  for (let i = 0; i <= steps; i += 1) ring.push(destination(origin, bearing - spread + (2 * spread * i) / steps, outer));
  if (inner <= 0) ring.push([origin.lon, origin.lat]);
  else for (let i = steps; i >= 0; i -= 1) ring.push(destination(origin, bearing - spread + (2 * spread * i) / steps, inner));
  ring.push(ring[0]!);
  return { type: "Polygon", coordinates: [ring] };
}

/** A bearing clue's arc polygon, or null when it is not one (or nobody knows where the team stood). */
export function clueArc(c: Clue, teams: readonly Pick<Team, "id" | "callsign" | "position">[] = []): PolygonGeometry | null {
  const b = bearingOf(c);
  const at = b ? bearingOrigin(c, teams) : null;
  return b && at ? bearingArc(at, b.bearing, b.spread, b.range, b.radius) : null;
}

export interface ArcFeature {
  type: "Feature";
  properties: { kind: "clue-arc"; id: string; label: string };
  geometry: PolygonGeometry;
}

/** The bearing clues' arcs, each with a hover label: what was heard, who heard it, the bearing and range. */
export function clueArcFeatures(
  clues: readonly Clue[],
  teams: readonly Pick<Team, "id" | "callsign" | "position">[] = [],
  callsign: (id: string) => string = (id) => id,
): ArcFeature[] {
  const out: ArcFeature[] = [];
  for (const c of clues) {
    const geometry = clueArc(c, teams);
    if (!geometry) continue;
    const label = `${c.kind[0]!.toUpperCase()}${c.kind.slice(1)}: ${c.text}\nheard by ${callsign(c.reported_by)} · ${bearingWords(c)}${c.confirmed === false ? " · not confirmed yet" : ""}`;
    out.push({ type: "Feature", properties: { kind: "clue-arc", id: c.id, label }, geometry });
  }
  return out;
}
