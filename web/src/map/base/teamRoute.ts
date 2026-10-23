// A team's way to its sector (V3 §2: "the team's route animates from base camp or its last sector when
// approved"), pure: where it starts (where it is, else the sector it last worked, else base camp), the point
// where it enters the new sector (the nearest point of the outline), and the sweep inside it (east-west
// lines, as a drone's). The map draws the route growing along it (LiveHeatMap); the demo's walk
// (command/focusLayers.ts) and the guided search's engine (command/sim.ts) send the team the same way. Built by lane A.
import { metres, type LonLat } from "./fleetMotion";

type Polygon = readonly (readonly [number, number])[];

export interface RouteTeam {
  id: string;
  position?: { lat: number; lon: number } | null;
}
export interface RouteTask {
  sector_id: string;
  state: string;
  team_id: string | null;
  updated_at?: string;
}
export interface RouteSector {
  sector_id: string;
  polygon?: Polygon | null;
}

const centre = (poly: Polygon): LonLat => {
  const ring = poly.length > 1 && poly[0]![0] === poly.at(-1)![0] && poly[0]![1] === poly.at(-1)![1] ? poly.slice(0, -1) : poly;
  return [ring.reduce((a, c) => a + c[0], 0) / ring.length, ring.reduce((a, c) => a + c[1], 0) / ring.length];
};

/** Where a team sets off for `sector`: its position, else the centre of the sector it last worked, else base camp. */
export function routeStart(
  team: RouteTeam,
  sector: string,
  tasks: readonly RouteTask[],
  sectors: readonly RouteSector[],
  base: { lat: number; lon: number } | null | undefined,
): LonLat | null {
  if (team.position) return [team.position.lon, team.position.lat];
  const last = tasks
    .filter((t) => t.team_id === team.id && t.sector_id !== sector && t.state !== "proposed")
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))[0];
  const poly = last ? sectors.find((s) => s.sector_id === last.sector_id)?.polygon : null;
  if (poly?.length) return centre(poly);
  return base ? [base.lon, base.lat] : null;
}

/** The nearest point of a polygon's outline to `p` (or `p` itself when it is inside: no walk in). */
export function entryPoint(p: LonLat, poly: Polygon): LonLat {
  if (inside(p, poly)) return p;
  let best: LonLat = [poly[0]![0], poly[0]![1]];
  let bestD = Infinity;
  const k = Math.cos((p[1] * Math.PI) / 180);
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i]!;
    const b = poly[i + 1]!;
    const ax = (a[0] - p[0]) * k, ay = a[1] - p[1];
    const bx = (b[0] - p[0]) * k, by = b[1] - p[1];
    const dx = bx - ax, dy = by - ay;
    const len = dx * dx + dy * dy || 1;
    const t = Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len));
    const x = ax + t * dx, y = ay + t * dy;
    const d = x * x + y * y;
    if (d < bestD) {
      bestD = d;
      best = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    }
  }
  return best;
}

export function inside(p: LonLat, poly: Polygon): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** East-west sweep lines over a sector's outline (its bounding box, inset), boustrophedon, starting at the end nearest `from`. */
export function sweepLines(poly: Polygon, lines = 6, from?: LonLat): LonLat[] {
  const lons = poly.map((p) => p[0]);
  const lats = poly.map((p) => p[1]);
  const [w, e, s, n] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
  const inset = (n - s) / (lines * 2);
  const rows: LonLat[][] = [];
  for (let i = 0; i < lines; i++) {
    const lat = n - inset - (i * (n - s - 2 * inset)) / Math.max(1, lines - 1);
    rows.push([[w + inset, lat], [e - inset, lat]]);
  }
  // start from the corner nearest the way in
  if (from && Math.abs(from[1] - s) < Math.abs(from[1] - n)) rows.reverse();
  const startEast = from ? Math.abs(from[0] - e) < Math.abs(from[0] - w) : false;
  return rows.flatMap((r, i) => ((i % 2 === 0) === startEast ? [...r].reverse() : r));
}

/** The route to a sector: start, its way in. */
export function routeTo(start: LonLat, poly: Polygon): LonLat[] {
  const entry = entryPoint(start, poly);
  return metres(start, entry) < 1 ? [start] : [start, entry];
}

/** The first `f` (0..1) of a path, by length: the route as drawn while it grows. */
export function partialPath(path: readonly LonLat[], f: number): LonLat[] {
  if (path.length < 2) return [...path];
  const lens = path.slice(1).map((p, i) => metres(path[i]!, p));
  const total = lens.reduce((a, b) => a + b, 0);
  if (total === 0) return [path[0]!];
  let left = Math.min(1, Math.max(0, f)) * total;
  const out: LonLat[] = [path[0]!];
  for (let i = 0; i < lens.length; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const l = lens[i]!;
    if (left >= l) {
      out.push(b);
      left -= l;
      continue;
    }
    const t = l ? left / l : 0;
    out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    break;
  }
  return out;
}

/** A path's length in metres. */
export const pathLength = (path: readonly LonLat[]) => path.slice(1).reduce((n, p, i) => n + metres(path[i]!, p), 0);
