// B-T1: drone legs. Proposed (waiting in the approval inbox) faint and dashed; approved solid; flying
// solid and thicker. Done and cancelled legs are not drawn. Built by lane A for lane B (#74).
import type { FleetState, Proposal } from "../../contract";
import type { MissionFeature } from "./missionFeature";

export type LegStyle = "proposed" | "approved" | "flying";

export function legFeatures(fleet: FleetState | null, proposals: readonly Proposal[] = []): MissionFeature[] {
  const line = (id: string, style: LegStyle, coords: unknown): MissionFeature => ({
    type: "Feature",
    properties: { kind: "leg", id, label: "", tone: style === "proposed" ? "muted" : "accent", style },
    geometry: { type: "LineString", coordinates: coords },
  });
  const flown = (fleet?.legs ?? []).filter((l) => l.status === "approved" || l.status === "flying");
  const proposed = proposals.filter((p) => p.status === "pending" && p.leg);
  return [...proposed.map((p) => line(p.leg!.id, "proposed", p.leg!.waypoints)), ...flown.map((l) => line(l.id, l.status as LegStyle, l.waypoints))];
}
