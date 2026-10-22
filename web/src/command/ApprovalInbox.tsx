// The approval inbox (LANE_E §7.2, E-07): every agent proposal waits here for a person. Pending first,
// newest on top; decided ones collapse below with who decided and when. Approve (A), Reject (X, needs a
// one-line reason), Edit before approving (the team for an assignment, the briefing text). An approved
// briefing goes to the radio's outbound queue; nothing is transmitted from here. Keys act on the focused
// card only. Built by lane A for lane E (issue #70).

import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Drone, EvidenceRef, Proposal, Team } from "../contract";
import { Label, Panel, StatusPill } from "../shell/components";
import { useClock } from "../lib/time";
import { domain, OVERRIDE_SOURCE } from "./conditions";

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

/** The fact that grounded the drones, where it came from, and the drone's battery and position. */
function RecallFacts({ p, drone }: { p: Proposal; drone: Drone | undefined }) {
  const src = p.evidence.find((e) => e.kind === "conditions");
  const override = src?.ref === OVERRIDE_SOURCE;
  const url = src && /^https?:\/\//.test(src.ref) ? src.ref : null;
  return (
    <div aria-label="Why recall" className="flex flex-col gap-1 rounded-sm border border-line px-2 py-1.5 text-caption">
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

const OPERATOR_KEY = "sightline.operator";

function loadOperator(): string {
  try {
    return globalThis.sessionStorage?.getItem(OPERATOR_KEY) ?? "";
  } catch {
    return "";
  }
}


export function ApprovalInbox({
  proposals,
  teams,
  drones = [],
  onDecide,
  imageUrl,
  feedHref,
}: {
  proposals: readonly Proposal[];
  teams: readonly Team[];
  /** The fleet's drones now (a recall shows the drone's battery and position). */
  drones?: readonly Drone[];
  onDecide: Decide;
  imageUrl: (rel: string) => string;
  /** The mission's feed, linked when nothing is waiting (none inside the guided demo, which owns the address). */
  feedHref?: string;
}) {
  const { time } = useClock();
  const [operator, setOperator] = useState(loadOperator);
  const saveOperator = (name: string) => {
    setOperator(name);
    try {
      globalThis.sessionStorage?.setItem(OPERATOR_KEY, name);
    } catch {
      /* private mode: the name still works for this page */
    }
  };
  const newestFirst = [...proposals].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  const pending = newestFirst.filter((p) => p.status === "pending");
  const decided = newestFirst.filter((p) => p.status !== "pending");

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
    <section aria-label="Approval inbox" className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <Label className={pending.length ? "text-accent!" : undefined}>Approvals · {pending.length} waiting</Label>
        <label className="flex items-center gap-2 text-small text-text-2">
          You are
          <input
            aria-label="Your name"
            className="sl-tap w-44 rounded-sm border border-border bg-surface-strong px-2 py-1 text-small text-text"
            placeholder="Search manager"
            value={operator}
            onChange={(e) => saveOperator(e.target.value)}
          />
        </label>
      </header>
      {pending.length === 0 && (
        <div aria-label="Nothing waiting" className="flex flex-col gap-1.5 rounded-sm border border-dashed border-line px-3 py-4 text-small">
          <p className="text-text-2">Nothing waiting. Proposals appear here when the agent has evidence; they need a person's approval.</p>
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
          by={operator.trim() || "Search manager"}
          onDecide={decide}
          imageUrl={imageUrl}
          cardRef={(el) => {
            if (el) cards.current.set(p.id, el);
            else cards.current.delete(p.id);
          }}
        />
      ))}
      {decided.length > 0 && (
        <details className="flex flex-col gap-1">
          <summary className="sl-tap flex cursor-pointer items-center text-small text-text-2">Decided ({decided.length})</summary>
          <ul className="flex flex-col gap-1 pt-2" aria-label="Decided proposals">
            {decided.map((p) => (
              <li key={p.id} className="flex flex-wrap gap-2 text-small">
                <StatusPill tone={p.status === "approved" ? "ok" : "muted"} dot={false}>{p.status}</StatusPill>
                <span className="text-text">{p.summary}</span>
                {p.decided_by && (
                  <span className="text-text-3">
                    {p.status === "approved" ? "Approved" : p.status === "rejected" ? "Rejected" : p.status} by {p.decided_by} at {p.decided_at ? time(p.decided_at) : ""}
                    {p.decision_reason ? `: ${p.decision_reason}` : ""}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
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
  cardRef,
}: {
  p: Proposal;
  teams: readonly Team[];
  drone?: Drone;
  by: string;
  onDecide: Decide;
  imageUrl: (rel: string) => string;
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
  };

  return (
    <Panel ref={cardRef} tabIndex={0} onKeyDown={keys} aria-label={`Proposal ${p.id}`} className="flex flex-col gap-2 border-l-2 border-l-accent bg-surface-solid p-3 focus:outline focus:outline-accent">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone="action">{kindWords(p)}</StatusPill>
        <span className="text-body text-text">{isRecall(p) ? recallSummary(p.summary, drone?.battery_pct) : p.summary}</span>
        <span className="ml-auto font-mono text-caption text-text-3">
          {p.id} · {p.created_by}
        </span>
      </div>
      <button type="button" className="sl-tap self-start text-left text-small text-text-2" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? p.reason : `${p.reason.slice(0, 140)}${p.reason.length > 140 ? "…" : ""}`}
      </button>
      {isRecall(p) && <RecallFacts p={p} drone={drone} />}
      {p.evidence.length > 0 && !isRecall(p) && (
        <div className="flex flex-wrap gap-2" aria-label="Evidence">
          {p.evidence.map((ev) =>
            IMAGE_EVIDENCE.includes(ev.kind) ? (
              <figure key={ev.ref} className="flex w-24 flex-col gap-1">
                <img src={imageUrl(ev.ref)} alt={ev.caption} className="aspect-square w-24 rounded-sm object-cover" />
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
      {!editing && p.briefing && <p className="text-small text-text-2">Briefing: “{p.briefing}”</p>}
      {editing && (
        <div className="flex flex-col gap-2" aria-label="Edit before approving">
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
      <div className="flex gap-2">
        <button type="button" onClick={approve} className="sl-tap rounded-full border border-accent bg-accent/15 px-4 py-1.5 text-small text-text">
          Approve <span className="font-mono text-text-3">A</span>
        </button>
        {!rejecting && (
          <button type="button" onClick={() => setRejecting(true)} className="sl-tap rounded-full border border-border px-4 py-1.5 text-small text-text-2">
            Reject <span className="font-mono text-text-3">X</span>
          </button>
        )}
        {(p.kind === "assign_sector" || p.briefing !== null) && (
          <button type="button" aria-pressed={editing} onClick={() => setEditing(!editing)} className="sl-tap rounded-full border border-border px-4 py-1.5 text-small text-text-2">
            Edit
          </button>
        )}
      </div>
    </Panel>
  );
}
