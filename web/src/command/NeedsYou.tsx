// Needs you (COMMAND_POST.md §5, right column): decisions only, never news, grouped by kind in the order a
// search manager should take them (most urgent first): a team reporting the subject, teams past their
// check-in, the agent's proposals (oldest first), clues awaiting read-back, a live radio's briefings to send,
// then the photos to review. Each group has a head in its kind's colour with its count; each item reads as
// one question ("Send Team One to C2?") and has one primary button that says the outcome ("Send Team One to
// C2"), the rest smaller. Each item is one way of acting; the console's direct actions (the map, the
// T-cards) are the other, and both go to the timeline. Once the subject is found the decisions about the
// search are moot: pending proposals and candidates fold into one closed row ("16 items closed at 15:00,
// subject found", expandable); overdue teams and read-backs stay, and so do the direct actions.
//
// Pointing at an item from outside (the guided search): `highlight` names a need id (a proposal's id,
// "overdue-<team>", "clue-<clue>", "turn-<turn>", "report-<team>", "review"); that item gets
// `data-highlighted` and a ring, the others `data-dimmed` (and out of reach until their step; a highlight that
// names no item, the guide's "none" between decisions, dims them all). Every item carries `data-need` (its id) and
// `data-need-kind`. Built by lane A.
import { useState, type ReactNode } from "react";
import type { Clue, Drone, MissionEvent, Proposal, RadioTurn, Team, TimelineEvent } from "../contract";
import { Icon, type IconName } from "../shell/icons";
import { useClock } from "../lib/time";
import { ApprovalInbox, type Decide } from "./ApprovalInbox";
import { needs, sightingReports } from "./console";

/** The kinds of thing that wait here, each with its colour token (shell/README.md) and its group's name. */
export const NEED_KINDS = {
  report: { label: "Subject reported", tone: "--found", icon: "found" },
  overdue: { label: "Teams not heard", tone: "--alert", icon: "team" },
  proposal: { label: "Agent proposals", tone: "--proposal", icon: "decision" },
  readback: { label: "Clues to confirm", tone: "--clue", icon: "clue" },
  review: { label: "Photos to review", tone: "--text-2", icon: "detection" },
} as const satisfies Record<string, { label: string; tone: string; icon: IconName }>;
export type NeedKind = keyof typeof NEED_KINDS;

/** A group's head: its kind's colour, its name, how many wait. */
export function NeedsHead({ kind, count, children }: { kind: NeedKind; count?: number; children?: ReactNode }) {
  const k = NEED_KINDS[kind];
  return (
    <h3 className="flex items-center gap-1.5 px-1 pt-1 text-caption font-medium text-text-2" style={{ ["--c" as string]: `var(${k.tone})` }}>
      <span aria-hidden className="size-2 shrink-0 rounded-full bg-[var(--c)]" />
      {k.label}
      {count !== undefined && <span className="sl-num font-normal text-text-3">{count}</span>}
      {children}
    </h3>
  );
}

/** The data attributes and classes that let the guided search point at one item and dim the rest. */
export function pointAt(id: string, kind: NeedKind, highlight: string | null | undefined): { attrs: Record<string, string | boolean | undefined>; className: string } {
  const on = !!highlight && highlight === id;
  const off = !!highlight && highlight !== id;
  return {
    attrs: { "data-need": id, "data-need-kind": kind, "data-highlighted": on ? "" : undefined, "data-dimmed": off ? "" : undefined, inert: off || undefined },
    // dimmed: out of reach too, so the one to act on is the one that can be acted on ("after this step")
    className: `transition-opacity ${on ? "outline-2 outline-offset-1 outline-[var(--c)]" : ""} ${off ? "pointer-events-none opacity-50" : ""}`,
  };
}

const primaryBtn =
  "sl-tap inline-flex h-9 items-center gap-2 rounded-full border border-[var(--c)] bg-[color-mix(in_srgb,var(--c)_16%,transparent)] px-4 text-small font-medium text-text hover:bg-[color-mix(in_srgb,var(--c)_26%,transparent)]";
