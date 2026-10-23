// Which grid cells a sector covers (its outline's bounding box on the map's grid), worked out once per map.
// Shared by the demo mission's clock (missionTime.ts), the clue shifts (clueShift.ts) and the demo store's
// direct actions (a sector marked searched lowers its own cells). Built by lane A.
import type { MapBase } from "../contract";
import type { SectorNow } from "../lib/api";
import { cellCenter } from "../map/heat/geometry";

const cache = new WeakMap<MapBase, Map<string, number[]>>();

export function sectorCells(base: MapBase, sectors: readonly Pick<SectorNow, "sector_id" | "polygon">[]): Map<string, number[]> {
  let byId = cache.get(base);
  if (byId && sectors.every((s) => byId!.has(s.sector_id) || !s.polygon?.length)) return byId;
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
  cache.set(base, byId);
  return byId;
}

/** The sector whose outline holds a point (lon, lat), or null. */
export function sectorAt<T extends Pick<SectorNow, "sector_id" | "polygon">>(sectors: readonly T[], lon: number, lat: number): T | null {
  for (const s of sectors) {
    const ring = s.polygon;
    if (!ring?.length) continue;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return s;
  }
  return null;
}

/** A sector's centre (the mean of its outline's corners). */
export function sectorCentre(s: Pick<SectorNow, "polygon">): { lon: number; lat: number } | null {
  const ring = s.polygon?.slice(0, -1);
  if (!ring?.length) return null;
  return { lon: ring.reduce((a, c) => a + c[0], 0) / ring.length, lat: ring.reduce((a, c) => a + c[1], 0) / ring.length };
}
