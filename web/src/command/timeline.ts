// The console's one timeline (COMMAND_POST.md §5): radio turns, clues, detections, decisions, check-ins
// and drone legs in one stream, newest first, with filter chips. A server that sends the timeline
// (`TimelineEvent`s, GET /events and its SSE kinds) is shown as it is; otherwise the stream is built from
// the mission's events, which every mission has. Pure. Built by lane A.
import type { Clue, MissionEvent, Proposal, RadioTurn, SectorTask, Team, TimelineEvent } from "../contract";
import { formatPod, plainWords, TERMS, type PlainCtx } from "./terms";
import { operatorName } from "../lib/mission";
import { isLogged, WATCH_BY } from "./console";

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
  /** A radio line's voice clip (TimelineEntry.audio, under web/public): the row shows a speaker. */
  audio: string | null;
  /**
   * One assignment said once: an approval, the manager's "assigned" note and the board's "assigned" line for
   * the same team and sector are one row (the approval's, else the note's). `sector|team` and a rank (lower wins).
   */
  assign?: { key: string; rank: number } | null;
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
  team: null, sector: null, detail: null, turn: null, clue: null, refs: [], repeats: 1, audio: null, ...e,
});

const pct = formatPod;

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
      // who and how, each said once ("entered at command · entered at command" was said twice)
      const who = by ? callsign(by) : c.reported_by === "command" ? null : c.reported_by;
      const how = c.source === "radio" ? "by radio" : c.source === "review" ? "from a photo review" : TERMS.commandPost;
      return entry({
        id: e.id, at: e.at, kind: "clue", team: by, refs: [c.id], clue: c.confirmed ? null : c,
        text: `${c.kind[0]!.toUpperCase()}${c.kind.slice(1)}: ${c.text}`,
        detail: [who, how, `${c.reliability ?? "medium"} reliability`, clueState(c, (d as { decided_by?: string } | null)?.decided_by)].filter(Boolean).join(" · "),
      });
    }
    case "detection.new":
      return entry({ id: e.id, at: e.at, kind: "detection", refs: e.ref ? [e.ref] : [], text: `New ${TERMS.reviewItem} in ${TERMS.review}` });
    case "verdict": {
      const v = d as { detection_id?: string; person?: string; reason?: string } | null;
      return entry({ id: e.id, at: e.at, kind: "detection", refs: e.ref ? [e.ref] : [], text: `${TERMS.recheck} of a near-miss photo: ${v?.person === "yes" ? "likely a person" : v?.person === "no" ? "probably not a person" : "unclear"}` });
    }
    case "photo.processed":
      // one entry when the flight starts and ends, never one per photo
      return /flight (starts|ends)/.test(e.summary) ? entry({ id: e.id, at: e.at, kind: "drone", refs: e.ref ? [e.ref] : [], text: e.summary.replace(/^f\d+ processed \((.*)\)$/, "Survey photos: $1") }) : null;
    case "proposal.new": {
      const p = d as unknown as Proposal | null;
      return entry({ id: e.id, at: e.at, kind: "decision", sector: p?.target.sector ?? null, team: p?.target.team ?? null, refs: [e.ref ?? ""], text: `${TERMS.aiSuggests}: ${p?.summary ?? e.summary}`, detail: p?.reason ?? null });
    }
    case "proposal.decided": {
      const p = d as unknown as Proposal | null;
      if (!p) return null;
      const by = approverWord(p.decided_by);
      // an edit to another team: the team that went, said in the line (the cold test logged the agent's team)
      const edited = p.edits?.team && p.edits.team !== p.target.team ? p.edits.team : null;
      const summary = edited && p.target.team ? p.summary.split(callsign(p.target.team)).join(callsign(edited)) : p.summary;
      const team = edited ?? p.target.team ?? null;
      return entry({
        id: e.id, at: e.at, kind: "decision", sector: p.target.sector ?? null, team, refs: [p.id],
        text: `${by} ${p.status === "approved" ? (by === WATCH_BY ? "chose" : "approved") : p.status === "rejected" ? "rejected" : p.status} the AI's suggestion: ${summary}${edited ? ` (edited from ${callsign(p.target.team)})` : ""}`,
        detail: p.decision_reason,
        assign: p.status === "approved" && p.kind === "assign_sector" && p.target.sector && team ? { key: `${p.target.sector}|${team}`, rank: 0 } : null,
      });
    }
    case "task.updated": {
      const t = d as unknown as SectorTask | null;
      if (!t || t.state === "proposed") return null;
      const who = t.team_id ? callsign(t.team_id) : "";
      if (t.state === "assigned") {
        // the guided search's standing approval sends the agent's next picks: it says whose approval it was
        const standing = /approved in turn/.test(t.note ?? "");
        // whose standing approval: the visitor's Send all, Watch instead's, or the night search from last light
        const whose = /Watch instead/.test(t.note ?? "") ? "Watch instead chose Send all" : /last light/.test(t.note ?? "") ? "the night search from last light, a rule of the guided search" : "your standing approval: you chose Send all";
        return entry({
          id: e.id, at: e.at, kind: "decision", sector: t.sector_id, team: t.team_id, refs: [t.sector_id],
          text: standing ? `${t.sector_id} assigned to ${who}: the agent's pick, auto-approved (${whose})` : `${t.sector_id} assigned to ${who}`,
          assign: standing ? null : { key: `${t.sector_id}|${t.team_id ?? ""}`, rank: 2 },
        });
      }
      if (t.state === "in_progress") return entry({ id: e.id, at: e.at, kind: "checkin", sector: t.sector_id, team: t.team_id, refs: [t.sector_id], text: `${who} started ${t.sector_id}` });
      return entry({ id: e.id, at: e.at, kind: "checkin", sector: t.sector_id, team: t.team_id, refs: [t.sector_id], text: `${t.sector_id} searched at POD ${pct(t.pod ?? 0)}${who ? ` (${who})` : ""}`, detail: t.note ? `“${t.note}”` : null });
    }
    case "fleet.updated":
      // a demo flight's position reports are not news; the leg's start and end are
      if (/ on L\d+$/.test(e.summary)) return null;
      return entry({ id: e.id, at: e.at, kind: "drone", refs: e.ref ? [e.ref] : [], text: sentByYou(e.summary.replace(/ \(simulated fleet\)$/, "").replace(/^(L\d+) for Drone \d+ over /, "$1 over ")) });
    case "conditions.updated":
      return entry({ id: e.id, at: e.at, kind: "note", text: `Conditions looked up for ${(d as { area?: string } | null)?.area ?? "the area"}` });
    case "mission.note": {
      const action = d?.action as string | undefined;
      if (action === "found") return entry({ id: e.id, at: e.at, kind: "found", sector: e.ref, team: (d?.mission as { found?: { team?: string } })?.found?.team ?? null, text: `${e.summary}${byWords(d?.by as string | undefined)}` });
      if (action) {
        const sector = (d?.sector as string) ?? null;
        const team = (d?.team as string) ?? null;
        return entry({
          id: e.id, at: e.at, kind: "decision", sector, team, refs: e.ref ? [e.ref] : [], text: youSaid(e.summary, d?.by as string | undefined),
          assign: action === "assign" && sector && team ? { key: `${sector}|${team}`, rank: 1 } : null,
        });
      }
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
 * Who decided, in words: "You" for this console's own search manager (the cold test: approvals named no
 * one), the scenario's own as the search manager, else the name; never an unnamed approval.
 */
