// The console's heat, dissolved: the same mass classes (classes.ts: the likeliest 50, 80 and 90 % of the
// probability), drawn as smooth regions instead of a staircase of 5 m cells. Each region's mask is
// blurred a little (a few cells) and traced with marching squares at the half-way level, then simplified
// (Douglas-Peucker), so a class edge is one clean line at the console's zoom and at twice it. Because the
// three masks are nested (50 ⊆ 80 ⊆ 90) and the blur keeps that order, their outlines never cross: each
// band is filled as the even-odd area between two levels' rings, so the bands meet exactly and nothing is
// drawn twice. The classes cover the whole search area (the prior is known everywhere); ground no photo
// has looked at yet is a separate region, drawn as a light hatch over the heat. Pure. Built by lane A.
import type { MapFile } from "../../contract";
import { CELL, massThresholds, type SurfaceData } from "./classes";
import { edgeLat, edgeLon } from "./geometry";

type Grid = MapFile["grid"];
type LonLat = [number, number];
type Pt = [number, number]; // [x = column, y = row], cell-centre units
type Feature = SurfaceData["fills"]["features"][number];

/** How far the class masks are blurred (a box this many cells each side, twice: close to a Gaussian). */
export const SMOOTH_RADIUS = 2;
/** Douglas-Peucker tolerance, in cells. */
export const SIMPLIFY_CELLS = 0.3;
/** Regions smaller than this many square cells are left out (specks). */
export const MIN_AREA_CELLS = 12;

/** One box blur pass, separable, edges clamped. */
function boxBlur(src: Float32Array, rows: number, cols: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const n = 2 * r + 1;
  for (let y = 0; y < rows; y++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[y * cols + Math.min(cols - 1, Math.max(0, k))]!;
    for (let x = 0; x < cols; x++) {
      tmp[y * cols + x] = acc / n;
      acc += src[y * cols + Math.min(cols - 1, x + r + 1)]! - src[y * cols + Math.max(0, x - r)]!;
    }
  }
  for (let x = 0; x < cols; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(rows - 1, Math.max(0, k)) * cols + x]!;
    for (let y = 0; y < rows; y++) {
      out[y * cols + x] = acc / n;
      acc += tmp[Math.min(rows - 1, y + r + 1) * cols + x]! - tmp[Math.max(0, y - r) * cols + x]!;
    }
  }
  return out;
}

/** A 0/1 mask, blurred: a smooth field whose 0.5 level is the generalised edge. */
export function smoothField(mask: Uint8Array, rows: number, cols: number, radius = SMOOTH_RADIUS): Float32Array {
  let f: Float32Array = Float32Array.from(mask);
  if (radius > 0) f = boxBlur(boxBlur(f, rows, cols, radius), rows, cols, radius);
  return f;
}

/**
 * Closed rings where `field` crosses `level` (marching squares on cell centres, the grid padded with
 * zeros so every ring closes), unoriented, in [column, row] units.
 */
