// B-T1: team markers. On the map only the short id ("T3"); the full line (callsign, status word and how
// old the position is) is the feature's `label`: the hover/focus tooltip and the map's text summary say
// it. The status picks the colour; a team with no position is not drawn. Built by lane A for lane B (#74).
import type { Team } from "../../contract";
import { minutesAgo, point, type MissionFeature, type Tone } from "./missionFeature";

const STATUS: Record<Team["status"], [string, Tone]> = {
  standby: ["standby", "muted"],
  assigned: ["assigned", "info"],
  searching: ["searching", "ok"],
  returning: ["returning", "info"],
  off_duty: ["off duty", "muted"],
};

const NUMBER: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** "T3": the team's id when it is short already, else from its callsign ("Team Three"), else its id. */
export function teamShort(t: Pick<Team, "id" | "callsign">): string {
  if (/^T\d{1,2}$/i.test(t.id)) return t.id.toUpperCase();
  const m = /^team\s+(\w+)$/i.exec(t.callsign.trim());
  const n = m ? (NUMBER[m[1]!.toLowerCase()] ?? (/^\d{1,2}$/.test(m[1]!) ? Number(m[1]) : null)) : null;
  return n ? `T${n}` : t.id;
}

export function teamFeatures(teams: readonly Team[], now: Date): MissionFeature[] {
  return teams
    .filter((t) => t.position)
    .map((t) => {
      const [word, tone] = STATUS[t.status];
      const age = t.position_at ? ` · ${minutesAgo(t.position_at, now)} min ago` : "";
      const f = point("team", t.id, `${t.callsign} · ${word}${age}`, tone, t.position!.lon, t.position!.lat);
      f.properties.short = teamShort(t);
      return f;
    });
}
