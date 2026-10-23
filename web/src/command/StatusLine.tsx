// The status line (COMMAND_POST.md §5): the header's second row, what a search manager reads first. How
// long the search has run, daylight left (a bar that shrinks), flyability as one word with its gate time
// (the reason on hover; the Conditions panel behind W), people out, found or not, clues. It replaces the
// old conditions row and the KPI sentence. Built by lane A.
import type { ReactNode } from "react";
import type { Clue, Conditions, Mission, Team } from "../contract";
import { DisclosureChip, KeyHint } from "../shell/components";
import { Icon } from "../shell/icons";
import type { Tz } from "../lib/time";
import { daylightMin, duration, elapsedMin, flyWord, peopleOut } from "./console";
import { isOverride } from "./conditions";
import { NotifyBell } from "../shell/notifyBell";
import { showMe } from "./showMe";

/** The day's light at the start of a search, for the bar's full width (8 h). */
const FULL_DAY_MIN = 8 * 60;

function Item({ label, children, title, tone }: { label: string; children: ReactNode; title?: string; tone?: "ok" | "alert" | "caution" | "accent" }) {
  const color = tone === "ok" ? "text-ok" : tone === "alert" ? "text-alert" : tone === "caution" ? "text-caution" : tone === "accent" ? "text-accent" : "text-text";
  return (
    <span className="flex shrink-0 items-baseline gap-1.5 whitespace-nowrap" title={title}>
      <span className="text-caption text-text-3">{label}</span>
      <span className={`text-small font-medium ${color}`}>{children}</span>
    </span>
  );
}

export function StatusLine({
  mission,
  conditions,
  teams,
  clues,
  now,
  tz,
  conditionsOpen,
  onConditions,
  conditionsId,
  menu,
  disclose = false,
  outside = null,
}: {
  /** The probability outside the search grid (console.outsideGrid), shown so the sectors' POA adds up. */
  outside?: number | null;
  /** Phones: the demo's disclosure chip lives here (the header has no room for it). */
  disclose?: boolean;
  mission: Mission | null;
  conditions: Conditions | null;
  teams: readonly Team[];
  clues: readonly Clue[];
  now: Date;
  tz: Tz;
  /** The Conditions panel (W): open, and its toggle; none: no panel on this console. */
  conditionsOpen?: boolean;
  onConditions?: () => void;
  conditionsId?: string;
  /** On the right: the scenario control on the demo. */
  menu?: ReactNode;
}) {
  const elapsed = elapsedMin(mission, now);
  const day = daylightMin(conditions, now);
  const fly = flyWord(conditions, tz);
  const out = peopleOut(teams);
  const found = mission?.status === "found";
  const unconfirmed = clues.filter((c) => !c.confirmed).length;
  return (
    <section role="status" aria-label="Mission status" className="flex h-9 items-center gap-x-5 overflow-x-auto border-t border-line px-3 lg:px-4 [scrollbar-width:none]">
      {/* the find leads the line: the first thing anyone should read, on a phone too */}
      {found && (
        <span data-tone="ok" className="sl-pill shrink-0" title={mission?.found ? `Found in ${mission.found.sector} by ${teams.find((t) => t.id === mission.found!.team)?.callsign ?? mission.found.team}` : undefined}>
          <Icon name="found" size={12} />
          Found{mission?.found ? ` · ${mission.found.sector}` : ""}
        </span>
      )}
      {disclose && (
        <span className="inline-flex shrink-0 md:hidden">
          <DisclosureChip />
        </span>
      )}
      <Item label="Elapsed" title={mission ? `Since the mission opened (${mission.created_at})` : undefined}>
        {elapsed === null ? "–" : duration(elapsed)}
      </Item>
      <span className="flex shrink-0 items-center gap-2" title="Daylight left: to the end of civil twilight">
        <Item label="Daylight" tone={day !== null && day < 60 ? "caution" : undefined}>
          {day === null ? "–" : day === 0 ? "after dark" : `${duration(day)} left`}
        </Item>
        {day !== null && (
          <span aria-hidden className="relative h-1 w-14 overflow-hidden rounded-full bg-surface-strong">
            <span className={`absolute inset-y-0 left-0 rounded-full ${day < 60 ? "bg-caution" : "bg-text-2"}`} style={{ width: `${Math.min(100, (day / FULL_DAY_MIN) * 100)}%` }} />
          </span>
        )}
      </span>
      {onConditions ? (
        <button
          type="button"
          onClick={onConditions}
          aria-expanded={conditionsOpen}
          aria-controls={conditionsId}
          title={`${fly.reason} (W: the Conditions panel, sources and quotes)`}
          data-tone={fly.tone}
          className="sl-pill sl-tap shrink-0 cursor-pointer hover:brightness-125"
        >
          <span aria-hidden className="sl-pill-dot" />
          {fly.word}
          <KeyHint>W</KeyHint>
        </button>
      ) : (
        <span data-tone={fly.tone} title={fly.reason} className="sl-pill shrink-0">
          <span aria-hidden className="sl-pill-dot" />
          {fly.word}
        </span>
      )}
      {isOverride(conditions) && (
        <span data-tone="caution" className="sl-pill shrink-0" title="Conditions set by hand for a demo (override (demo)), not from Tavily">
          Demo override
        </span>
      )}
      {conditions?.alerts.length ? (
        <span data-tone="caution" className="sl-pill shrink-0" title={conditions.alerts.map((a) => a.title).join("; ")}>
          {conditions.alerts.length === 1 ? conditions.alerts[0]!.title : `${conditions.alerts.length} alerts`}
        </span>
      ) : null}
      <Item label="Out" title={`${out.people} people in ${out.teams} ${out.teams === 1 ? "team" : "teams"} in the field`}>
        {out.people} {out.people === 1 ? "person" : "people"}
      </Item>
      {!found && <Item label="Subject">not found</Item>}
      {outside !== null && (
        <Item label="Outside the grid" title="The probability the subject is outside the 1 km search grid (the rest of the world). The sectors hold the rest; together they make 100 %.">
          {Math.round(outside * 100)} %
        </Item>
      )}
      <Item label="Clues" tone={unconfirmed ? "caution" : undefined} title={unconfirmed ? `${unconfirmed} awaiting read-back` : undefined}>
        {clues.length}
        {unconfirmed ? ` (${unconfirmed} to confirm)` : ""}
      </Item>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        <NotifyBell onShow={showMe} />
        {menu}
      </span>
    </section>
  );
}