export function marchingRings(field: ArrayLike<number>, rows: number, cols: number, level = 0.5): Pt[][] {
  const at = (r: number, c: number) => (r < 0 || c < 0 || r >= rows || c >= cols ? 0 : (field[r * cols + c] as number));
  const inside = (r: number, c: number) => at(r, c) >= level;
  // the crossing on the edge between two centres, by linear interpolation
  const cross = (r0: number, c0: number, r1: number, c1: number): Pt => {
    const a = at(r0, c0);
    const b = at(r1, c1);
    const t = a === b ? 0.5 : Math.min(1, Math.max(0, (level - a) / (b - a)));
    return [c0 + (c1 - c0) * t, r0 + (r1 - r0) * t];
  };
  const pts = new Map<string, Pt>();
  const adj = new Map<string, string[]>();
  const link = (a: string, pa: Pt, b: string, pb: Pt) => {
    pts.set(a, pa);
    pts.set(b, pb);
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  };
  for (let r = -1; r < rows; r++) {
    for (let c = -1; c < cols; c++) {
      const tl = inside(r, c), tr = inside(r, c + 1), br = inside(r + 1, c + 1), bl = inside(r + 1, c);
      const code = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
      if (code === 0 || code === 15) continue;
      // edges of this square, keyed by the grid edge they lie on (shared with the neighbouring square)
      const T = [`h${r}:${c}`, cross(r, c, r, c + 1)] as const;
      const B = [`h${r + 1}:${c}`, cross(r + 1, c, r + 1, c + 1)] as const;
      const L = [`v${r}:${c}`, cross(r, c, r + 1, c)] as const;
      const R = [`v${r}:${c + 1}`, cross(r, c + 1, r + 1, c + 1)] as const;
      const seg = (a: readonly [string, Pt], b: readonly [string, Pt]) => link(a[0], a[1], b[0], b[1]);
      switch (code) {
        case 1: case 14: seg(L, B); break;
        case 2: case 13: seg(B, R); break;
        case 3: case 12: seg(L, R); break;
        case 4: case 11: seg(T, R); break;
        case 6: case 9: seg(T, B); break;
        case 7: case 8: seg(L, T); break;
        case 5: case 10: {
          // a saddle: the centre's value decides which corners join
          const mid = (at(r, c) + at(r, c + 1) + at(r + 1, c + 1) + at(r + 1, c)) / 4 >= level;
          if ((code === 5) === mid) {
            seg(L, T);
            seg(B, R);
          } else {
            seg(L, B);
            seg(T, R);
          }
          break;
        }
        default: break;
      }
    }
  }
  const rings: Pt[][] = [];
  const used = new Set<string>();
  for (const start of adj.keys()) {
    if (used.has(start)) continue;
    const ring: Pt[] = [];
    let prev = "";
    let cur = start;
    while (cur && !used.has(cur)) {
      used.add(cur);
      ring.push(pts.get(cur)!);
      const next = (adj.get(cur) ?? []).find((k) => k !== prev && !used.has(k));
      prev = cur;
      cur = next ?? "";
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/** Douglas-Peucker on a closed ring (split at its two farthest-apart points). */
export function simplifyRing(ring: readonly Pt[], tol = SIMPLIFY_CELLS): Pt[] {
  if (ring.length < 8) return [...ring];
  const d2 = (p: Pt, a: Pt, b: Pt) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
    return (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2;
  };
  const dp = (pts: Pt[]): Pt[] => {
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack: [number, number][] = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop()!;
      let best = -1;
      let far = tol * tol;
      for (let i = a + 1; i < b; i++) {
        const v = d2(pts[i]!, pts[a]!, pts[b]!);
        if (v > far) [far, best] = [v, i];
      }
      if (best > 0) {
        keep[best] = 1;
        stack.push([a, best], [best, b]);
      }
    }
    return pts.filter((_, i) => keep[i]);
  };
  let far = 0;
  let k = 0;
  for (let i = 1; i < ring.length; i++) {
    const v = (ring[i]![0] - ring[0]![0]) ** 2 + (ring[i]![1] - ring[0]![1]) ** 2;
    if (v > far) [far, k] = [v, i];
  }
  const a = dp(ring.slice(0, k + 1));
  const b = dp([...ring.slice(k), ring[0]!]);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

const area = (ring: readonly Pt[]) => {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j]![0] - ring[i]![0]) * (ring[j]![1] + ring[i]![1]);
  return s / 2;
};

function contains(ring: readonly Pt[], p: Pt): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Polygons (outer ring, then holes) for the even-odd area of a set of non-crossing rings: a ring inside an
 * even number of others is an outer ring, one inside an odd number a hole of the ring just around it.
 */
export function evenOdd(rings: readonly Pt[][]): Pt[][][] {
  // a point just inside each ring's own area tells which rings hold it; the ring's own vertex would sit on it
  const probe = (r: readonly Pt[]): Pt => [r[0]![0] * 0.999 + r[1]![0] * 0.001, r[0]![1] * 0.999 + r[1]![1] * 0.001];
  const holders = rings.map((r, i) => rings.map((o, j) => (i !== j && Math.abs(area(o)) > Math.abs(area(r)) && contains(o, probe(r)) ? j : -1)).filter((j) => j >= 0));
  const polys = new Map<number, Pt[][]>();
  rings.forEach((r, i) => {
    if (holders[i]!.length % 2 === 0) polys.set(i, [area(r) > 0 ? [...r] : [...r].reverse()]);
  });
  rings.forEach((r, i) => {
    const h = holders[i]!;
    if (h.length % 2 === 0) return;
    // the parent: the smallest ring around it
    const parent = h.reduce((a, b) => (Math.abs(area(rings[a]!)) < Math.abs(area(rings[b]!)) ? a : b));
    polys.get(parent)?.push(area(r) < 0 ? [...r] : [...r].reverse());
  });
  return [...polys.values()];
}

/** [column, row] (cell centres) → [lon, lat], closing the ring. */
function toLonLat(grid: Grid, ring: readonly Pt[]): LonLat[] {
  const out = ring.map(([x, y]) => [edgeLon(grid, x + 0.5), edgeLat(grid, y + 0.5)] as LonLat);
  out.push(out[0]!);
  return out;
}

/** A mask's generalised outline: rings in cell units, specks left out. */
export function outline(mask: Uint8Array, rows: number, cols: number, radius = SMOOTH_RADIUS): Pt[][] {
  const f = smoothField(mask, rows, cols, radius);
  return marchingRings(f, rows, cols, 0.5)
    .filter((r) => Math.abs(area(r)) >= MIN_AREA_CELLS)
    .map((r) => simplifyRing(r));
}

/**
 * How far from an even spread a cell must stand before it is shaded: within FLAT_BAND (5 %) of the flat
 * level a cell is "as likely as the next" and gets no fill, so a flat prior draws nothing at all.
 */
export const FLAT_BAND = 0.05;

/**
 * The class of every cell over the whole grid (every cell with probability is eligible, photographed or
 * not), and the ground a search has lowered. Held cells (awaiting review) are never classed.
 *
 * The classes are mass classes of the probability that stands above an even spread: the flat level is the
 * grid's mean cell, each cell's excess is what it holds beyond 1.05 × that, and the likeliest cells holding
 * 50, 80 and 90 % of the excess are the three classes. On a near-flat field (the demo's prior is one Koester
 * ring across the whole 1 km grid, and photos lower only what they cover) mass classes of the raw
 * probability put the likeliest 50 % over almost every cell, a wash of one colour; the excess keeps the
 * shape: rings around the last known point when the prior has them, a clue's neighbourhood, unsearched
 * ground once the rest is searched. `searched` (optional, 1 = a search lowered the cell) marks the cells
 * with no class as CELL.searched.
 */
export function wholeGridKinds(p: ArrayLike<number>, held?: Uint8Array | null, searched?: Uint8Array | null): Uint8Array {
  const n = p.length;
  const eligible = new Uint8Array(n);
  let total = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (held?.[i] === 1) continue;
    eligible[i] = 1;
    total += Math.max(0, p[i] as number);
    count++;
  }
  const flat = count ? total / count : 0;
  const excess = new Float64Array(n);
  for (let i = 0; i < n; i++) if (eligible[i] === 1) excess[i] = Math.max(0, (p[i] as number) - (1 + FLAT_BAND) * flat);
  const t = flat > 0 ? massThresholds(excess, eligible) : null;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = excess[i] as number;
    if (held?.[i] === 1) out[i] = CELL.held;
    else if (t && v > 0 && v >= (t[0] as number)) out[i] = CELL.top;
    else if (t && v > 0 && v >= (t[1] as number)) out[i] = CELL.mid;
    else if (t && v > 0 && v >= (t[2] as number)) out[i] = CELL.low;
    else out[i] = searched?.[i] === 1 ? CELL.searched : CELL.none;
  }
  return out;
}

