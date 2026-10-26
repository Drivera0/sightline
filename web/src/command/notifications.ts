// Which mission events become toasts (V3 §2: "every event kind maps to a toast template"), pure, and the
// hook that watches the mission's events and pushes the new ones (shell/notify.ts). The search manager's
// own actions (a decision, an assignment, a call) are not news to them and make no toast; a clock jump on
// the demo (the story seeking) is not news either: a burst that large reseeds silently. Built by lane A.
import { useEffect, useRef } from "react";
import type { Clue, MissionEvent, Proposal, RadioTurn, Team } from "../contract";
import { useNotify, type NoteDraft } from "../shell/notify";
import { plain, teamOf } from "./timeline";

/** More new events than this at once is a jump (the story seeking), not news. */
export const BURST = 150;

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const short = (s: string, n = 110) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The toast for one mission event, or null when it is not news (a position report, the manager's own action). */
export function toastFor(e: MissionEvent, teams: readonly Pick<Team, "id" | "callsign">[]): NoteDraft | null {
  const d = e.data as Record<string, unknown> | null;
  const callsign = (id: string | null | undefined) => teams.find((t) => t.id === id)?.callsign ?? id ?? "";
  switch (e.type) {
    case "proposal.new": {
      const p = d as unknown as Proposal | null;
      const id = p?.id ?? e.ref ?? "";
      return { key: `proposal:${id}`, tone: "proposal", title: "The agent proposes", body: short(plain(p?.summary ?? e.summary)), target: { kind: "proposal", id } };
    }
    case "clue.added": {
      const c = d as unknown as Clue | null;
      if (!c || / confirmed$/.test(e.summary)) return null; // a read-back confirmed: the timeline has it
      const by = teamOf(teams, c.reported_by);
      return {
        key: `clue:${c.id}`, tone: "clue", title: `New clue${by ? ` from ${callsign(by)}` : ""}`,
        body: short(`${cap(c.kind)}: ${c.text}`), target: { kind: "clue", id: c.id },
      };
    }
    case "radio.turn": {
      const t = d as unknown as RadioTurn | null;
      if (!t || t.direction !== "in") return null;
      const team = teamOf(teams, t.callsign);
      const words = plain(t.transcript.replace(/\s*\(typed for the demo fixture\)$/, ""));
      // a team's "copy" to the manager's own call is an answer, not news
      if (/^Sightline, [^.]+\. Copy, over\.$/.test(words)) return null;
      return { key: `radio:${team ?? t.callsign}`, tone: "team", title: `${t.callsign ?? "A team"} on the radio`, body: short(words), target: { kind: "radio", id: t.id } };
    }
    case "verdict": {
      const v = d as { detection_id?: string; person?: string } | null;
      const id = v?.detection_id ?? e.ref ?? null;
      const word = v?.person === "yes" ? "likely a person" : v?.person === "no" ? "probably not a person" : "unclear";
      return { key: `verdict:${id}`, tone: "review", title: "AI second look done", body: `${id}: ${word}`, target: { kind: "candidate", id } };
    }
    case "team.updated": {
      const t = d as unknown as Team | null;
      if (t?.status !== "overdue") return null;
      return { key: `overdue:${t.id}`, tone: "alert", title: `${t.callsign} is overdue`, body: "Past the check-in. Call them, or recall them.", target: { kind: "team", id: t.id }, action: "Show team" };
    }
    case "fleet.updated":
      if (/ back at base camp/.test(e.summary)) return { key: `drone:${e.ref ?? ""}`, tone: "drone", title: "Drone back at base camp", body: plain(e.summary) };
      if (/link lost/i.test(e.summary)) return { key: `link:${e.ref ?? ""}`, tone: "alert", title: "Drone link lost", body: plain(e.summary) };
      return null;
    case "mission.note": {
      const action = d?.action as string | undefined;
      if (action === "found") {
        const m = d?.mission as { found?: { team?: string; sector?: string } } | undefined;
        const sector = m?.found?.sector ?? e.ref ?? "";
        return { key: "found", tone: "found", title: "Subject located", body: `${callsign(m?.found?.team)} in ${sector}`.trim(), target: { kind: "found" } };
      }
      return null; // the manager's own actions, and notes
    }
    default:
      return null;
  }
}

/** A team past its check-in: an alert toast once each time it goes overdue (V3 §2; the judges' Team Three). */
export function overdueToast(team: Pick<Team, "id" | "callsign">, min: number | null, checkInMin: number): NoteDraft {
  return {
    key: `overdue:${team.id}`, tone: "alert", title: `${team.callsign} is overdue`,
    body: `${min === null ? "Not heard yet" : `Not heard for ${Math.round(min)} min`}, past the ${checkInMin}-minute check-in. Call them, or recall them.`,
    target: { kind: "team", id: team.id }, action: "Show team",
  };
}

/** Toast each team that goes overdue (computed from when it was last heard, not only a server's status). */
export function useOverdueToasts(overdue: readonly { team: Pick<Team, "id" | "callsign">; min: number | null }[], checkInMin: number): void {
  const seen = useRef<Set<string> | null>(null);
  const key = overdue.map((o) => o.team.id).join(" ");
  useEffect(() => {
    const ids = new Set(overdue.map((o) => o.team.id));
    const was = seen.current;
    seen.current = ids;
    if (!was) return;
    for (const o of overdue) if (!was.has(o.team.id)) useNotify.getState().push(overdueToast(o.team, o.min, checkInMin));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** The "N candidates to review" toast: its count is how many wait now. */
export function reviewToast(waiting: number): NoteDraft {
  return {
    key: "review",
    tone: "review",
    title: `${waiting} ${waiting === 1 ? "candidate" : "candidates"} to review`,
    body: "Photos landed. Person, Not a person or Unsure (P, N, U).",
    target: { kind: "candidate", id: null },
    action: "Review now",
  };
}

/** A radio call landed and no clue has been added on this console yet: how to add one (shown once). */
export const CLUE_HINT_KEY = "sightline.clueHint";
export function clueHint(): NoteDraft {
  return {
    key: "clue-hint",
    tone: "clue",
    title: "Heard a clue on the radio?",
    body: "Add clue in the timeline's header, or right-click (long-press) the map where it was found.",
    action: "Add clue",
    target: { kind: "addClue" },
  };
}

/** What is new in `events` since `seen`, or null for a jump (reseed without toasts). */
export function freshEvents(seen: ReadonlySet<string> | null, events: readonly MissionEvent[]): MissionEvent[] | null {
  if (seen === null) return null;
  const fresh = events.filter((e) => !seen.has(e.id));
  if (fresh.length > BURST) return null;
  // the clock went back (events left the list): a jump too
  if (events.length < seen.size && fresh.length === 0) return null;
  return fresh;
}

/**
 * Watch the mission's events: each new one that is news becomes a toast. `onHint`: the first radio call
 * that lands on this console, once per browser, gets the "add a clue" hint. `quiet` (the guided search,
 * whose coach bar says each row as it lands and whose decision is in one place): nothing is pushed, but
 * what was seen is kept, so leaving it brings no burst.
 */
export function useEventToasts(events: readonly MissionEvent[], teams: readonly Team[], waiting: number, proposals: readonly Proposal[] = [], quiet = false): void {
  const quietRef = useRef(quiet);
  quietRef.current = quiet;
  const proposalsRef = useRef(proposals);
  proposalsRef.current = proposals;
  const seen = useRef<Set<string> | null>(null);
  const teamsRef = useRef(teams);
  teamsRef.current = teams;
  useEffect(() => {
    const fresh = freshEvents(seen.current, events);
    seen.current = new Set(events.map((e) => e.id));
    if (!fresh || quietRef.current) return;
    const push = useNotify.getState().push;
    for (const e of fresh) {
      const t = toastFor(e, teamsRef.current);
      // a proposal already decided by the time it is seen (the demo's script, another console) is not news
      if (t && e.type === "proposal.new" && proposalsRef.current.find((p) => p.id === e.ref)?.status !== undefined && proposalsRef.current.find((p) => p.id === e.ref)?.status !== "pending") continue;
      if (t) push(t);
      if (e.type === "radio.turn" && t && !hintShown()) {
        markHint();
        push(clueHint());
      }
    }
  }, [events]);
  // the review queue: a toast whenever more candidates wait than before
  const before = useRef<number | null>(null);
  useEffect(() => {
    const was = before.current;
    before.current = waiting;
    if (was !== null && waiting > was && !quietRef.current) useNotify.getState().push(reviewToast(waiting));
  }, [waiting]);
}

function hintShown(): boolean {
  try {
    return globalThis.localStorage?.getItem(CLUE_HINT_KEY) === "1";
  } catch {
    return false;
  }
}
function markHint(): void {
  try {
    globalThis.localStorage?.setItem(CLUE_HINT_KEY, "1");
  } catch {
    /* private mode: shown again next visit */
  }
}
