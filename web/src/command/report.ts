// The after-action report (the Debrief once the subject is found): incident, operational period, subject,
// the key events (first photo, clues, decisions and who made them, the find), areas searched with their
// POD, every sector's final POD, the drone legs with their minutes and photos, photos processed, radio
// turns, proposals accepted and rejected. The server's own report (`report.py`, the demo fixtures' `report`)
// gives the sectors' final POD (cumulative from every look, prior-weighted) and the legs when it is there. On a
// live mission the server writes it (GET /missions/{id}/report.md); on the demo it is built here from the
// store, with the same sections. Pure. Built by lane A.
import type { MissionData } from "../lib/mission";
import { clock, type Tz } from "../lib/time";
import { buildTimeline, type Entry } from "./timeline";

export interface MissionReport {
  incident: string;
  area: string;
  lkp: string;
  subject: string;
  /** When the subject was last seen (Mission.last_seen_at), if the record says. */
  lastSeen: string | null;
  period: { from: string; to: string; minutes: number };
  found: { by: string; sector: string; at: string; where: string } | null;
  events: { at: string; text: string }[];
  searched: { sector: string; pod: number; team: string | null; note: string | null }[];
  /** The survey flight's photos and the drone legs' photos, apart (they were added up as "1180 of the 500"). */
  photos: { survey: number; legs: number };
  legs: { flown: number; minutes: number };
  /** Every sector's final POD (cumulative from every look), with its POA and drone coverage. */
  sectors: { sector: string; poa: number; coverage: number; pod: number }[];
  /** Each drone leg: who flew it where, its minutes (as reported, or as planned) and its photos. */
  legList: { leg: string; drone: string; sector: string | null; status: string; minutes: number; minutesFrom: string; photos: number }[];
  radioTurns: number;
  proposals: { accepted: number; rejected: number; pending: number };
  clues: number;
}

type Data = Pick<MissionData, "mission" | "tasks" | "teams" | "clues" | "proposals" | "events" | "mapUpdates" | "fleet" | "timeline"> &
  Partial<Pick<MissionData, "report" | "sectors">>;

/**
 * Every sector's final POD: the server's report's, with a ground search the console recorded since (the
 * guided search's, a direct action) added on top as one more independent look; without the server's report,
 * the ground searches alone.
 */
export function sectorPods(s: Data): MissionReport["sectors"] {
  const searched = new Map(s.tasks.filter((t) => t.state === "searched" && t.pod !== null).map((t) => [t.sector_id, t.pod as number]));
  const fromServer = s.report?.sectors;
  if (fromServer?.length)
    return fromServer.map((x) => {
      const ground = x.ground === null ? (searched.get(x.sector) ?? 0) : 0;
      return { sector: x.sector, poa: x.poa, coverage: x.drone_coverage, pod: 1 - (1 - x.pod) * (1 - ground) };
    });
  return (s.sectors ?? []).map((x) => ({ sector: x.sector_id, poa: x.poa, coverage: x.drone_coverage, pod: searched.get(x.sector_id) ?? 0 }));
}

/** The drone legs: the server's report's (minutes and photos), else the fleet's legs with their photos on the map. */
export function legRows(s: Data): MissionReport["legList"] {
  const fromServer = s.report?.legs;
  if (fromServer?.length)
    return fromServer.map((l) => ({ leg: l.leg, drone: l.drone, sector: l.sector, status: l.status, minutes: l.minutes, minutesFrom: l.minutes_from, photos: l.photos }));
  const name = (id: string) => s.fleet?.drones.find((d) => d.id === id)?.name ?? id;
  return (s.fleet?.legs ?? [])
    .filter((l) => l.status !== "proposed" && l.status !== "approved")
    .map((l) => ({
      leg: l.id, drone: name(l.drone_id), sector: l.sector_id, status: l.status, minutes: l.est_minutes, minutesFrom: "planned",
      photos: s.mapUpdates.filter((u) => u.source === "frame" && u.ref?.startsWith(`${l.id}-`)).length,
    }));
}

