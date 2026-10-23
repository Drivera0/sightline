// The console's one timeline (COMMAND_POST.md §5): radio turns, clues, detections, decisions, check-ins
// and drone legs in one stream, newest first, with filter chips. A server that sends the timeline
// (`TimelineEvent`s, GET /events and its SSE kinds) is shown as it is; otherwise the stream is built from
// the mission's events, which every mission has. Pure. Built by lane A.
import type { Clue, MissionEvent, Proposal, RadioTurn, SectorTask, Team, TimelineEvent } from "../contract";

export type EntryKind = TimelineEvent["kind"] | "note";

export interface Entry {
  id: string;
  at: string;
  kind: EntryKind;
  /** The team it is about (an id), for Reply and Call. */
  team: string | null;
  sector: string | null;
  text: string;
  /** A second line: the radio's reply, a clue's details, a decision's reason. */
  detail: string | null;
  /** A radio turn (Reply answers it). */
  turn: RadioTurn | null;
  /** An unconfirmed clue (Confirm reads it back). */
  clue: Clue | null;
  refs: string[];
  /** How many times the same line came (repeats merge into the newest). */
  repeats: number;
}

export const FILTERS = ["All", "Radio", "Clues", "Drone", "Decisions"] as const;
export type Filter = (typeof FILTERS)[number];

const IN_FILTER: Record<Filter, readonly EntryKind[] | null> = {
  All: null,
  Radio: ["radio", "checkin"],
  Clues: ["clue"],
  Drone: ["drone", "detection"],
  Decisions: ["decision", "found"],
};

export const inFilter = (e: Entry, f: Filter) => IN_FILTER[f]?.includes(e.kind) ?? true;

const entry = (e: Partial<Entry> & Pick<Entry, "id" | "at" | "kind" | "text">): Entry => ({
  team: null, sector: null, detail: null, turn: null, clue: null, refs: [], repeats: 1, ...e,
});

const pct = (v: number) => `${Math.round(v * 100)} %`;

/** A team id from an id or a callsign ("Team Two" → "T2"). */
export function teamOf(teams: readonly Pick<Team, "id" | "callsign">[], who: string | null | undefined): string | null {
  if (!who) return null;
  return teams.find((t) => t.id === who || t.callsign.toLowerCase() === who.toLowerCase())?.id ?? null;
}

