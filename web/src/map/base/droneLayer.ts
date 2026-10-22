// B-T1: drone markers. Name, "simulated" when it is, battery. Built by lane A for lane B (#74).
import type { FleetState } from "../../contract";
import { point, type MissionFeature } from "./missionFeature";

export function droneFeatures(fleet: FleetState | null): MissionFeature[] {
  return (fleet?.drones ?? [])
    .filter((d) => d.position)
    .map((d) =>
      point("drone", d.id, `${d.name}${d.simulated ? " (simulated)" : ""} · ${Math.round(d.battery_pct)} %`, d.battery_pct < 25 ? "warn" : "text",
        d.position!.lon, d.position!.lat),
    );
}
