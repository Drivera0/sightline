// The agent's proposals in Needs You (LANE_E §7.2, E-07; COMMAND_POST.md §5): each waits here for a
// person, newest on top (Needs you asks for oldest first), as one question ("Send Team One to C2?") with a
// one-line reason (the rest on a click). Approve (A) is a button that says the outcome ("Send Team One to
// C2"), Reject (X, needs a one-line reason) and Edit before approving (E: the team for an assignment, the
// briefing text) are smaller. `highlight` rings one card and dims the rest (the guided search). Decided ones
// leave for the timeline ("Search manager approved agent p003"). An approved briefing goes to the radio's
// outbound queue; nothing is transmitted from here. Keys act on the focused card only. The person acting is
// the console's one name (lib/mission operatorName). Built by lane A for lane E (issue #70).

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Drone, EvidenceRef, Proposal, Team } from "../contract";
import { KeyHint, StatusPill } from "../shell/components";
import { operatorName } from "../lib/mission";
import { clueNoteFor } from "./clueShift";
import { domain, OVERRIDE_SOURCE } from "./conditions";
import { useConsole } from "./consoleStore";
import { AgentNote, RadioBubble } from "./RadioBubble";

export type Decide = (
  pid: string,
  decision: "approve" | "reject",
  by: string,
  reason?: string,
  edits?: Record<string, string>,
) => void | Promise<void>;

const KIND_WORDS: Record<Proposal["kind"], string> = {
  drone_leg: "Drone",
  retask_drone: "Re-task drone",
  assign_sector: "Team",
  promote_detection: "Review queue",
  dismiss_detection: "Review queue",
  alert: "Alert",
};
const IMAGE_EVIDENCE: readonly EvidenceRef["kind"][] = ["crop", "frame", "relook"];
/** A reason longer than this shows two lines and a "Show the whole reason" link. */
const REASON_SHORT = 140;

/** A recall: a re-task whose leg flies the drone home (target `home`), proposed when conditions ground the drones. */
export const isRecall = (p: Proposal) => p.kind === "retask_drone" && p.target.home !== undefined;
const kindWords = (p: Proposal) => (isRecall(p) ? "Recall drone" : KIND_WORDS[p.kind]);

/**
 * A recall's summary carries the battery when the agent proposed it ("battery 97%"): say so, and put the
 * fleet's live value beside it ("battery 97% at proposal, now 95%"), so the card never shows an old number as current.
 */
export function recallSummary(summary: string, liveBatteryPct?: number): string {
  return summary.replace(/battery (\d+(?:\.\d+)?) ?%/, (_, at: string) => {
    const now = liveBatteryPct === undefined ? "" : `, now ${liveBatteryPct.toFixed(0)}%`;
    return `battery ${at}% at proposal${now}`;
  });
}

/**
 * What a proposal asks, as one question, and its Approve button in the words of the outcome ("Send Team One
 * to C2"): the search manager reads what pressing it does, not "Approve". `team` is the team picked in Edit.
 */
export function proposalAsk(p: Proposal, teams: readonly Team[], drones: readonly Drone[] = [], team?: string): { ask: string; action: string } {
  const callsign = (id: string | undefined) => (id === "all" ? "all teams" : (teams.find((t) => t.id === id)?.callsign ?? id));
  const droneName = (id: string | undefined) => drones.find((d) => d.id === id)?.name ?? id;
  const sector = p.target.sector ?? p.leg?.sector_id;
  const drone = droneName(p.target.drone ?? p.leg?.drone_id);
  const det = p.target.detection;
  const fallback = { ask: p.summary, action: "Approve" };
  switch (p.kind) {
    case "assign_sector": {
      const t = callsign(team || p.edits?.team || p.target.team);
      return t && sector ? { ask: `Send ${t} to ${sector}?`, action: `Send ${t} to ${sector}` } : fallback;
    }
    case "drone_leg":
      return drone && sector ? { ask: `Fly ${drone} over ${sector}?`, action: `Fly ${drone} over ${sector}` } : fallback;
    case "retask_drone":
      if (isRecall(p)) return drone ? { ask: `Bring ${drone} back to base now?`, action: `Bring ${drone} home` } : fallback;
      return drone && sector ? { ask: `Re-task ${drone} to ${sector}?`, action: `Re-task ${drone} to ${sector}` } : fallback;
    case "promote_detection":
      return det ? { ask: `Put ${det} in the review queue?`, action: `Add ${det} to review` } : fallback;
    case "dismiss_detection":
      return det ? { ask: `Drop ${det} from the review queue?`, action: `Drop ${det}` } : fallback;
    default:
      return { ask: p.summary, action: "Acknowledge" };
  }
}