/** One mission event as a timeline entry, or null for the ones the timeline leaves out (photo by photo, map steps). */
export function fromEvent(e: MissionEvent, teams: readonly Team[]): Entry | null {
  const d = e.data as Record<string, unknown> | null;
  const callsign = (id: string | null | undefined) => teams.find((t) => t.id === id)?.callsign ?? id ?? "";
  switch (e.type) {
    case "radio.turn": {
      const t = d as unknown as RadioTurn | null;
      if (!t) return null;
      const team = teamOf(teams, t.callsign);
      const out = t.direction === "out";
      return entry({
        id: e.id, at: e.at, kind: "radio", team, turn: t, refs: [t.id],
        text: out ? `To ${t.callsign ?? "all teams"}: ${t.transcript}` : `${t.callsign ?? "Unknown"}: ${t.transcript.replace(/\s*\(typed for the demo fixture\)$/, "")}`,
        detail: t.reply ? `Sightline: ${t.reply}` : null,
      });
    }
    case "clue.added": {
      const c = d as unknown as Clue | null;
      if (!c) return null;
      const by = teamOf(teams, c.reported_by);
      return entry({
        id: e.id, at: e.at, kind: "clue", team: by, refs: [c.id], clue: c.confirmed ? null : c,
        text: `${c.kind[0]!.toUpperCase()}${c.kind.slice(1)}: ${c.text}`,
        detail: `${c.id} · ${by ? callsign(by) : c.reported_by === "command" ? "entered at command" : c.reported_by} · ${c.source === "radio" ? "by radio" : "entered at command"} · ${c.reliability ?? "medium"} reliability · ${c.confirmed ? "confirmed" : "awaiting read-back"}`,
      });
    }
    case "detection.new":
      return entry({ id: e.id, at: e.at, kind: "detection", refs: e.ref ? [e.ref] : [], text: `Candidate ${e.ref ?? ""} in the review queue`.replace("  ", " ") });
    case "verdict": {
      const v = d as { detection_id?: string; person?: string; reason?: string } | null;
      return entry({ id: e.id, at: e.at, kind: "detection", refs: e.ref ? [e.ref] : [], text: `Second look on ${v?.detection_id ?? e.ref}: ${v?.person === "yes" ? "likely a person" : v?.person === "no" ? "probably not a person" : "unclear"}` });
    }
    case "photo.processed":
      // one entry when the flight starts and ends, never one per photo
      return /flight (starts|ends)/.test(e.summary) ? entry({ id: e.id, at: e.at, kind: "drone", refs: e.ref ? [e.ref] : [], text: e.summary.replace(/^f\d+ processed \((.*)\)$/, "Survey photos: $1") }) : null;
    case "proposal.new": {
      const p = d as unknown as Proposal | null;
      return entry({ id: e.id, at: e.at, kind: "decision", sector: p?.target.sector ?? null, team: p?.target.team ?? null, refs: [e.ref ?? ""], text: `Agent proposes: ${p?.summary ?? e.summary}`, detail: p?.reason ?? null });
    }
    case "proposal.decided": {
      const p = d as unknown as Proposal | null;
      if (!p) return null;
      const by = scenarioManager(p.decided_by ?? "someone");
      return entry({
        id: e.id, at: e.at, kind: "decision", sector: p.target.sector ?? null, team: p.target.team ?? null, refs: [p.id],
        text: `${by} ${p.status === "approved" ? "approved" : p.status === "rejected" ? "rejected" : p.status} agent ${p.id}: ${p.summary}`,
        detail: p.decision_reason,
      });
    }
    case "task.updated": {
      const t = d as unknown as SectorTask | null;
      if (!t || t.state === "proposed") return null;
      const who = t.team_id ? callsign(t.team_id) : "";
      if (t.state === "assigned") return entry({ id: e.id, at: e.at, kind: "decision", sector: t.sector_id, team: t.team_id, refs: [t.sector_id], text: `${t.sector_id} assigned to ${who}` });
      if (t.state === "in_progress") return entry({ id: e.id, at: e.at, kind: "checkin", sector: t.sector_id, team: t.team_id, refs: [t.sector_id], text: `${who} started ${t.sector_id}` });
      return entry({ id: e.id, at: e.at, kind: "checkin", sector: t.sector_id, team: t.team_id, refs: [t.sector_id], text: `${t.sector_id} searched at POD ${pct(t.pod ?? 0)}${who ? ` (${who})` : ""}`, detail: t.note ? `“${t.note}”` : null });
    }
    case "fleet.updated":
      // a demo flight's position reports are not news; the leg's start and end are
      if (/ on L\d+$/.test(e.summary)) return null;
      return entry({ id: e.id, at: e.at, kind: "drone", refs: e.ref ? [e.ref] : [], text: e.summary.replace(/ \(simulated fleet\)$/, "") });
    case "conditions.updated":
      return entry({ id: e.id, at: e.at, kind: "note", text: `Conditions looked up for ${(d as { area?: string } | null)?.area ?? "the area"}` });
    case "mission.note": {
      const action = d?.action as string | undefined;
      if (action === "found") return entry({ id: e.id, at: e.at, kind: "found", sector: e.ref, team: (d?.mission as { found?: { team?: string } })?.found?.team ?? null, text: e.summary });
      if (action) return entry({ id: e.id, at: e.at, kind: "decision", sector: (d?.sector as string) ?? null, team: (d?.team as string) ?? null, refs: e.ref ? [e.ref] : [], text: e.summary });
      if (d?.photo) return entry({ id: e.id, at: e.at, kind: "drone", refs: e.ref ? [e.ref] : [], text: e.summary });
      if (d?.relay) return entry({ id: e.id, at: e.at, kind: "checkin", team: (d.relay as { team_id?: string }).team_id ?? null, text: e.summary.replace(/ \(simulated relay\)$/, "") });
      if (d?.fleet_link) return entry({ id: e.id, at: e.at, kind: "drone", text: e.summary.replace(/ \(simulated link model\)/, "") });
      return entry({ id: e.id, at: e.at, kind: "note", refs: e.ref ? [e.ref] : [], text: e.summary });
    }
    default:
      return null;
  }
}