/** The key events: the first photo, every clue, every decision (with who), the find; oldest first. */
function keyEvents(entries: readonly Entry[]): Entry[] {
  const firstPhoto = [...entries].reverse().find((e) => e.kind === "drone" && /photos|flight/i.test(e.text));
  const keep = entries.filter((e) => e.kind === "clue" || e.kind === "found" || (e.kind === "decision" && !e.text.startsWith("Agent proposes")));
  return [...(firstPhoto ? [firstPhoto] : []), ...keep].sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * The photos on the map: the survey flight's (frame ids, "f0042") and the drone legs' ("L004-p07"), apart.
 * Added up they read as "1180 photos" next to "of the 500 photos" (judges 2026-10-23).
 */
export function photoCounts(updates: readonly { source: string; ref: string | null }[]): { survey: number; legs: number } {
  let survey = 0;
  let legs = 0;
  for (const u of updates) {
    if (u.source !== "frame") continue;
    if (u.ref && /^f\d{4}$/.test(u.ref)) survey += 1;
    else legs += 1;
  }
  return { survey, legs };
}

export function buildReport(s: Data, now: Date): MissionReport {
  const m = s.mission;
  const callsign = (id: string | null | undefined) => s.teams.find((t) => t.id === id)?.callsign ?? id ?? "";
  const from = m?.created_at ?? now.toISOString();
  const to = m?.found?.at ?? now.toISOString();
  const entries = buildTimeline(s.events, s.teams, s.timeline);
  const legs = (s.fleet?.legs ?? []).filter((l) => l.status === "done" || l.status === "flying");
  return {
    incident: m?.name ?? "Mission",
    area: m?.area.name ?? "",
    lkp: m ? `${m.area.lkp.lat.toFixed(5)}, ${m.area.lkp.lon.toFixed(5)}` : "",
    subject: m?.subject ?? "not recorded",
    lastSeen: m?.last_seen_at ?? s.report?.subject?.last_seen_at ?? null,
    period: { from, to, minutes: Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000)) },
    found: m?.found ? { by: callsign(m.found.team), sector: m.found.sector ?? "", at: m.found.at, where: `${m.found.lat.toFixed(5)}, ${m.found.lon.toFixed(5)}` } : null,
    events: keyEvents(entries).map((e) => ({ at: e.at, text: e.text })),
    searched: s.tasks.filter((t) => t.state === "searched").map((t) => ({ sector: t.sector_id, pod: t.pod ?? 0, team: t.team_id ? callsign(t.team_id) : null, note: t.note })),
    photos: photoCounts(s.mapUpdates),
    legs: { flown: legs.length, minutes: Math.round(legs.reduce((n, l) => n + l.est_minutes, 0)) },
    sectors: sectorPods(s),
    legList: legRows(s),
    radioTurns: s.events.filter((e) => e.type === "radio.turn").length,
    proposals: {
      accepted: s.proposals.filter((p) => p.status === "approved").length,
      rejected: s.proposals.filter((p) => p.status === "rejected").length,
      pending: s.proposals.filter((p) => p.status === "pending").length,
    },
    clues: s.clues.length,
  };
}

const pct = (v: number) => `${Math.round(v * 100)} %`;
/** A POA or a POD in the report: one decimal under 10 %, so 0.4 % does not read 0 %. */
export const pct1 = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)} %`;

/** "19:48, 3 h 52 min before the call": when the subject was last seen, against the mission's start. */
export function lastSeenWords(r: Pick<MissionReport, "lastSeen" | "period">, t: (iso: string) => string): string | null {
  if (!r.lastSeen) return null;
  const min = Math.round((new Date(r.period.from).getTime() - new Date(r.lastSeen).getTime()) / 60000);
  if (!(min > 0)) return t(r.lastSeen);
  return `${t(r.lastSeen)}, ${min >= 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}` : `${min} min`} before the call`;
}

/** The report as Markdown, the file a search manager keeps (the demo's Report button downloads it). */
export function reportMarkdown(r: MissionReport, tz: Tz): string {
  const t = (iso: string) => clock(iso, tz);
  const lines = [
    `# After-action report: ${r.incident}`,
    "",
    `- **Incident:** ${r.incident}${r.area ? `, ${r.area}` : ""}`,
    `- **Last known point:** ${r.lkp}`,
    `- **Subject:** ${r.subject}`,
    ...(r.lastSeen ? [`- **Last seen:** ${lastSeenWords(r, t)}`] : []),
    `- **Operational period:** ${t(r.period.from)} to ${t(r.period.to)} (${r.period.minutes} min)`,
    r.found ? `- **Found:** by ${r.found.by} in ${r.found.sector} at ${t(r.found.at)} (${r.found.where})` : "- **Found:** not yet",
    "",
    "## Key events",
    "",
    ...r.events.map((e) => `- ${t(e.at)} ${e.text}`),
    "",
    "## Areas searched",
    "",
    ...(r.searched.length ? ["| Sector | POD | Team | Note |", "|---|---:|---|---|", ...r.searched.map((s) => `| ${s.sector} | ${pct(s.pod)} | ${s.team ?? ""} | ${s.note ?? ""} |`)] : ["None marked searched."]),
    "",
    "## Every sector's final POD",
    "",
    ...(r.sectors.length
      ? ["| Sector | POA | Drone coverage | Final POD |", "|---|---:|---:|---:|", ...r.sectors.map((s) => `| ${s.sector} | ${pct1(s.poa)} | ${pct(s.coverage)} | ${pct1(s.pod)} |`)]
      : ["No sectors recorded."]),
    "",
    "## Drone legs",
    "",
    ...(r.legList.length
      ? ["| Leg | Drone | Sector | Status | Minutes | Photos |", "|---|---|---|---|---:|---:|", ...r.legList.map((l) => `| ${l.leg} | ${l.drone} | ${l.sector ?? ""} | ${l.status} | ${l.minutes.toFixed(1)} (${l.minutesFrom}) | ${l.photos} |`)]
      : ["No drone legs flown."]),
    "",
    "## Resources and traffic",
    "",
    `- Photos processed: ${r.photos.survey} from the survey flight, ${r.photos.legs} from drone legs`,
    `- Drone legs flown: ${r.legs.flown} (${r.legs.minutes} flight minutes planned)`,
    `- Radio turns: ${r.radioTurns}`,
    `- Clues: ${r.clues}`,
    `- Agent proposals: ${r.proposals.accepted} accepted, ${r.proposals.rejected} rejected, ${r.proposals.pending} still open`,
    "",
  ];
  return lines.join("\n");
}