/** The fact that grounded the drones, where it came from, and the drone's battery and position. */
function RecallFacts({ p, drone }: { p: Proposal; drone: Drone | undefined }) {
  const src = p.evidence.find((e) => e.kind === "conditions");
  const override = src?.ref === OVERRIDE_SOURCE;
  const url = src && /^https?:\/\//.test(src.ref) ? src.ref : null;
  return (
    <div role="group" aria-label="Why recall" className="flex flex-col gap-1 rounded-sm border border-line px-2 py-1.5 text-caption">
      {src && (
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          {url ? (
            <q className="font-mono text-text">{src.caption}</q>
          ) : (
            // an override's caption names its source; the pill below says it instead
            <span className="font-mono text-text">{override ? src.caption.split(" (")[0] : src.caption}</span>
          )}
          {url && (
            <a href={url} target="_blank" rel="noreferrer" title={url} className="text-text-2 underline decoration-text-3 underline-offset-2 hover:text-text">
              {domain(url)} <span aria-hidden>↗</span>
            </a>
          )}
          {override && (
            <StatusPill tone="caution" dot={false}>
              Demo override: not from Tavily
            </StatusPill>
          )}
        </span>
      )}
      {drone && (
        <span className="text-text-2">
          {drone.name} now: battery {drone.battery_pct.toFixed(0)}%, {drone.status}
          {drone.position && (
            <span className="font-mono text-text-3">
              {" "}
              at {drone.position.lat.toFixed(5)}, {drone.position.lon.toFixed(5)}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
/** The nearest ancestor that scrolls vertically (the console's Approvals rail), or null (the page). */
function scroller(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if ((y === "auto" || y === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** Scroll `el`'s rail so `el` sits at its top; with no rail, the page brings it into view. */
export function bringToTop(el: HTMLElement): void {
  const rail = scroller(el);
  if (!rail) {
    el.scrollIntoView?.({ block: "nearest" });
    return;
  }
  rail.scrollTop += el.getBoundingClientRect().top - rail.getBoundingClientRect().top;
}

export function ApprovalInbox({
  proposals,
  teams,
  drones = [],
  onDecide,
  imageUrl,
  feedHref,
  clueNote,
  story = null,
  order = "newest",
  highlight = null,
}: {
  /** Newest first (the inbox on its own), or oldest first (Needs you: what has waited longest on top). */
  order?: "newest" | "oldest";
  /** A proposal to point at (the guided search): it is ringed, the others dimmed. Null: none. */
  highlight?: string | null;
  proposals: readonly Proposal[];
  teams: readonly Team[];
  /** The fleet's drones now (a recall shows the drone's battery and position). */
  drones?: readonly Drone[];
  onDecide: Decide;
  imageUrl: (rel: string) => string;
  /** The mission's feed, linked when nothing is waiting (none inside the guided demo, which owns the address). */
  feedHref?: string;
  /** The clues behind an assignment's sector, from the map log (clueShift.ts); null when none moved it. */
  clueNote?: (p: Proposal) => string | null;
  /** The proposal the story's coach mark points at (`data-story-proposal`). */
  story?: string | null;
}) {
  const newestFirst = [...proposals].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  const pending = (order === "oldest" ? newestFirst.reverse() : newestFirst).filter((p) => p.status === "pending");
  // the proposals the inbox opened with are not new; one that comes later slides in with a slow ring
  const known = useRef<Set<string> | null>(null);
  if (known.current === null) known.current = new Set(proposals.map((p) => p.id));

  // After a decision the card leaves the list: bring the next pending card to the top of the rail (and
  // focus it, so A and X act on it), rather than leave the rail scrolled to the middle of a card.
  const cards = useRef(new Map<string, HTMLElement>());
  const [handoff, setHandoff] = useState<{ decided: string; next: string } | null>(null);
  const pendingIds = pending.map((p) => p.id).join(" ");
  useLayoutEffect(() => {
    if (!handoff || pendingIds.split(" ").includes(handoff.decided)) return; // not out of the list yet
    const el = cards.current.get(handoff.next);
    if (el) {
      bringToTop(el);
      el.focus({ preventScroll: true });
    }
    setHandoff(null);
  }, [handoff, pendingIds]);
  const decide: Decide = (pid, ...rest) => {
    const i = pending.findIndex((p) => p.id === pid);
    const next = pending[i + 1] ?? pending[i - 1];
    setHandoff(next ? { decided: pid, next: next.id } : null);
    return onDecide(pid, ...rest);
  };

  return (
    <section aria-label="Approval inbox" className="flex flex-col gap-2">
      {pending.length === 0 && feedHref !== undefined && (
        <div role="group" aria-label="Nothing waiting" className="flex flex-col gap-1.5 rounded-md border border-dashed border-line px-3 py-3 text-small">
          <p className="text-text-2">No proposals waiting.</p>
          {feedHref && (
            <a href={feedHref} className="sl-tap self-start text-accent-soft underline underline-offset-2 hover:text-text">
              See what the agent is doing in the feed
            </a>
          )}
        </div>
      )}
      {pending.map((p) => (
        <PendingCard
          key={p.id}
          p={p}
          teams={teams}
          drone={drones.find((d) => d.id === p.target.drone)}
          by={operatorName()}
          onDecide={decide}
          imageUrl={imageUrl}
          clues={p.kind === "assign_sector" ? clueNoteFor(p.reason, clueNote?.(p) ?? null) : null}
          story={p.id === story}
          highlighted={highlight === p.id}
          dimmed={highlight !== null && highlight !== p.id}
          drones={drones}
          fresh={!known.current?.has(p.id)}
          cardRef={(el) => {
            if (el) cards.current.set(p.id, el);
            else cards.current.delete(p.id);
          }}
        />
      ))}
    </section>
  );
}

function PendingCard({
  p,
  teams,
  drone,
  by,
  onDecide,
  imageUrl,
  clues = null,
  story = false,
  fresh = false,
  highlighted = false,
  dimmed = false,
  drones = [],
  cardRef,
}: {
  p: Proposal;
  teams: readonly Team[];
  drone?: Drone;
  /** Every drone (the question names the drone a leg would fly). */
  drones?: readonly Drone[];
  /** Pointed at from outside (the guided search): ringed; `data-highlighted`. */
  highlighted?: boolean;
  /** Another item is pointed at: this one steps back; `data-dimmed`. */
  dimmed?: boolean;
  by: string;
  onDecide: Decide;
  imageUrl: (rel: string) => string;
  /** Which clues moved the sector's probability (from the map log), or null. */
  clues?: string | null;
  story?: boolean;
  /** Came in after the inbox opened: it slides in with a slow ring. */
  fresh?: boolean;
  cardRef?: (el: HTMLDivElement | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [why, setWhy] = useState("");
  const [team, setTeam] = useState(p.target.team ?? "");
  const [briefing, setBriefing] = useState(p.briefing ?? "");

  const edits = (): Record<string, string> | undefined => {
    const e: Record<string, string> = {};
    if (p.kind === "assign_sector" && team && team !== p.target.team) e.team = team;
    if (p.briefing !== null && briefing.trim() && briefing.trim() !== p.briefing) e.briefing = briefing.trim();
    return Object.keys(e).length ? e : undefined;
  };
  const approve = () => void onDecide(p.id, "approve", by, undefined, edits());
  const reject = () => {
    if (!why.trim()) return;
    void onDecide(p.id, "reject", by, why.trim());
  };
  const keys = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return; // typing in a field inside the card
    if (e.key === "a" || e.key === "A") approve();
    if (e.key === "x" || e.key === "X") setRejecting(true);
    if ((e.key === "e" || e.key === "E") && canEdit) setEditing((v) => !v);
  };
  const canEdit = p.kind === "assign_sector" || p.briefing !== null;
  // in focus, the map glows its sector and the team's card glows violet; a new one takes the focus if it is free
  const focused = useConsole((s) => s.focus?.kind === "proposal" && s.focus.id === p.id);
  const take = () => useConsole.getState().setFocus({ kind: "proposal", id: p.id });
  useEffect(() => {
    if (fresh && !useConsole.getState().focus) take();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ask = proposalAsk(p, teams, drones.length ? drones : drone ? [drone] : [], team);
  return (
    <div
      ref={cardRef}
      tabIndex={0}
      onKeyDown={keys}
      onFocus={take}
      onClick={take}
      data-focused={focused || undefined}
      aria-label={`Proposal ${p.id}`}
      data-proposal={p.id}
      data-need={p.id}
      data-need-kind="proposal"
      data-highlighted={highlighted || undefined}
      data-dimmed={dimmed || undefined}
      {...(story ? { "data-story-proposal": "" } : {})}
      style={{ ["--c" as string]: "var(--proposal)" }}
      className={`flex flex-col gap-2 rounded-md border border-line border-l-[3px] border-l-[var(--proposal)] bg-bg/40 p-2.5 transition-opacity focus:outline focus:outline-[var(--proposal)] ${fresh ? "sl-slide-in sl-new" : ""} ${focused || highlighted ? "sl-glow-proposal" : ""} ${dimmed ? "opacity-50" : ""}`}
    >
      <div className="flex items-center gap-2">
        <StatusPill tone="proposal">{kindWords(p)}</StatusPill>
        <span className="ml-auto font-mono text-caption text-text-3" title={`proposed by the ${p.created_by}`}>
          {p.id}
        </span>
      </div>
      <span className="text-body font-medium text-text">{ask.ask}</span>
      {isRecall(p) && <span className="text-caption text-text-2">{recallSummary(p.summary, drone?.battery_pct)}</span>}
      <AgentNote>
        <p className={open || p.reason.length <= REASON_SHORT ? "" : "line-clamp-2"}>{p.reason}</p>
        {p.reason.length > REASON_SHORT && (
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="sl-tap self-start text-caption text-text-2 underline underline-offset-2 hover:text-text">
            {open ? "Show less" : "Show the whole reason"}
          </button>
        )}
      </AgentNote>
      {clues && (
        <p aria-label="Clues behind it" className="text-small text-text-2">
          <span className="text-text-3">Clues behind it, from the map log: </span>
          {clues}.
        </p>
      )}
      {isRecall(p) && <RecallFacts p={p} drone={drone} />}
      {p.evidence.length > 0 && !isRecall(p) && (
        <div role="group" className="flex flex-wrap gap-2" aria-label="Evidence">
          {p.evidence.map((ev) =>
            IMAGE_EVIDENCE.includes(ev.kind) ? (
              <figure key={ev.ref} className="flex w-24 flex-col gap-1">
                <img loading="lazy" decoding="async" src={imageUrl(ev.ref)} alt={ev.caption} className="aspect-square w-24 rounded-sm object-cover" />
                <figcaption className="text-caption text-text-3">{ev.caption}</figcaption>
              </figure>
            ) : (
              <span key={ev.ref} className="rounded-sm bg-surface-strong px-2 py-1 text-caption text-text-2">
                {ev.kind} {ev.ref}
              </span>
            ),
          )}
        </div>
      )}
      {!editing && p.briefing && (
        <RadioBubble to={teams.find((t) => t.id === (team || p.target.team))?.callsign ?? (p.target.team === "all" ? "all teams" : (p.target.team ?? "the team"))} text={p.briefing} callsigns={teams.map((t) => t.callsign)} />
      )}
      {editing && (
        <div role="group" className="flex flex-col gap-2" aria-label="Edit before approving">
          {p.kind === "assign_sector" && (
            <label className="flex items-center gap-2 text-small text-text-2">
              Team
              <select className="rounded-sm border border-border bg-surface-strong px-2 py-1 text-small text-text" value={team} onChange={(e) => setTeam(e.target.value)}>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.callsign} ({t.status})
                  </option>
                ))}
              </select>
            </label>
          )}
          {p.briefing !== null && (
            <label className="flex flex-col gap-1 text-small text-text-2">
              Briefing (read on the radio after you approve)
              <textarea className="rounded-sm border border-border bg-surface-strong p-2 text-small text-text" rows={3} value={briefing} onChange={(e) => setBriefing(e.target.value)} />
            </label>
          )}
        </div>
      )}
      {rejecting && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            reject();
          }}
        >
          <input
            aria-label="Why reject"
            autoFocus
            className="min-w-0 flex-1 rounded-sm border border-border bg-surface-strong px-2 py-1 text-small text-text"
            placeholder="One line: why not"
            value={why}
            onChange={(e) => setWhy(e.target.value)}
          />
          <button type="submit" disabled={!why.trim()} className="rounded-full border border-warn px-3 py-1 text-small text-text disabled:opacity-40">
            Reject
          </button>
        </form>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {/* the primary action says its outcome; "Approve" is in its name for screen readers and the A key */}
        <button
          type="button"
          onClick={approve}
          data-primary=""
          className="sl-tap inline-flex h-9 max-w-full items-center gap-2 rounded-full border border-[var(--proposal)] bg-[color-mix(in_srgb,var(--proposal)_18%,transparent)] px-4 text-small font-medium text-text hover:bg-[color-mix(in_srgb,var(--proposal)_28%,transparent)]"
        >
          <span className="sr-only">Approve: </span>
          <span className="truncate">{ask.action}</span> <KeyHint>A</KeyHint>
        </button>
        {!rejecting && (
          <button type="button" onClick={() => setRejecting(true)} className="sl-tap inline-flex h-7 items-center gap-1.5 rounded-full px-2 text-caption text-text-2 hover:bg-surface hover:text-text">
            Reject <KeyHint>X</KeyHint>
          </button>
        )}
        {canEdit && (
          <button type="button" aria-pressed={editing} onClick={() => setEditing(!editing)} className="sl-tap inline-flex h-7 items-center gap-1.5 rounded-full px-2 text-caption text-text-2 hover:bg-surface hover:text-text aria-pressed:text-text">
            {p.kind === "assign_sector" ? "Edit team or briefing" : "Edit briefing"} <KeyHint>E</KeyHint>
          </button>
        )}
      </div>
      {p.kind === "assign_sector" && p.target.sector && <p className="text-caption text-text-3">or do it yourself: click {p.target.sector} on the map</p>}
    </div>
  );
}