/**
 * The scenario's own search manager (the fixture's scripted decisions) is never shown as the visitor, who is
 * "Search manager" on this console (judges 2026-10-23): "The scenario's search manager approved…".
 */
export const scenarioManager = (text: string) =>
  text.replace(/(\b[Bb]y )?Search manager \(scripted for the demo fixture\)/g, (_, by: string | undefined) => (by ? `${by}the scenario's search manager` : "The scenario's search manager"));

/** The demo's per-line notes ("scripted for the demo fixture", "simulated relay"): the one disclosure chip says it once. */
export const plain = (text: string) =>
  scenarioManager(text).replace(/\s*\((?:scripted|typed) for the demo fixture\)/g, "").replace(/\s*\(simulated(?: [a-z ]+)?\)/g, "").trim();

/** A server's timeline entry as the console shows it. */
export function fromTimeline(e: TimelineEvent, i: number, teams: readonly Team[], turns: readonly RadioTurn[] = []): Entry {
  return entry({
    id: e.id ?? `t${i}`, at: e.at, kind: e.kind, team: teamOf(teams, e.team), sector: e.sector ?? null, text: plain(e.text), refs: e.refs ?? [],
    turn: e.turn_id ? (turns.find((t) => t.id === e.turn_id) ?? null) : null,
  });
}

/**
 * The timeline, newest first: the server's entries where it sends them (each carries the id of the event it
 * came from), and the mission's own events for the rest (a direct action just taken, the demo's moves).
 */
export function buildTimeline(events: readonly MissionEvent[], teams: readonly Team[], server: readonly TimelineEvent[] = []): Entry[] {
  const turns = events.filter((e) => e.type === "radio.turn" && e.data).map((e) => e.data as unknown as RadioTurn);
  const fromServer = server.map((e, i) => fromTimeline(e, i, teams, turns));
  const known = new Set(fromServer.map((e) => e.id));
  // a radio entry from the server answers with its turn: keep the reply line the events give
  const derived = events.map((e) => fromEvent(e, teams)).filter((x): x is Entry => x !== null);
  const byId = new Map(derived.map((e) => [e.id, e]));
  for (const e of fromServer) if (!e.detail) e.detail = byId.get(e.id)?.detail ?? null;
  // with a server timeline, the events add only what it cannot have yet: the console's own actions (the
  // demo's are "u…"), or anything newer than its last line
  const last = server.reduce((m, e) => (e.at > m ? e.at : m), "");
  const fresh = (e: Entry) => !server.length || (!known.has(e.id) && (e.id.startsWith("u") || e.at > last));
  const all = [...fromServer, ...derived.filter(fresh)];
  return merge(all.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)));
}

/** Repeats merge: the same check-in or link note again and again is one line with a count ("×4"). */
function merge(newestFirst: Entry[]): Entry[] {
  const out: Entry[] = [];
  const seen = new Map<string, Entry>();
  for (const e of newestFirst) {
    const key = e.kind === "checkin" || e.kind === "note" ? `${e.kind}|${e.text}` : null;
    const first = key ? seen.get(key) : undefined;
    if (first) {
      first.repeats += 1;
      continue;
    }
    const kept = { ...e, repeats: 1 };
    if (key) seen.set(key, kept);
    out.push(kept);
  }
  return out;
}
