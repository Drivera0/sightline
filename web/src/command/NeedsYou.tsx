// Needs you (COMMAND_POST.md §5, right column): decisions only, never news. The agent's proposals (one-line
// reason, A/X/E), detections waiting for review (the review cards live here now), teams past their
// check-in, clues awaiting read-back, and on a live mission with the radio, briefings to send. Each item is
// one way of acting; the console's direct actions (the map, the T-cards) are the other, and both go to the
// timeline. Once the subject is found the decisions about the search are moot: pending proposals and
// candidates fold into one closed row ("16 items closed at 15:00, subject found", expandable); overdue teams
// and read-backs stay, and so do the direct actions (a team may still be recalled). Built by lane A.
import type { ReactNode } from "react";
import type { Clue, Drone, MissionEvent, Proposal, RadioTurn, Team } from "../contract";
import { Icon } from "../shell/icons";
import { useClock } from "../lib/time";
import { ApprovalInbox, type Decide } from "./ApprovalInbox";
import { needs } from "./console";
import { useConsole } from "./consoleStore";

const btn = "sl-tap inline-flex h-7 items-center rounded-full border border-line px-2.5 text-caption text-text-2 hover:border-border hover:text-text";

export function NeedsYou({
  proposals,
  teams,
  drones,
  events,
  clues,
  now,
  checkInMin,
  onDecide,
  imageUrl,
  clueNote,
  review,
  reviewCount,
  briefings,
  storyProposal,
  onCall,
  onRecall,
  onConfirmClue,
  found = null,
}: {
  proposals: readonly Proposal[];
  teams: readonly Team[];
  drones: readonly Drone[];
  events: readonly MissionEvent[];
  clues: readonly Clue[];
  now: Date;
  checkInMin: number;
  onDecide: Decide;
  imageUrl: (rel: string) => string;
  clueNote?: (p: Proposal) => string | null;
  /** The review cards (the demo's queue or a live mission's), and how many wait for an answer. */
  review: ReactNode;
  reviewCount: number;
  /** A live mission's approved briefings waiting for the operator's Transmit. */
  briefings?: ReactNode;
  storyProposal?: string | null;
  onCall: (teamId: string, draft?: string) => void;
  onRecall: (teamId: string) => void;
  onConfirmClue: (clueId: string) => void;
  /** The subject is found (Mission.status "found"): when, if the record says. Proposals and candidates close. */
  found?: { at: string | null } | null;
}) {
  const items = needs(proposals, teams, events, clues, now, checkInMin, reviewCount);
  const { time } = useClock();
  const callsign = (id: string | null) => teams.find((t) => t.id === id)?.callsign ?? id ?? "";
  const closedProposals = found ? proposals.filter((p) => p.status === "pending") : [];
  const closedReview = found ? reviewCount : 0;
  const closedCount = closedProposals.length + closedReview;
  const pendingCount = found ? 0 : items.filter((i) => i.kind === "proposal").length;
  const total = items.reduce((n, i) => n + (found && (i.kind === "proposal" || i.kind === "review") ? 0 : i.kind === "review" ? i.count : 1), 0);
  // phones: Needs you is its count, and expands on its tab (or a tap on the count)
  const open = useConsole((s) => s.tab === "needs");
  return (
    <section aria-label="Needs you" data-tour="needs" className="flex min-h-0 flex-col overflow-hidden lg:flex-1 rounded-lg border border-line bg-surface-solid">
      <h2 className="sl-panel-head">
        Needs you
        <span className={`text-caption font-normal ${total ? "text-accent" : found ? "text-ok" : "text-text-3"}`}>{total ? `${total} waiting` : found ? "subject found" : "nothing waiting"}</span>
        <button type="button" aria-expanded={open} onClick={() => useConsole.getState().setTab(open ? "map" : "needs")} className="sl-tap ml-auto text-caption font-normal text-text-2 lg:hidden">
          {open ? "Hide" : "Show"}
        </button>
      </h2>
      <div aria-label="Approvals rail" className={`min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2 ${open ? "flex" : "hidden lg:flex"}`}>
        {total === 0 && !found && <p className="px-1 py-2 text-small text-text-3">Nothing needs you. Proposals, candidates to review, overdue teams and clues to read back appear here.</p>}
        {found && (
          <ClosedOnFind
            proposals={closedProposals}
            reviewCount={closedReview}
            count={closedCount}
            at={found.at ? time(found.at) : null}
          />
        )}
        {pendingCount > 0 && <ApprovalInbox proposals={proposals} teams={teams} drones={drones} onDecide={onDecide} imageUrl={imageUrl} clueNote={clueNote} story={storyProposal} feedHref={undefined} />}
        {items
          .filter((i) => i.kind === "overdue")
          .map((i) =>
            i.kind === "overdue" ? (
              <article key={i.id} aria-label={`Overdue ${i.team.callsign}`} className="flex flex-col gap-1.5 rounded-md border border-alert/40 border-l-2 border-l-alert bg-bg/40 p-2.5">
                <span className="flex items-center gap-2 text-small font-medium text-text">
                  <Icon name="team" className="text-alert" />
                  {i.team.callsign} not heard {i.min === null ? "yet" : `for ${Math.round(i.min)} min`}
                </span>
                <span className="text-caption text-text-3">Past the {checkInMin}-minute check-in. Call them, or recall them to base camp.</span>
                <span className="flex gap-1.5">
                  <button type="button" className={btn} onClick={() => onCall(i.team.id, `${i.team.callsign}, Sightline. Radio check, over.`)}>
                    Call
                  </button>
                  <button type="button" className={btn} onClick={() => onRecall(i.team.id)}>
                    Recall
                  </button>
                </span>
              </article>
            ) : null,
          )}
        {items
          .filter((i) => i.kind === "readback")
          .map((i) =>
            i.kind === "readback" ? (
              <ReadBack key={i.id} clue={i.clue} turn={i.turn} who={callsign(i.team)} onConfirm={i.clue ? () => onConfirmClue(i.clue!.id) : undefined} onReply={i.team ? () => onCall(i.team!, `${callsign(i.team)}, Sightline. `) : undefined} />
            ) : null,
          )}
        {briefings}
        {/* the review cards stay mounted (their keys J/K/P/N/U) while there are any; answered ones fold away */}
        {!found && review}
      </div>
    </section>
  );
}

