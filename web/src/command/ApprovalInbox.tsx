// The approval inbox (LANE_E §7.2, E-07): every agent proposal waits here for a person. Pending first,
// newest on top; decided ones collapse below with who decided and when. Approve (A), Reject (X, needs a
// one-line reason), Edit before approving (the team for an assignment, the briefing text). An approved
// briefing goes to the radio's outbound queue; nothing is transmitted from here. Keys act on the focused
// card only. Built by lane A for lane E (issue #70).

import { useState, type KeyboardEvent } from "react";
import type { EvidenceRef, Proposal, Team } from "../contract";
import { Badge, Label, Panel } from "../shell/components";

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
const OPERATOR_KEY = "sightline.operator";

function loadOperator(): string {
  try {
    return globalThis.sessionStorage?.getItem(OPERATOR_KEY) ?? "";
  } catch {
    return "";
  }
}

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");

export function ApprovalInbox({
  proposals,
  teams,
  onDecide,
  imageUrl,
}: {
  proposals: readonly Proposal[];
  teams: readonly Team[];
  onDecide: Decide;
  imageUrl: (rel: string) => string;
}) {
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

  return (
    <section aria-label="Approval inbox" className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <Label>Approvals · {pending.length} waiting</Label>
        <label className="flex items-center gap-2 text-small text-text-2">
          You are
          <input
            aria-label="Your name"
            className="w-44 rounded-sm border border-border bg-surface-strong px-2 py-1 text-small text-text"
            placeholder="Search manager"
            value={operator}
            onChange={(e) => saveOperator(e.target.value)}
          />
        </label>
      </header>
      {pending.length === 0 && <p className="text-small text-text-3">Nothing waiting. The agent's proposals appear here.</p>}
      {pending.map((p) => (
        <PendingCard key={p.id} p={p} teams={teams} by={operator.trim() || "Search manager"} onDecide={onDecide} imageUrl={imageUrl} />
      ))}
      {decided.length > 0 && (
        <details className="flex flex-col gap-1">
          <summary className="cursor-pointer text-small text-text-2">Decided ({decided.length})</summary>
          <ul className="flex flex-col gap-1 pt-2" aria-label="Decided proposals">
            {decided.map((p) => (
              <li key={p.id} className="flex flex-wrap gap-2 text-small">
                <Badge kind="info">{p.status}</Badge>
                <span className="text-text">{p.summary}</span>
                {p.decided_by && (
                  <span className="text-text-3">
                    {p.status === "approved" ? "Approved" : p.status === "rejected" ? "Rejected" : p.status} by {p.decided_by} at {time(p.decided_at)}
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
  by,
  onDecide,
  imageUrl,
}: {
  p: Proposal;
  teams: readonly Team[];
  by: string;
  onDecide: Decide;
  imageUrl: (rel: string) => string;
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
    <Panel tabIndex={0} onKeyDown={keys} aria-label={`Proposal ${p.id}`} className="flex flex-col gap-2 p-3 focus:outline focus:outline-accent">
      <div className="flex flex-wrap items-center gap-2">
        <Badge kind="info">{KIND_WORDS[p.kind]}</Badge>
        <span className="text-body text-text">{p.summary}</span>
        <span className="ml-auto font-mono text-caption text-text-3">
          {p.id} · {p.created_by}
        </span>
      </div>
      <button type="button" className="self-start text-left text-small text-text-2" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? p.reason : `${p.reason.slice(0, 140)}${p.reason.length > 140 ? "…" : ""}`}
      </button>
      {p.evidence.length > 0 && (
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
        <button type="button" onClick={approve} className="rounded-full border border-accent bg-accent/15 px-4 py-1.5 text-small text-text">
          Approve <span className="font-mono text-text-3">A</span>
        </button>
        {!rejecting && (
          <button type="button" onClick={() => setRejecting(true)} className="rounded-full border border-border px-4 py-1.5 text-small text-text-2">
            Reject <span className="font-mono text-text-3">X</span>
          </button>
        )}
        {(p.kind === "assign_sector" || p.briefing !== null) && (
          <button type="button" aria-pressed={editing} onClick={() => setEditing(!editing)} className="rounded-full border border-border px-4 py-1.5 text-small text-text-2">
            Edit
          </button>
        )}
      </div>
    </Panel>
  );
}
