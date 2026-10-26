// Live fleet motion on the map: drones and teams glide between reports instead of jumping, and relay
// dots travel along a drone-team link. Pure maths plus a small state object; LiveHeatMap drives it
// from requestAnimationFrame. Like Pulse's dashboard (web/dashboard/src/mesh.ts): ease toward the
// latest report over ~400 ms with an ease-out curve, so a drone never overshoots its reported spot.
// Built by lane A for lane B.

export type LonLat = [number, number];

/** How long a drone takes to glide to its newly reported position (ms). */
export const GLIDE_MS = 400;
/** Metres per degree of latitude (flat-earth distances over a few km). */
const M_PER_DEG = 111_320;

/** Ease-out cubic: starts fast, settles without overshoot (0 → 0, 1 → 1, monotonic). */
export const easeOut = (f: number): number => 1 - (1 - Math.min(1, Math.max(0, f))) ** 3;

const lerp = (a: LonLat, b: LonLat, t: number): LonLat => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

interface Glide {
  from: LonLat;
  to: LonLat;
  t0: number;
  /** How long this glide takes (ms), and whether it is steady (linear) rather than eased. */
  ms: number;
  steady: boolean;
}

/** The shortest steady glide (ms): reports closer together than this still glide this long. */
export const STEADY_MIN_MS = 80;

/** Where each drone is drawn: gliding from where it was drawn to its latest reported position. */
export class FleetGlide {
  private glides = new Map<string, Glide>();

  constructor(private readonly ms = GLIDE_MS) {}

  /** New reported positions at time `now` (ms). Reduced motion: drawn at the report at once. */
  update(targets: Readonly<Record<string, LonLat>>, now: number, reduced = false): void {
    for (const id of [...this.glides.keys()]) if (!(id in targets)) this.glides.delete(id);
    for (const [id, to] of Object.entries(targets)) {
      const g = this.glides.get(id);
      if (g && g.to[0] === to[0] && g.to[1] === to[1]) continue;
      const from = g && !reduced ? this.at(g, now) : to;
      // reports in a steady stream (the guided clock's ten a second): a constant speed from one to the
      // next, so a drone flies its line instead of lurching forward and braking at every report
      const gap = g ? now - g.t0 : Infinity;
      const steady = gap < this.ms;
      this.glides.set(id, { from, to, t0: now, ms: steady ? Math.max(STEADY_MIN_MS, Math.min(this.ms, gap * 1.15)) : this.ms, steady });
    }
  }

  private at(g: Glide, now: number): LonLat {
    const f = Math.min(1, Math.max(0, (now - g.t0) / g.ms));
    return lerp(g.from, g.to, g.steady ? f : easeOut(f));
  }

  positions(now: number): Record<string, LonLat> {
    const out: Record<string, LonLat> = {};
    for (const [id, g] of this.glides) out[id] = this.at(g, now);
    return out;
  }

  /** True while any drone is still on its way to its report. */
  animating(now: number): boolean {
    for (const g of this.glides.values()) if (now - g.t0 < g.ms && (g.from[0] !== g.to[0] || g.from[1] !== g.to[1])) return true;
    return false;
  }
}

/**
 * Point features with the marks of one kind (the teams) moved to where their glide draws them; the rest as
 * they are. Teams glide like drones, so a team walks between the clock's reports instead of stepping.
 */
export function glidePoints<F extends { properties: { kind: string; id: string }; geometry: { type: string; coordinates: unknown } }>(features: readonly F[], at: Readonly<Record<string, LonLat>>, kind: string): F[] {
  return features.map((f) => (f.properties.kind === kind && f.geometry.type === "Point" && at[f.properties.id] ? { ...f, geometry: { ...f.geometry, coordinates: at[f.properties.id] } } : f));
}

/** Distance in metres between two nearby points (flat earth). */
export function metres(a: LonLat, b: LonLat): number {
  const dx = (b[0] - a[0]) * M_PER_DEG * Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  return Math.hypot(dx, (b[1] - a[1]) * M_PER_DEG);
}

/** The point at fraction f (0..1) of the way along a polyline, by length. */
export function alongPath(path: readonly LonLat[], f: number): LonLat {
  if (path.length === 0) return [0, 0];
  if (path.length === 1) return path[0]!;
  const legs = path.slice(1).map((p, i) => metres(path[i]!, p));
  const total = legs.reduce((a, b) => a + b, 0);
  if (total <= 0) return path[0]!;
  let d = Math.min(1, Math.max(0, f)) * total;
  for (let i = 0; i < legs.length; i++) {
    if (d <= legs[i]! || i === legs.length - 1) return lerp(path[i]!, path[i + 1]!, legs[i]! > 0 ? Math.min(1, d / legs[i]!) : 1);
    d -= legs[i]!;
  }
  return path.at(-1)!;
}

/** One relay trip from the team to the ground station's side, ms. */
export const RELAY_PERIOD_MS = 1600;
/** Dots in flight along a relay link at once. */
export const RELAY_DOTS = 3;

/**
 * Relay dots along `path` (team → the drone that heard it → any drone it hopped through) at time
 * `now`: RELAY_DOTS evenly spaced, each moving from the team towards the drones. Reduced motion:
 * still dots at fixed places.
 */
export function relayDots(path: readonly LonLat[], now: number, reduced = false): LonLat[] {
  const phase = reduced ? 0 : (now % RELAY_PERIOD_MS) / RELAY_PERIOD_MS;
  return Array.from({ length: RELAY_DOTS }, (_, k) => alongPath(path, (phase + k / RELAY_DOTS) % 1));
}