/** What the find closed: one row, expandable to the proposals and the candidates it closed. */
export function ClosedOnFind({ proposals, reviewCount, count, at }: { proposals: readonly Proposal[]; reviewCount: number; count: number; at: string | null }) {
  const head = count
    ? `${count} ${count === 1 ? "item" : "items"} closed${at ? ` at ${at}` : ""}, subject found`
    : `Subject found${at ? ` at ${at}` : ""}: nothing left to decide about the search`;
  return (
    <details aria-label="Closed: subject found" className="group rounded-md border border-ok/40 border-l-2 border-l-ok bg-bg/40 text-small">
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 px-2.5 py-2 text-text [&::-webkit-details-marker]:hidden">
        <Icon name="found" className="shrink-0 text-ok" />
        <span className="flex-1">{head}</span>
        {count > 0 && (
          <span aria-hidden="true" className="text-text-3 transition-transform group-open:rotate-90">
            ›
          </span>
        )}
      </summary>
      {count > 0 && (
        <ul className="flex flex-col gap-1 border-t border-line px-2.5 py-2 text-caption text-text-2">
          {proposals.map((p) => (
            <li key={p.id} className="flex items-baseline gap-2">
              <span className="font-mono text-text-3">{p.id}</span>
              <span className="min-w-0 flex-1 truncate" title={p.summary}>
                {p.summary}
              </span>
              <span className="shrink-0 text-text-3">closed: subject found</span>
            </li>
          ))}
          {reviewCount > 0 && (
            <li className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1">
                {reviewCount} {reviewCount === 1 ? "candidate" : "candidates"} to review
              </span>
              <span className="shrink-0 text-text-3">closed: subject found</span>
            </li>
          )}
        </ul>
      )}
    </details>
  );
}

function ReadBack({ clue, turn, who, onConfirm, onReply }: { clue: Clue | null; turn: RadioTurn | null; who: string; onConfirm?: () => void; onReply?: () => void }) {
  return (
    <article aria-label="Awaiting read-back" className="flex flex-col gap-1.5 rounded-md border border-caution/40 border-l-2 border-l-caution bg-bg/40 p-2.5">
      <span className="flex items-center gap-2 text-small font-medium text-text">
        <Icon name="clue" className="text-caution" />
        {clue ? `Clue to confirm: ${clue.text}` : `Read-back to ${who}`}
      </span>
      {turn?.reply && <span className="text-caption text-text-2">“{turn.reply}”</span>}
      {clue && <span className="text-caption text-text-3">{who ? `From ${who}. ` : ""}Read it back to the team to confirm it.</span>}
      <span className="flex gap-1.5">
        {onConfirm && (
          <button type="button" className={btn} onClick={onConfirm}>
            Confirm
          </button>
        )}
        {onReply && (
          <button type="button" className={btn} onClick={onReply}>
            Reply
          </button>
        )}
      </span>
    </article>
  );
}