export function approverWord(by: string | null | undefined): string {
  if (!by) return "An unrecorded approver";
  if (by === WATCH_BY) return WATCH_BY;
  if (by === operatorName()) return "You";
  return scenarioManager(by);
}

/** " (recorded by you)", " (Watch instead chose it)", "": who made a recorded decision, said after it. */
export const byWords = (by: string | null | undefined): string => (!by ? "" : by === WATCH_BY ? " (Watch instead chose it)" : by === operatorName() ? " (recorded by you)" : ` (recorded by ${scenarioManager(by)})`);

/** A clue's state in the log: confirmed (and by whom), logged without mapping, or waiting for its read-back. */
function clueState(c: Clue, by: string | undefined): string {
  const who = !by ? "" : by === WATCH_BY ? " (Watch instead chose it)" : by === operatorName() ? " by you" : "";
  if (isLogged(c)) return `logged without mapping${who}: not confirmed, the map unchanged`;
  return c.confirmed ? `confirmed${who}` : "awaiting read-back";
}

/** A drone leg or recall this console's manager sent: "(sent by you)", "recalled to base camp by you". */
const sentByYou = (text: string) => {
  const me = operatorName();
  return text.replace(` (sent by ${me})`, " (sent by you)").replace(new RegExp(` by ${me.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), " by you");
};

/** A note of the manager's own action ("Search manager assigned B3 to Team Two") said as "You …" on their console. */
const youSaid = (text: string, by: string | undefined) => (by && by === operatorName() && text.startsWith(`${by} `) ? `You ${text.slice(by.length + 1)}` : text);

/**
 * The scenario's own search manager (the fixture's scripted decisions) is never shown as the visitor, who is
 * "Search manager" on this console (judges 2026-10-23); the usability test (2026-10-25) found "the scenario's"
 * confusing, so it reads "The search manager approved…" and the disclosure chip says the run is a simulation.
 */
export const scenarioManager = (text: string) =>
  text.replace(/(\b[Bb]y )?Search manager \(scripted for the demo fixture\)/g, (_, by: string | undefined) => (by ? `${by}the search manager` : "The search manager"));

/** The demo's per-line notes ("scripted for the demo fixture", "simulated relay"): the one disclosure chip says it once. */
export const plain = (text: string, ctx: PlainCtx = {}) =>
  plainWords(scenarioManager(text).replace(/\s*\((?:scripted|typed) for the demo fixture\)/g, "").replace(/\s*\(simulated(?: [a-z ]+)?\)/g, "").trim(), ctx);

/** A server's timeline entry as the console shows it. */
export function fromTimeline(e: TimelineEvent, i: number, teams: readonly Team[], turns: readonly RadioTurn[] = []): Entry {
  return entry({
    id: e.id ?? `t${i}`, at: e.at, kind: e.kind, team: teamOf(teams, e.team), sector: e.sector ?? null, text: plain(e.text), refs: e.refs ?? [],
    turn: e.turn_id ? (turns.find((t) => t.id === e.turn_id) ?? null) : null,
    audio: e.audio ?? null,
  });
}

/**
 * The timeline, newest first: the server's entries where it sends them (each carries the id of the event it
 * came from), and the mission's own events for the rest (a direct action just taken, the demo's moves).
 */
/** `ctx`: the fleet's leg names ("Drone 1 · flight line 1") for the lines that name a leg (terms.plainWords). */
export function buildTimeline(events: readonly MissionEvent[], teams: readonly Team[], server: readonly TimelineEvent[] = [], ctx: PlainCtx = {}): Entry[] {
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
  // (the guided search's standing approval's assignments are "auto-…": the visitor's too, never left out)
  const fresh = (e: Entry) => !server.length || (!known.has(e.id) && (e.id.startsWith("u") || e.id.startsWith("auto-") || e.at > last));
  const all = [...fromServer, ...derived.filter(fresh)];
  // every line in the console's words (the Trace keeps the engine's)
  for (const e of all) {
    if (e.kind === "radio") continue; // what a team said stays as said
    e.text = plainWords(e.text, ctx);
    if (e.detail) e.detail = plainWords(e.detail, ctx);
  }
  return merge(all.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)));
}

/** An approval, its "assigned" note and the board's line within this of each other are one assignment. */
const SAME_ASSIGN_MS = 2 * 60_000;

/**
 * Repeats merge: the same check-in or link note again and again is one line with a count ("×4"); one
 * assignment said three ways ("You approved agent p002: …", "You assigned B3 to Team Three", "B3 assigned to
 * Team Three") is the one line that says the most (the approval's, else the note's).
 */
function merge(newestFirst: Entry[]): Entry[] {
  const out: Entry[] = [];
  const seen = new Map<string, Entry>();
  const assigns = newestFirst.filter((e) => e.assign);
  const said = (e: Entry) =>
    !!e.assign && assigns.some((o) => o !== e && o.assign!.key === e.assign!.key && o.assign!.rank < e.assign!.rank && Math.abs(new Date(o.at).getTime() - new Date(e.at).getTime()) <= SAME_ASSIGN_MS);
  for (const e of newestFirst) {
    if (said(e)) continue;
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