const minorBtn = "sl-tap inline-flex h-7 items-center rounded-full px-2 text-caption text-text-2 hover:bg-surface hover:text-text";

/** One item: its question, a line of detail, one primary button that says the outcome, smaller ones after. */
function NeedItem({
  id,
  kind,
  label,
  ask,
  detail,
  quote,
  primary,
  minor = [],
  highlight,
}: {
  id: string;
  kind: NeedKind;
  label: string;
  ask: string;
  detail?: ReactNode;
  quote?: string | null;
  primary?: { label: string; onClick: () => void };
  minor?: { label: string; onClick: () => void }[];
  highlight?: string | null;
}) {
  const k = NEED_KINDS[kind];
  const point = pointAt(id, kind, highlight);
  return (
    <article
      aria-label={label}
      {...point.attrs}
      style={{ ["--c" as string]: `var(${k.tone})` }}
      className={`sl-slide-in flex flex-col gap-1.5 rounded-md border border-line border-l-[3px] border-l-[var(--c)] bg-bg/40 p-2.5 ${point.className}`}
    >
      <span className="flex items-start gap-2 text-body font-medium text-text">
        <Icon name={k.icon} className="mt-0.5 shrink-0 text-[var(--c)]" />
        <span className="min-w-0">{ask}</span>
      </span>
      {quote && <span className="text-caption text-text-2">“{quote}”</span>}
      {detail && <span className="text-caption text-text-3">{detail}</span>}
      {(primary || minor.length > 0) && (
        <span className="flex flex-wrap items-center gap-1.5">
          {primary && (
            <button type="button" data-primary="" className={primaryBtn} onClick={primary.onClick}>
              {primary.label}
            </button>
          )}
          {minor.map((m) => (
            <button key={m.label} type="button" className={minorBtn} onClick={m.onClick}>
              {m.label}
            </button>
          ))}
        </span>
      )}
    </article>
  );
}

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
  highlight = null,
  timeline = [],
}: {
  /** The server's timeline: a team's report of the subject there offers Record find too. */
  timeline?: readonly TimelineEvent[];
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
  /** The item to point at (a need id, see above): ringed, the others dimmed. Null: none. */
  highlight?: string | null;
}) {
  const items = needs(proposals, teams, events, clues, now, checkInMin, reviewCount);
  // a team reported the subject on the radio: record the find from here (no need to find the sector's popover)
  const reports = !found && onFound ? sightingReports(events, teams, tasks, timeline) : [];
  const { time } = useClock();
  const callsign = (id: string | null) => teams.find((t) => t.id === id)?.callsign ?? id ?? "";
  const closedProposals = found ? proposals.filter((p) => p.status === "pending") : [];
  const closedReview = found ? reviewCount : 0;
  const closedCount = closedProposals.length + closedReview;
  const pendingCount = found ? 0 : items.filter((i) => i.kind === "proposal").length;
  const overdue = items.flatMap((i) => (i.kind === "overdue" ? [i] : []));
  const readbacks = items.flatMap((i) => (i.kind === "readback" ? [i] : []));
  const total = reports.length + items.reduce((n, i) => n + (found && (i.kind === "proposal" || i.kind === "review") ? 0 : i.kind === "review" ? i.count : 1), 0);

  return (
    <section aria-label="Needs you" data-tour="needs" className="flex min-h-0 flex-col overflow-hidden lg:flex-1 rounded-lg border border-line bg-surface-solid">
      <h2 className="sl-panel-head">
        Needs you
        <span className={`text-caption font-normal ${total ? "text-accent" : found ? "text-ok" : "text-text-3"}`}>{total ? `${total} waiting` : found ? "subject found" : "nothing waiting"}</span>
        {total > 1 && <span className="ml-auto text-caption font-normal text-text-3">most urgent first</span>}
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
        {reports.length > 0 && <NeedsHead kind="report" count={reports.length} />}
        {reports.map((r) => (
          <NeedItem
            key={r.team.id}
            id={`report-${r.team.id}`}
            kind="report"
            label={`${r.team.callsign} reports the subject`}
            ask={`${r.team.callsign} reports the subject${r.sector ? ` in ${r.sector}` : ""}`}
            quote={r.words}
            primary={r.sector ? { label: `Record find in ${r.sector}`, onClick: () => onFound?.(r.team.id, r.sector!) } : undefined}
            minor={[{ label: "Reply", onClick: () => onCall(r.team.id, `${r.team.callsign}, Sightline. Copy, stay with the subject, over.`) }]}
            highlight={highlight}
          />
        ))}
        {overdue.length > 0 && <NeedsHead kind="overdue" count={overdue.length} />}
        {overdue.map((i) => (
          <NeedItem
            key={i.id}
            id={i.id}
            kind="overdue"
            label={`Overdue ${i.team.callsign}`}
            ask={`${i.team.callsign} not heard ${i.min === null ? "yet" : `for ${Math.round(i.min)} min`}`}
            detail={`Past the ${checkInMin}-minute check-in. Call for a radio check, or recall them to base camp.`}
            primary={{ label: `Call ${i.team.callsign}`, onClick: () => onCall(i.team.id, `${i.team.callsign}, Sightline. Radio check, over.`) }}
            minor={[{ label: "Recall", onClick: () => onRecall(i.team.id) }]}
            highlight={highlight}
          />
        ))}
        {pendingCount > 0 && (
          <>
            <NeedsHead kind="proposal" count={pendingCount}>
              <span className="font-normal text-text-3">· oldest first</span>
            </NeedsHead>
            <ApprovalInbox proposals={proposals} teams={teams} drones={drones} onDecide={onDecide} imageUrl={imageUrl} clueNote={clueNote} story={storyProposal} feedHref={undefined} order="oldest" highlight={highlight} />
          </>
        )}
        {readbacks.length > 0 && <NeedsHead kind="readback" count={readbacks.length} />}
        {readbacks.map((i) => (
          <ReadBack key={i.id} id={i.id} clue={i.clue} turn={i.turn} who={callsign(i.team)} onConfirm={i.clue ? () => onConfirmClue(i.clue!.id) : undefined} onReply={i.team ? () => onCall(i.team!, `${callsign(i.team)}, Sightline. `) : undefined} highlight={highlight} />
        ))}
        {briefings}
        {/* the review cards stay mounted (their keys J/K/P/N/U) while there are any; answered ones fold away */}
        {!found && review && (
          <div role="group" aria-label="Photos to review" style={{ ["--c" as string]: `var(${NEED_KINDS.review.tone})` }} {...pointAt("review", "review", highlight).attrs} className={pointAt("review", "review", highlight).className}>
            {review}
          </div>
        )}
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

function ReadBack({ id, clue, turn, who, onConfirm, onReply, highlight }: { id: string; clue: Clue | null; turn: RadioTurn | null; who: string; onConfirm?: () => void; onReply?: () => void; highlight?: string | null }) {
  const candidate = isClueCandidate(clue);
  const minor = [...(onReply ? [{ label: "Reply", onClick: onReply }] : [])];
  return (
    <NeedItem
      id={id}
      kind="readback"
      label={candidate ? "Clue candidate to confirm" : "Awaiting read-back"}
      ask={clue ? `${candidate ? "Clue candidate to confirm" : "Clue to confirm"}: ${clue.text}` : `Read-back to ${who}`}
      quote={turn?.reply ?? null}
      detail={
        clue
          ? candidate
            ? "From an image review, low reliability on the map. Send a team to look; Confirm once they have seen it."
            : `${who ? `From ${who}. ` : ""}Read it back to the team to confirm it.`
          : undefined
      }
      primary={onConfirm ? { label: "Confirm clue", onClick: onConfirm } : onReply ? { label: `Reply to ${who}`, onClick: onReply } : undefined}
      minor={onConfirm ? minor : []}
      highlight={highlight}
    />
  );
}