/** A search lowered a cell when its photos (or a ground team) took more than this share of its probability. */
export const SEARCHED_BELOW = 0.9;

/**
 * Ground a search has lowered: 1 where the steps in `updates` (photos that found nobody, a ground search)
 * multiplied the cell by SEARCHED_BELOW or less. Reweights (clues) never mark a cell searched.
 */
export function searchedMask(n: number, updates: readonly { kind: string; cells: readonly (readonly [number, number] | number[])[] }[]): Uint8Array {
  const left = new Float64Array(n).fill(1);
  for (const u of updates) {
    if (u.kind !== "step") continue;
    for (const c of u.cells) {
      const i = c[0] as number;
      if (i >= 0 && i < n) left[i] = (left[i] as number) * (1 - (c[1] as number));
    }
  }
  return Uint8Array.from(left, (v) => (v <= SEARCHED_BELOW ? 1 : 0));
}

/** Nothing to draw: no class and no searched ground (the legend says "no evidence yet"). */
export function evidenceless(kinds: Uint8Array): boolean {
  for (let i = 0; i < kinds.length; i++) {
    const k = kinds[i];
    if (k !== CELL.none && k !== CELL.held) return false;
  }
  return true;
}

/** The smoothed per-cell kinds (for the raster while the heat tweens, so it matches the fills it hands over to). */
export function smoothKinds(grid: Pick<Grid, "rows" | "cols">, kinds: Uint8Array, radius = SMOOTH_RADIUS): Uint8Array {
  const { rows, cols } = grid;
  const field = (inside: (k: number) => boolean) => {
    const m = new Uint8Array(kinds.length);
    for (let i = 0; i < kinds.length; i++) if (inside(kinds[i]!)) m[i] = 1;
    return smoothField(m, rows, cols, radius);
  };
  const f50 = field((k) => k === CELL.top);
  const f80 = field((k) => k === CELL.top || k === CELL.mid);
  const f90 = field((k) => k === CELL.top || k === CELL.mid || k === CELL.low);
  const fs = field((k) => k === CELL.searched);
  const out = new Uint8Array(kinds.length);
  for (let i = 0; i < kinds.length; i++) {
    out[i] = kinds[i] === CELL.held ? CELL.held : f50[i]! >= 0.5 ? CELL.top : f80[i]! >= 0.5 ? CELL.mid : f90[i]! >= 0.5 ? CELL.low : fs[i]! >= 0.5 ? CELL.searched : CELL.none;
  }
  return out;
}

