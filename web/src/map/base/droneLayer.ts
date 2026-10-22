// B-T1: drone markers. Name, "simulated" when it is, battery; the ring says the drone's link (the
// simulated link model, lib/mission.ts FleetLinks): ok, degraded or lost, always in words too, with how
// long ago a lost drone was last heard. Built by lane A for lane B (#74).
import type { FleetState } from "../../contract";
import type { DroneLink, DroneLinkState } from "../../lib/mission";
import { point, type MissionFeature } from "./missionFeature";

/** The word for each link state, on the label, in the popup and in the legend. */
export const LINK_WORD: Record<DroneLinkState, string> = { connected: "link ok", degraded: "link degraded", lost: "link lost" };

const ago = (iso: string, now: Date): string => {
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
};

export function droneFeatures(fleet: FleetState | null, links: Readonly<Record<string, DroneLink>> = {}, now: Date = new Date()): MissionFeature[] {
  return (fleet?.drones ?? [])
    .filter((d) => d.position)
    .map((d) => {
      const l = links[d.id];
      const link: DroneLinkState = l?.link ?? "connected";
      const heard = link !== "connected" && l?.last_heard_at ? `, last heard ${ago(l.last_heard_at, now)} ago` : "";
      const linkText = link === "connected" ? "" : ` · ${LINK_WORD[link]}${heard}`;
      const f = point("drone", d.id, `${d.name}${d.simulated ? " (simulated)" : ""} · ${Math.round(d.battery_pct)} %${linkText}`,
        d.battery_pct < 25 ? "warn" : "text", d.position!.lon, d.position!.lat,
        `${d.name}${d.simulated ? " (simulated)" : ""}\n${d.status} · battery ${Math.round(d.battery_pct)} %\n${LINK_WORD[link]}${heard}${d.simulated ? " (simulated link model)" : ""}`); // prettier-ignore
      f.properties.link = link;
      return f;
    });
}
