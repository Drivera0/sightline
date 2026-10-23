// B-T1: drone legs. Proposed (waiting in Needs you) and approved-not-flown dashed; the flying leg solid;
// flown and cut-short legs at 20 %. A cancelled leg (a re-task) fades from full to that over
// CANCEL_FADE_MS from when the map first saw it cancelled, and a short dashed trail runs from the
// diversion point to the drone's new leg while that leg is approved or flying (`retaskFeatures`).
// Built by lane A for lane B (#74).
import type { FleetState, Leg, Proposal } from "../../contract";
import type { LonLat } from "./fleetMotion";
import type { MissionFeature } from "./missionFeature";

export type LegStyle = "proposed" | "approved" | "flying" | "cancelled" | "diverted" | "past";

/** How long a cancelled leg takes to fade out (ms). */
export const CANCEL_FADE_MS = 1500;

const line = (id: string, style: LegStyle, coords: unknown, extra: Record<string, unknown> = {}): MissionFeature => ({
  type: "Feature",
  properties: { kind: "leg", id, label: "", tone: style === "proposed" || style === "cancelled" || style === "diverted" || style === "past" ? "muted" : "accent", style, ...extra },
  geometry: { type: "LineString", coordinates: coords },
});

/**
 * The legs to draw: the active (flying) leg solid, approved legs not yet flown and proposed ones dashed,
 * and every leg already flown or cut short ("past") at 20 %, so the map shows where the drones have been
 * without a tangle of sweep lines.
 */
export function legFeatures(fleet: FleetState | null, proposals: readonly Proposal[] = []): MissionFeature[] {
  const legs = fleet?.legs ?? [];
  const now = legs.filter((l) => l.status === "approved" || l.status === "flying");
  const past = legs.filter((l) => l.status === "done" || l.status === "cancelled");
  const proposed = proposals.filter((p) => p.status === "pending" && p.leg);
  return [
    ...past.map((l) => line(l.id, "past", l.waypoints)),
    ...proposed.map((p) => line(p.leg!.id, "proposed", p.leg!.waypoints)),
    ...now.map((l) => line(l.id, l.status as LegStyle, l.waypoints)),
  ];
}

/** The drone's leg that replaced a cancelled one: its next approved or flying leg. */
export function replacementLeg(fleet: FleetState | null, cancelled: Leg): Leg | undefined {
  const legs = fleet?.legs ?? [];
  const after = legs.slice(legs.indexOf(cancelled) + 1);
  return after.find((l) => l.drone_id === cancelled.drone_id && (l.status === "approved" || l.status === "flying"));
}

/** The point of a polyline nearest to p (flat lon/lat; fine over a sector). */
export function nearestOnLine(path: readonly (readonly number[])[], p: LonLat): LonLat {
  let best: LonLat = [path[0]![0]!, path[0]![1]!];
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const dx = b[0]! - a[0]!;
    const dy = b[1]! - a[1]!;
    const len = dx * dx + dy * dy;
    const t = len > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]!) * dx + (p[1] - a[1]!) * dy) / len)) : 0;
    const q: LonLat = [a[0]! + dx * t, a[1]! + dy * t];
    const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
    if (d < bestD) [best, bestD] = [q, d];
  }
  return best;
}

/** When the map first saw a leg cancelled, and where its drone turned off it. */
export interface SeenCancel {
  t: number;
  at: LonLat;
}

/**
 * Record newly cancelled legs (pure: returns the new record). The diversion point is where the drone
 * is drawn when the map sees the cancel happen; on the map's first look (`initial`: the cancel happened
 * before the page opened) the point of the old leg nearest to the drone.
 */
export function noteCancels(
  fleet: FleetState | null,
  seen: Readonly<Record<string, SeenCancel>>,
  now: number,
  drawn: Readonly<Record<string, LonLat>>,
  initial = false,
): Record<string, SeenCancel> {
  const out = { ...seen };
  for (const l of fleet?.legs ?? []) {
    if (l.status !== "cancelled" || out[l.id] || l.waypoints.length === 0) continue;
    const d = fleet?.drones.find((x) => x.id === l.drone_id);
    const drone: LonLat | null = drawn[l.drone_id] ?? (d?.position ? [d.position.lon, d.position.lat] : null);
    const first: LonLat = [l.waypoints[0]![0], l.waypoints[0]![1]];
    const at = drone === null ? first : initial ? nearestOnLine(l.waypoints, drone) : drone;
    out[l.id] = { t: now, at };
  }
  return out;
}

/** The re-task animation at time `now`: the cancelled leg fading out, and the dashed diversion trail. */
export function retaskFeatures(fleet: FleetState | null, seen: Readonly<Record<string, SeenCancel>>, now: number, reduced = false): MissionFeature[] {
  const out: MissionFeature[] = [];
  for (const l of fleet?.legs ?? []) {
    const s = seen[l.id];
    if (l.status !== "cancelled" || !s) continue;
    const age = now - s.t;
    if (!reduced && age < CANCEL_FADE_MS) out.push(line(l.id, "cancelled", l.waypoints, { fade: 1 - age / CANCEL_FADE_MS }));
    const next = replacementLeg(fleet, l);
    if (next && next.waypoints.length > 0) out.push(line(`${l.id}>${next.id}`, "diverted", [s.at, next.waypoints[0]], { fade: 1 }));
  }
  return out;
}

/** True while a cancelled leg is still fading (the animation loop keeps running). */
export function retaskAnimating(seen: Readonly<Record<string, SeenCancel>>, now: number): boolean {
  return Object.values(seen).some((s) => now - s.t < CANCEL_FADE_MS);
}
