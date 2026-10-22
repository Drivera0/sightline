// Drones relaying for a cut-off ground team (the simulated link model, lib/mission.ts FleetLinks): a
// thin dashed line from the team's relayed position through the drones that carried it, with dots
// travelling along it towards the drones. Drawn only while the team has no signal. Built by lane A
// for lane B.
import type { Team } from "../../contract";
import type { FleetLinks } from "../../lib/mission";
import { relayDots, type LonLat } from "./fleetMotion";
import type { MissionFeature } from "./missionFeature";

/** Team → the drone that heard it → any drone it hopped through, at the drones' drawn positions. */
export function relayPaths(links: FleetLinks, teams: readonly Team[], drawn: Readonly<Record<string, LonLat>>): { team: string; path: LonLat[]; label: string }[] {
  const out: { team: string; path: LonLat[]; label: string }[] = [];
  for (const [tid, t] of Object.entries(links.teams)) {
    const r = t.relay;
    if (t.link !== "no_signal" || !r) continue;
    const hops = r.via.map((d) => drawn[d]).filter((p): p is LonLat => p !== undefined);
    if (hops.length === 0) continue;
    const callsign = r.callsign ?? teams.find((x) => x.id === tid)?.callsign ?? tid;
    out.push({ team: tid, path: [[r.lon, r.lat], ...hops], label: `${callsign} relayed via ${r.via.join(" then ")} (simulated)` });
  }
  return out;
}

/** The relay links and their moving dots at time `now`. */
export function relayFeatures(links: FleetLinks, teams: readonly Team[], drawn: Readonly<Record<string, LonLat>>, now: number, reduced = false): MissionFeature[] {
  return relayPaths(links, teams, drawn).flatMap(({ team, path, label }) => [
    { type: "Feature", properties: { kind: "relay", id: team, label, tone: "info" }, geometry: { type: "LineString", coordinates: path } },
    ...relayDots(path, now, reduced).map(
      (p, k): MissionFeature => ({ type: "Feature", properties: { kind: "relay-dot", id: `${team}-${k}`, label: "", tone: "info" }, geometry: { type: "Point", coordinates: p } }),
    ),
  ]);
}
