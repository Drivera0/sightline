// The after-action report (the Debrief once the subject is found): incident, operational period, subject,
// the key events (first photo, clues, decisions and who made them, the find), areas searched with their
// POD, photos processed, drone legs and flight minutes, radio turns, proposals accepted and rejected. On a
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
  period: { from: string; to: string; minutes: number };
  found: { by: string; sector: string; at: string; where: string } | null;
  events: { at: string; text: string }[];
  searched: { sector: string; pod: number; team: string | null; note: string | null }[];
  photos: number;
  legs: { flown: number; minutes: number };
  radioTurns: number;
  proposals: { accepted: number; rejected: number; pending: number };
  clues: number;
}

type Data = Pick<MissionData, "mission" | "tasks" | "teams" | "clues" | "proposals" | "events" | "mapUpdates" | "fleet" | "timeline">;

/** The key events: the first photo, every clue, every decision (with who), the find; oldest first. */
function keyEvents(entries: readonly Entry[]): Entry[] {
  const firstPhoto = [...entries].reverse().find((e) => e.kind === "drone" && /photos|flight/i.test(e.text));
  const keep = entries.filter((e) => e.kind === "clue" || e.kind === "found" || (e.kind === "decision" && !e.text.startsWith("Agent proposes")));
  return [...(firstPhoto ? [firstPhoto] : []), ...keep].sort((a, b) => a.at.localeCompare(b.at));
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
    period: { from, to, minutes: Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000)) },
    found: m?.found ? { by: callsign(m.found.team), sector: m.found.sector ?? "", at: m.found.at, where: `${m.found.lat.toFixed(5)}, ${m.found.lon.toFixed(5)}` } : null,
    events: keyEvents(entries).map((e) => ({ at: e.at, text: e.text })),
    searched: s.tasks.filter((t) => t.state === "searched").map((t) => ({ sector: t.sector_id, pod: t.pod ?? 0, team: t.team_id ? callsign(t.team_id) : null, note: t.note })),
    photos: s.mapUpdates.filter((u) => u.source === "frame").length,
    legs: { flown: legs.length, minutes: Math.round(legs.reduce((n, l) => n + l.est_minutes, 0)) },
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

/** The report as Markdown, the file a search manager keeps (the demo's Report button downloads it). */
export function reportMarkdown(r: MissionReport, tz: Tz): string {
  const t = (iso: string) => clock(iso, tz);
  const lines = [
    `# After-action report: ${r.incident}`,
    "",
    `- **Incident:** ${r.incident}${r.area ? `, ${r.area}` : ""}`,
    `- **Last known point:** ${r.lkp}`,
    `- **Subject:** ${r.subject}`,
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
    "## Resources and traffic",
    "",
    `- Photos processed: ${r.photos}`,
    `- Drone legs flown: ${r.legs.flown} (${r.legs.minutes} flight minutes planned)`,
    `- Radio turns: ${r.radioTurns}`,
    `- Clues: ${r.clues}`,
    `- Agent proposals: ${r.proposals.accepted} accepted, ${r.proposals.rejected} rejected, ${r.proposals.pending} still open`,
    "",
  ];
  return lines.join("\n");
}
