// Needs you (COMMAND_POST.md §5, right column): decisions only, never news. The agent's proposals (one-line
// reason, A/X/E), detections waiting for review (the review cards live here now), teams past their
// check-in, clues awaiting read-back, and on a live mission with the radio, briefings to send. Each item is
// one way of acting; the console's direct actions (the map, the T-cards) are the other, and both go to the
// timeline. Once the subject is found the decisions about the search are moot: pending proposals and
// candidates fold into one closed row ("16 items closed at 15:00, subject found", expandable); overdue teams
// and read-backs stay, and so do the direct actions (a team may still be recalled). Built by lane A.
import { useState, type ReactNode } from "react";
import type { Clue, Drone, MissionEvent, Proposal, RadioTurn, Team } from "../contract";
import { Icon } from "../shell/icons";
import { useClock } from "../lib/time";
import { ApprovalInbox, type Decide } from "./ApprovalInbox";
import { needs, sightingReports } from "./console";

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
  tasks = [],
  onFound,
}: {
  /** The sectors' tasks: a team's sector for Record find. */
  tasks?: readonly { sector_id: string; state: string; team_id: string | null }[];
  /** Record the find (a team reported the subject on the radio). */
  onFound?: (teamId: string, sector: string) => void;
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
  // a team reported the subject on the radio: record the find from here (no need to find the sector's popover)
  const reports = !found && onFound ? sightingReports(events, teams, tasks) : [];
  const { time } = useClock();
  const callsign = (id: string | null) => teams.find((t) => t.id === id)?.callsign ?? id ?? "";
  const closedProposals = found ? proposals.filter((p) => p.status === "pending") : [];
  const closedReview = found ? reviewCount : 0;
  const closedCount = closedProposals.length + closedReview;
  const pendingCount = found ? 0 : items.filter((i) => i.kind === "proposal").length;
  const total = reports.length + items.reduce((n, i) => n + (found && (i.kind === "proposal" || i.kind === "review") ? 0 : i.kind === "review" ? i.count : 1), 0);

  return (
    <section aria-label="Needs you" data-tour="needs" className="flex min-h-0 flex-col overflow-hidden lg:flex-1 rounded-lg border border-line bg-surface-solid">
      <h2 className="sl-panel-head">
        Needs you
        <span className={`text-caption font-normal ${total ? "text-accent" : found ? "text-ok" : "text-text-3"}`}>{total ? `${total} waiting` : found ? "subject found" : "nothing waiting"}</span>
      </h2>
      {/* never folded away: on a phone it scrolls inside a capped height, above the map */}
      <div aria-label="Approvals rail" className="flex max-h-[60vh] min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2 lg:max-h-none">
        {total === 0 && !found && <p className="px-1 py-2 text-small text-text-3">Nothing needs you. Proposals, candidates to review, overdue teams and clues to read back appear here.</p>}
        {found && (
          <ClosedOnFind
            proposals={closedProposals}
            reviewCount={closedReview}
            count={closedCount}
            at={found.at ? time(found.at) : null}
          />
        )}
        {reports.map((r) => (
          <article key={r.team.id} aria-label={`${r.team.callsign} reports the subject`} className="sl-slide-in flex flex-col gap-1.5 rounded-md border border-found/50 border-l-2 border-l-found bg-bg/40 p-2.5">
            <span className="flex items-center gap-2 text-small font-medium text-text">
              <Icon name="found" className="text-found" />
              {r.team.callsign} reports the subject{r.sector ? ` in ${r.sector}` : ""}
            </span>
            <span className="text-caption text-text-2">“{r.words}”</span>
            <span className="flex gap-1.5">
              {r.sector && (
                <button type="button" className={`${btn} border-found/60! text-text!`} onClick={() => onFound?.(r.team.id, r.sector!)}>
                  Record find
                </button>
              )}
              <button type="button" className={btn} onClick={() => onCall(r.team.id, `${r.team.callsign}, Sightline. Copy, stay with the subject, over.`)}>
                Reply
              </button>
            </span>
          </article>
        ))}
        {pendingCount > 0 && <ApprovalInbox proposals={proposals} teams={teams} drones={drones} onDecide={onDecide} imageUrl={imageUrl} clueNote={clueNote} story={storyProposal} feedHref={undefined} />}
        {items
          .filter((i) => i.kind === "overdue")
          .map((i) =>
            i.kind === "overdue" ? (
              <article key={i.id} aria-label={`Overdue ${i.team.callsign}`} className="sl-slide-in flex flex-col gap-1.5 rounded-md border border-alert/40 border-l-2 border-l-alert bg-bg/40 p-2.5">
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

/** How many closed items show before "Show N more". */
export const CLOSED_SHOWN = 2;

/** What the find closed: one row, the first of what it closed under it, and "Show N more" for the rest. */
export function ClosedOnFind({ proposals, reviewCount, count, at }: { proposals: readonly Proposal[]; reviewCount: number; count: number; at: string | null }) {
  const [all, setAll] = useState(false);
  const head = count
    ? `${count} ${count === 1 ? "item" : "items"} closed${at ? ` at ${at}` : ""}, subject found`
    : `Subject found${at ? ` at ${at}` : ""}: nothing left to decide about the search`;
  const lines = proposals.length + (reviewCount > 0 ? 1 : 0);
  const shownProposals = all ? proposals : proposals.slice(0, CLOSED_SHOWN);
  const showReview = reviewCount > 0 && (all || proposals.length < CLOSED_SHOWN);
  return (
    <section role="group" aria-label="Closed: subject found" className="rounded-md border border-ok/40 border-l-2 border-l-ok bg-bg/40 text-small">
      <p className="flex min-h-9 items-center gap-2 px-2.5 py-2 text-text">
        <Icon name="found" className="shrink-0 text-ok" />
        <span className="flex-1">{head}</span>
      </p>
      {count > 0 && (
        <ul className="flex flex-col gap-1 border-t border-line px-2.5 py-2 text-caption text-text-2">
          {shownProposals.map((p) => (
            <li key={p.id} className="flex items-baseline gap-2">
              <span className="font-mono text-text-3">{p.id}</span>
              <span className="min-w-0 flex-1 truncate" title={p.summary}>
                {p.summary}
              </span>
              <span className="shrink-0 text-text-3">closed: subject found</span>
            </li>
          ))}
          {showReview && (
            <li className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1">
                {reviewCount} {reviewCount === 1 ? "candidate" : "candidates"} to review
              </span>
              <span className="shrink-0 text-text-3">closed: subject found</span>
            </li>
          )}
          {lines > CLOSED_SHOWN && (
            <li>
              <button type="button" onClick={() => setAll(!all)} className="sl-tap text-caption text-text-2 underline underline-offset-2 hover:text-text">
                {all ? "Show fewer" : `Show ${lines - Math.min(lines, CLOSED_SHOWN)} more`}
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/** A clue an image reviewer answered "Object" on (contract 15.7): a candidate until a team on the ground sees it. */
export const isClueCandidate = (c: Clue | null): boolean => c?.source === "review";

function ReadBack({ clue, turn, who, onConfirm, onReply }: { clue: Clue | null; turn: RadioTurn | null; who: string; onConfirm?: () => void; onReply?: () => void }) {
  const candidate = isClueCandidate(clue);
  return (
    <article aria-label={candidate ? "Clue candidate to confirm" : "Awaiting read-back"} className="sl-slide-in flex flex-col gap-1.5 rounded-md border border-caution/40 border-l-2 border-l-caution bg-bg/40 p-2.5">
      <span className="flex items-center gap-2 text-small font-medium text-text">
        <Icon name="clue" className="text-caution" />
        {clue ? `${candidate ? "Clue candidate to confirm" : "Clue to confirm"}: ${clue.text}` : `Read-back to ${who}`}
      </span>
      {turn?.reply && <span className="text-caption text-text-2">“{turn.reply}”</span>}
      {clue && candidate && <span className="text-caption text-text-3">From an image review, low reliability on the map. Send a team to look; Confirm once they have seen it.</span>}
      {clue && !candidate && <span className="text-caption text-text-3">{who ? `From ${who}. ` : ""}Read it back to the team to confirm it.</span>}
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
