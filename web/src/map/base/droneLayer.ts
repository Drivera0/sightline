// B-T1: drone markers. On the map: the short id ("D2") and battery next to the dot, a "SIM" chip on a
// simulated drone, and a ring for the link (the simulated link model, lib/mission.ts FleetLinks): ok,
// degraded or lost. The full line (name, simulated, battery, the link in words, how long ago a lost
// drone was last heard) is the feature's `label`: the hover/focus tooltip and the map's text summary
// say it. Built by lane A for lane B (#74).
import type { FleetState } from "../../contract";
import type { DroneLink, DroneLinkState } from "../../lib/mission";
import { point, type MissionFeature } from "./missionFeature";

/** The word for each link state, in the tooltip, the text summary and the legend. */
export const LINK_WORD: Record<DroneLinkState, string> = { connected: "link ok", degraded: "link degraded", lost: "link lost" };

const ago = (iso: string, now: Date): string => {
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
};

/** The drone's link in words ("link lost, last heard 5 min ago"), or "" while the link is ok. */
export function droneLinkWords(l: DroneLink | undefined, now: Date): string {
  const link: DroneLinkState = l?.link ?? "connected";
  if (link === "connected") return "";
  const heard = l?.last_heard_at ? `, last heard ${ago(l.last_heard_at, now)} ago` : "";
  return `${LINK_WORD[link]}${heard}`;
}

export function droneFeatures(fleet: FleetState | null, links: Readonly<Record<string, DroneLink>> = {}, now: Date = new Date()): MissionFeature[] {
  return (fleet?.drones ?? [])
    .filter((d) => d.position)
    .map((d) => {
      const l = links[d.id];
      const link: DroneLinkState = l?.link ?? "connected";
      const words = droneLinkWords(l, now);
      const name = `${d.name}${d.simulated ? " (simulated)" : ""}`;
      const battery = Math.round(d.battery_pct);
      const f = point("drone", d.id, `${name} · ${battery} %${words ? ` · ${words}` : ""}`,
        d.battery_pct < 25 ? "warn" : "drone", d.position!.lon, d.position!.lat,
        `${name}\n${d.status} · battery ${battery} %\n${words || LINK_WORD.connected}${d.simulated ? " (simulated link model)" : ""}`); // prettier-ignore
      f.properties.link = link;
      f.properties.short = d.id; // "D2": the drone ids are short already
      f.properties.battery = `${battery}%`;
      f.properties.sim = d.simulated;
      return f;
    });
}
