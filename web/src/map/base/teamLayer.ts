// B-T1: team markers. Callsign, status word and how old the position is; the status picks the colour;
// a team with no position is not drawn. Built by lane A for lane B (#74).
import type { Team } from "../../contract";
import { minutesAgo, point, type MissionFeature, type Tone } from "./missionFeature";

const STATUS: Record<Team["status"], [string, Tone]> = {
  standby: ["standby", "muted"],
  assigned: ["assigned", "info"],
  searching: ["searching", "ok"],
  returning: ["returning", "info"],
  off_duty: ["off duty", "muted"],
};

export function teamFeatures(teams: readonly Team[], now: Date): MissionFeature[] {
  return teams
    .filter((t) => t.position)
    .map((t) => {
      const [word, tone] = STATUS[t.status];
      const age = t.position_at ? ` · ${minutesAgo(t.position_at, now)} min ago` : "";
      return point("team", t.id, `${t.callsign} · ${word}${age}`, tone, t.position!.lon, t.position!.lat);
    });
}
