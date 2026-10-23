// Needs you (COMMAND_POST.md §5, right column): decisions only, never news. The agent's proposals (one-line
// reason, A/X/E), detections waiting for review (the review cards live here now), teams past their
// check-in, clues awaiting read-back, and on a live mission with the radio, briefings to send. Each item is
// one way of acting; the console's direct actions (the map, the T-cards) are the other, and both go to the
// timeline. Built by lane A.
import type { ReactNode } from "react";
import type { Clue, Drone, MissionEvent, Proposal, RadioTurn, Team } from "../contract";
import { Icon } from "../shell/icons";
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

}) {
  const items = needs(proposals, teams, events, clues, now, checkInMin, reviewCount);
  const callsign = (id: string | null) => teams.find((t) => t.id === id)?.callsign ?? id ?? "";
  const pendingCount = items.filter((i) => i.kind === "proposal").length;
  const total = items.reduce((n, i) => n + (i.kind === "review" ? i.count : 1), 0);
  // phones: Needs you is its count, and expands on its tab (or a tap on the count)
  const open = useConsole((s) => s.tab === "needs");
  return (
    <section aria-label="Needs you" data-tour="needs" className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-surface-solid">
      <h2 className="sl-panel-head">
        Needs you
        <span className={`text-caption font-normal ${total ? "text-accent" : "text-text-3"}`}>{total ? `${total} waiting` : "nothing waiting"}</span>
        <button type="button" aria-expanded={open} onClick={() => useConsole.getState().setTab(open ? "map" : "needs")} className="sl-tap ml-auto text-caption font-normal text-text-2 lg:hidden">
          {open ? "Hide" : "Show"}
        </button>
      </h2>
      <div aria-label="Approvals rail" className={`min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2 ${open ? "flex" : "hidden lg:flex"}`}>
        {total === 0 && <p className="px-1 py-2 text-small text-text-3">Nothing needs you. Proposals, candidates to review, overdue teams and clues to read back appear here.</p>}
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
        {review}
      </div>
    </section>
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