/** The kind that marks the "not photographed yet" hatch in the smoothed surface's fills. */
export const HATCH_KIND = CELL.veil;

/**
 * The console's surface: one MultiPolygon per class band (the likeliest 50 %, 50–80 %, 80–90 %), the
 * ground a search lowered (kind CELL.searched, under the classes: `searched`, or the kinds' own), the
 * unphotographed ground (kind CELL.veil, drawn as a hatch), and the 50 % and 90 % edges as lines.
 */
export function smoothSurface(grid: Grid, kinds: Uint8Array, photographed: Uint8Array | null, radius = SMOOTH_RADIUS, searched?: Uint8Array | null): SurfaceData {
  const { rows, cols } = grid;
  const mask = (inside: (k: number) => boolean) => {
    const m = new Uint8Array(kinds.length);
    for (let i = 0; i < kinds.length; i++) if (inside(kinds[i]!)) m[i] = 1;
    return m;
  };
  const r50 = outline(mask((k) => k === CELL.top), rows, cols, radius);
  const r80 = outline(mask((k) => k === CELL.top || k === CELL.mid), rows, cols, radius);
  const r90 = outline(mask((k) => k === CELL.top || k === CELL.mid || k === CELL.low), rows, cols, radius);
  const poly = (kind: number, rings: Pt[][]): Feature | null => {
    const polys = evenOdd(rings);
    return polys.length ? { type: "Feature", properties: { kind }, geometry: { type: "MultiPolygon", coordinates: polys.map((pp) => pp.map((r) => toLonLat(grid, r))) } } : null;
  };
  const lowered = searched ?? mask((k) => k === CELL.searched);
  const fills = [
    poly(CELL.searched, outline(lowered, rows, cols, radius)),
    poly(CELL.low, [...r90, ...r80]),
    poly(CELL.mid, [...r80, ...r50]),
    poly(CELL.top, r50),
    photographed ? poly(HATCH_KIND, outline(Uint8Array.from(photographed, (v) => (v ? 0 : 1)), rows, cols, radius)) : null,
  ].filter((f): f is Feature => f !== null);
  const lines = (level: 50 | 90, rings: Pt[][]): Feature | null =>
    rings.length ? { type: "Feature", properties: { level }, geometry: { type: "MultiLineString", coordinates: rings.map((r) => toLonLat(grid, r)) } } : null;
  const contours = [lines(90, r90), lines(50, r50)].filter((f): f is Feature => f !== null);
  return { fills: { type: "FeatureCollection", features: fills }, contours: { type: "FeatureCollection", features: contours } };
}
