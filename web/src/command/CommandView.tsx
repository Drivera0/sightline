// The command view (LANE_E §7): the search manager's screen. Mission header with conditions, the task
// board (sectors through proposed → assigned → in progress → searched at a POD), the team roster, the
// approval inbox, the clue log. Built by lane A for lane E (issue #70); lane B's map goes in the middle
// once it reads live missions.

import { useSelection } from "../lib/selection";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { Clue, ClueDraft, Conditions, Mission, Proposal, SectorTask, Team } from "../contract";
import type { SectorNow } from "../lib/api";
import { ModeChip, modeOf, Panel, StatusPill, type Tone } from "../shell/components";
import { ApprovalInbox, type Decide } from "./ApprovalInbox";

type TaskBody = { state: SectorTask["state"]; team_id?: string | null; pod?: number | null; note?: string | null };

export interface CommandProps {
  mission: Mission | null;
  status: string;
  conditions: Conditions | null;
  tasks: readonly SectorTask[];
  sectors: readonly SectorNow[];
  teams: readonly Team[];
  clues: readonly Clue[];
  proposals: readonly Proposal[];
  imageUrl: (rel: string) => string;
  onSetTask: (sector: string, body: TaskBody) => void | Promise<void>;
  onUpdateTeam: (teamId: string, patch: Partial<Team>) => void | Promise<void>;
  onAddClue: (draft: ClueDraft) => void | Promise<void>;
  onDecide: Decide;
  /** Pick the clue's position on the live map (B-M3); null when cancelled. Without it, type lat/lon. */
  onPickOnMap?: () => Promise<{ lat: number; lon: number } | null>;
  /** Where a sector's assignment card opens (E-09); without it, no Card links. */
  cardHref?: (sectorId: string) => string;
  /** Under the approval inbox (D-R3: the radio desk, so an approved briefing's Transmit is right there). */
  sideRail?: ReactNode;
  /** The live map: with it, the view is the full-screen console of LANE_E §7.1 (map in the middle). */
  map?: ReactNode;
  /** Between the status line and the map (the console only): the demo's pre-seeded note, the first-visit hint. */
  aboveMap?: ReactNode;
  now?: () => Date;
}

const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
/** HH:MM; the demo mission tells its scripted timeline in UTC (its fixtures are dated in UTC). */
const hhmm = (d: Date, utc = false) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(utc ? { timeZone: "UTC" } : {}) });
const minutesSince = (iso: string, now: Date) => Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60000));

export function CommandView(p: CommandProps) {
  const now = p.now ?? (() => new Date());
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000); // the clock and the ages
    return () => clearInterval(id);
  }, []);
  if (p.map) {
    // LANE_E §7.1: header across the top; task board and teams | map | approvals and radio; clue log along the bottom.
    // Each rail scrolls on its own so the map never leaves the screen.
    return (
      <div
        aria-label="Command view"
        className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(17rem,20rem)_minmax(0,1fr)_minmax(20rem,24rem)] lg:grid-rows-[auto_minmax(0,1fr)_auto]"
      >
        <div className="flex flex-col gap-2 lg:col-span-3">
          <p className="rounded-sm border border-line bg-surface-solid px-3 py-2 text-caption text-text-2 lg:hidden">
            <span className="font-medium text-text">Desktop recommended.</span> The console is laid out for a screen 1024 px or wider; here
            its panels stack: map, sectors and teams, approvals, clues.
          </p>
          <MissionHeader heading mission={p.mission} status={p.status} conditions={p.conditions} now={now()} />
        </div>
        <aside aria-label="Sectors and teams" className="order-2 flex min-h-0 flex-col gap-4 overflow-y-auto pr-1 lg:order-none">
          <TaskBoard compact tasks={p.tasks} sectors={p.sectors} teams={p.teams} onSetTask={p.onSetTask} onUpdateTeam={p.onUpdateTeam} now={now()} cardHref={p.cardHref} />
          <TeamRoster teams={p.teams} tasks={p.tasks} now={now()} />
        </aside>
        <div className="order-1 flex min-h-0 flex-col gap-2 lg:order-none">
          <StatusLine proposals={p.proposals} teams={p.teams} tasks={p.tasks} clues={p.clues} />
          <ConsoleHint />
          {p.aboveMap}
          <div className="h-[60vh] min-h-0 lg:h-auto lg:flex-1">{p.map}</div>
        </div>
        <aside aria-label="Approvals" className="order-3 flex min-h-0 flex-col gap-4 overflow-y-auto pr-1 lg:order-none">
          <ApprovalInbox proposals={p.proposals} teams={p.teams} onDecide={p.onDecide} imageUrl={p.imageUrl} />
          {p.sideRail}
        </aside>
        <div className="order-4 max-h-40 overflow-y-auto rounded-lg border border-line bg-surface-solid px-4 py-2.5 lg:order-none lg:col-span-3">
          <ClueLog clues={p.clues} teams={p.teams} onAddClue={p.onAddClue} onPickOnMap={p.onPickOnMap} utc={p.status === "demo"} />
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4" aria-label="Command view">
      <MissionHeader mission={p.mission} status={p.status} conditions={p.conditions} now={now()} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="flex flex-col gap-4">
          <TaskBoard tasks={p.tasks} sectors={p.sectors} teams={p.teams} onSetTask={p.onSetTask} onUpdateTeam={p.onUpdateTeam} now={now()} cardHref={p.cardHref} />
          <TeamRoster teams={p.teams} tasks={p.tasks} now={now()} />
        </div>
        <div className="flex flex-col gap-4">
          <ApprovalInbox proposals={p.proposals} teams={p.teams} onDecide={p.onDecide} imageUrl={p.imageUrl} />
          {p.sideRail}
        </div>
      </div>
      <ClueLog clues={p.clues} teams={p.teams} onAddClue={p.onAddClue} onPickOnMap={p.onPickOnMap} utc={p.status === "demo"} />
    </div>
  );
}

export function MissionHeader({ mission, status, conditions: c, now, heading = false }: { mission: Mission | null; status: string; conditions: Conditions | null; now: Date; heading?: boolean }) {
  const utc = status === "demo"; // the demo's scripted timeline, as its fixtures are dated
  const bits: string[] = [];
  if (c) {
    if (c.wind_kmh !== null) bits.push(`wind ${c.wind_kmh.toFixed(0)} km/h${c.gust_kmh !== null ? `, gusts ${c.gust_kmh.toFixed(0)}` : ""}`);
    if (c.precip_mm_h) bits.push(`rain ${c.precip_mm_h.toFixed(1)} mm/h`);
    if (c.flyability_reason.startsWith("before dawn")) bits.push("before dawn");
    else if (c.civil_twilight_end) {
      const left = (new Date(c.civil_twilight_end).getTime() - now.getTime()) / 60000;
      bits.push(left > 0 ? `daylight ${Math.floor(left / 60)} h ${Math.round(left % 60)} m` : "after dark");
    }
    bits.push(c.flyable === true ? `flyable until ~${c.flyable_until ? hhmm(new Date(c.flyable_until), utc) : "dusk"}` : c.flyable === false ? `not flyable: ${c.flyability_reason}` : "flyability unknown");  // prettier-ignore
    // lane B's planning heuristics, labelled as such (B-W2): they move the map, they don't measure anything
    if (c.visibility_factor < 1) bits.push(`visibility ×${c.visibility_factor.toFixed(1)} (heuristic)`);
    if (c.exposure_band) bits.push(`exposure ${c.exposure_band} (planning heuristic)`);
  }
  const old = c ? minutesSince(c.fetched_at, now) > 60 : false;
  const fly: [Tone, string] = !c || c.flyable === null ? ["muted", "Flyability unknown"] : c.flyable ? ["ok", "Flyable"] : ["alert", "Not flyable"];
  const words = `${c ? bits.join(" · ") : "not yet fetched"}${c && c.alerts.length ? ` · ${c.alerts.map((a) => a.title).join("; ")}` : ""}${old ? ` · as of ${hhmm(new Date(c!.fetched_at), utc)}` : ""}`;
  const Name = heading ? "h1" : "span";
  // One row (LANE_E §7.1, compressed): name, where the data comes from, the clock, flyability, then the
  // conditions in words (cut with an ellipsis; the whole line is the tooltip).
  return (
    <section className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface-solid px-3 py-2 lg:flex-nowrap" aria-label="Mission header">
      <Name className="truncate text-body font-medium text-text">{mission?.name ?? "…"}</Name>
      <ModeChip mode={modeOf(status)} />
      <span className="font-mono text-small text-text-2" title="Mission clock">
        {hhmm(now, utc)}
        {utc && " UTC"}
      </span>
      <StatusPill tone={fly[0]}>{fly[1]}</StatusPill>
      {c && c.alerts.length > 0 && <StatusPill tone="caution">{c.alerts.length === 1 ? "1 alert" : `${c.alerts.length} alerts`}</StatusPill>}
      <p className="min-w-0 flex-1 text-small text-text-2 lg:truncate" title={`Conditions: ${words}`}>
        <span className="text-text-3">Conditions: </span>
        {c ? bits.join(" · ") : "not yet fetched"}
        {c && c.alerts.length > 0 && <span className="text-caution"> · {c.alerts.map((a) => a.title).join("; ")}</span>}
        {old && <span className="text-caution"> · as of {hhmm(new Date(c!.fetched_at), utc)}</span>}
      </p>
    </section>
  );
}

export const HINT_KEY = "sightline.consoleHint";

function hintSeen(): boolean {
  try {
    return globalThis.localStorage?.getItem(HINT_KEY) === "seen";
  } catch {
    return false;
  }
}

/** The console's first-visit hint: where things are, in three bullets. Dismissed once, per browser. */
export function ConsoleHint() {
  const [shown, setShown] = useState(() => !hintSeen());
  if (!shown) return null;
  const dismiss = () => {
    setShown(false);
    try {
      globalThis.localStorage?.setItem(HINT_KEY, "seen");
    } catch {
      /* private mode: hidden for this page only */
    }
  };
  return (
    <aside aria-label="How to use the console" className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-sm border border-line bg-surface-solid px-3 py-1.5 text-caption text-text-2">
      <span className="font-medium text-text">First time here?</span>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        <li>
          <span className="text-accent">→</span> Approve the agent's proposals on the right
        </li>
        <li>
          <span className="text-accent">←</span> Assign teams to sectors on the left
        </li>
        <li>
          <span className="text-accent">↓</span> Add clues below the map
        </li>
      </ul>
      <button type="button" onClick={dismiss} className="ml-auto rounded-full border border-border px-2.5 py-0.5 text-text-2 hover:text-text">
        Got it
      </button>
    </aside>
  );
}

const OUT: readonly Team["status"][] = ["assigned", "searching", "returning"];
const DRONE_KINDS: readonly Proposal["kind"][] = ["drone_leg", "retask_drone"];

/** The status line above the map (one sentence before the detail): what needs a person, what is moving. */
export function missionStatus(proposals: readonly Proposal[], teams: readonly Team[], tasks: readonly SectorTask[], clues: readonly Clue[]): { tone: Tone; text: string }[] {
  const pending = proposals.filter((x) => x.status === "pending");
  const legs = pending.filter((x) => DRONE_KINDS.includes(x.kind)).length;
  const out = teams.filter((t) => OUT.includes(t.status)).length;
  const searching = tasks.filter((t) => t.state === "in_progress").length;
  const searched = tasks.filter((t) => t.state === "searched").length;
  const open = clues.filter((c) => !c.confirmed).length;
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  return [
    pending.length ? { tone: "action", text: `${plural(pending.length, "approval")} waiting` } : { tone: "muted", text: "no approvals waiting" },
    legs ? { tone: "action", text: legs === 1 ? "next drone leg ready" : `${legs} drone legs ready` } : { tone: "muted", text: "no drone leg waiting" },
    { tone: out ? "ok" : "muted", text: `${plural(out, "team")} out` },
    { tone: searching ? "ok" : "muted", text: `${plural(searching, "sector")} in progress` },
    { tone: "neutral", text: `${searched} searched` },
    { tone: open ? "caution" : "muted", text: `${plural(clues.length, "clue")}${open ? ` (${open} unconfirmed)` : ""}` },
  ];
}

export function StatusLine({ proposals, teams, tasks, clues }: { proposals: readonly Proposal[]; teams: readonly Team[]; tasks: readonly SectorTask[]; clues: readonly Clue[] }) {
  const items = missionStatus(proposals, teams, tasks, clues);
  return (
    <p role="status" aria-label="Mission status" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-text-2">
      {items.map((it, i) => (
        <span key={it.text} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden className="text-text-3">·</span>}
          <span data-tone={it.tone} className={it.tone === "action" ? "font-medium text-accent" : it.tone === "muted" ? "text-text-3" : "text-text-2"}>
            {it.tone !== "muted" && it.tone !== "neutral" && <span aria-hidden className="sl-pill-dot mr-1.5 inline-block align-middle" />}
            {it.text}
          </span>
        </span>
      ))}
    </p>
  );
}

const COLUMNS: { state: SectorTask["state"]; label: string }[] = [
  { state: "proposed", label: "Proposed" },
  { state: "assigned", label: "Assigned" },
  { state: "in_progress", label: "In progress" },
  { state: "searched", label: "Searched" },
];
const PROPOSED_SHOWN = 5;
const POD_TIP =
  "POD is the team's estimate of how likely they'd have found the person if they were there. It lowers the sector's probability; it never removes it.";

export function TaskBoard({
  tasks,
  sectors,
  teams,
  onSetTask,
  onUpdateTeam,
  now,
  cardHref,
  compact = false,
}: {
  tasks: readonly SectorTask[];
  sectors: readonly SectorNow[];
  teams: readonly Team[];
  onSetTask: CommandProps["onSetTask"];
  onUpdateTeam: CommandProps["onUpdateTeam"];
  now: Date;
  cardHref?: CommandProps["cardHref"];
  /** One column of states (the console's left rail) instead of four side by side. */
  compact?: boolean;
}) {
  const [allProposed, setAllProposed] = useState(false);
  const live = new Map(sectors.map((s) => [s.sector_id, s]));
  const callsign = (id: string | null) => teams.find((t) => t.id === id)?.callsign ?? id ?? "";
  const poa = (t: SectorTask) => live.get(t.sector_id)?.poa ?? t.poa;
  return (
    <section aria-label="Task board" className="flex flex-col gap-2">
      <span className="px-1 text-caption font-medium text-text-2">Task board</span>
      <div className={compact ? "flex flex-col gap-3" : "grid gap-3 md:grid-cols-4"}>
        {COLUMNS.map((col) => {
          const all = tasks.filter((t) => t.state === col.state).sort((a, b) => poa(b) - poa(a));
          // The unassigned sectors: the most likely few; the rest on request (16 cards bury the board).
          const cut = col.state === "proposed" && !allProposed ? PROPOSED_SHOWN : all.length;
          const cards = all.slice(0, cut);
          return (
            <div key={col.state} className="flex flex-col gap-1" aria-label={col.label}>
              <span className="flex items-baseline justify-between px-1 text-caption text-text-3">
                <span className="font-medium text-text-2">{col.label} ({all.length})</span>
                {col.state === "proposed" && all.length > 0 && <span title="Probability of area: how likely the person is in the sector, on the live map">POA</span>}
              </span>
              <div className="flex flex-col divide-y divide-line overflow-hidden rounded-sm border border-line bg-surface-solid empty:hidden">
                {cards.map((t) => (
                  <TaskCard key={t.sector_id} t={t} label={live.get(t.sector_id)?.label ?? t.sector_id} poa={poa(t)} coverage={live.get(t.sector_id)?.drone_coverage} teams={teams} callsign={callsign} onSetTask={onSetTask} onUpdateTeam={onUpdateTeam} now={now} cardHref={cardHref} />  // prettier-ignore
                ))}
              </div>
              {all.length > cards.length && (
                <button type="button" className="self-start px-1 text-caption text-text-2 underline-offset-2 hover:underline" onClick={() => setAllProposed(true)}>
                  Show {all.length - cards.length} more
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TaskCard({
  t,
  label,
  poa,
  coverage,
  teams,
  callsign,
  onSetTask,
  onUpdateTeam,
  now,
  cardHref,
}: {
  t: SectorTask;
  label: string;
  poa: number;
  coverage: number | undefined;
  teams: readonly Team[];
  callsign: (id: string | null) => string;
  onSetTask: CommandProps["onSetTask"];
  onUpdateTeam: CommandProps["onUpdateTeam"];
  now: Date;
  cardHref?: CommandProps["cardHref"];
}) {
  const [picking, setPicking] = useState(false);
  const [podOpen, setPodOpen] = useState(false);
  const [pod, setPod] = useState(0.5);
  const [note, setNote] = useState("");
  const standby = teams.filter((x) => x.status === "standby");
  const assign = async (teamId: string) => {
    setPicking(false);
    await onSetTask(t.sector_id, { state: "assigned", team_id: teamId });
    await onUpdateTeam(teamId, { status: "assigned" });
  };
  const searched = async (value: number) => {
    setPodOpen(false);
    await onSetTask(t.sector_id, { state: "searched", team_id: t.team_id, pod: value, note: note.trim() || null });
    if (t.team_id) await onUpdateTeam(t.team_id, { status: "standby" });
  };
  const [open, setOpen] = useState(false);
  const mins = minutesSince(t.updated_at, now);
  const podPct = Math.round((t.pod ?? 0) * 100);
  const status =
    t.state === "assigned"
      ? `Assigned to ${callsign(t.team_id)}`
      : t.state === "in_progress"
        ? `In progress · ${callsign(t.team_id)} · ${mins} min`
        : t.state === "searched"
          ? `Searched at POD ${podPct}%`
          : "Proposed";
  // one line: sector · label · POA · state · team; the sentence is for screen readers and the tooltip
  const pill: [Tone, string] =
    t.state === "in_progress" ? ["ok", `Searching ${mins}m`] : t.state === "assigned" ? ["neutral", "Assigned"] : t.state === "searched" ? ["muted", `POD ${podPct}%`] : ["muted", "Proposed"];
  const sentence = `${status}${coverage !== undefined ? ` · drone coverage ${pct(coverage)}` : ""}`;
  const quiet = "rounded-full border border-line bg-surface-strong px-2 py-0.5 text-caption text-text-2 hover:border-border hover:text-text";
  const actions = (
    <>
      {t.state === "proposed" && !picking && (
        <button type="button" className={quiet} onClick={() => setPicking(true)} disabled={standby.length === 0} title={standby.length === 0 ? "No team on standby" : undefined}>
          Assign team…
        </button>
      )}
      {t.state === "assigned" && (
        <>
          <button type="button" className={quiet} onClick={() => { void onSetTask(t.sector_id, { state: "in_progress", team_id: t.team_id }); if (t.team_id) void onUpdateTeam(t.team_id, { status: "searching" }); }}>  {/* prettier-ignore */}
            Start
          </button>
          <button type="button" className={quiet} onClick={() => { void onSetTask(t.sector_id, { state: "proposed", team_id: null }); if (t.team_id) void onUpdateTeam(t.team_id, { status: "standby" }); }}>  {/* prettier-ignore */}
            Unassign
          </button>
        </>
      )}
      {cardHref && (t.state === "assigned" || t.state === "in_progress") && (
        <a className={quiet} href={cardHref(t.sector_id)}>
          Card
        </a>
      )}
      {t.state === "in_progress" && !podOpen && (
        <button type="button" className={quiet} onClick={() => setPodOpen(true)}>
          Mark searched…
        </button>
      )}
      {t.state === "searched" && (
        <button type="button" className={quiet} onClick={() => void onSetTask(t.sector_id, { state: "proposed", team_id: null })}>
          Reopen
        </button>
      )}
    </>
  );
  return (
    <div role="group" aria-label={`Sector ${t.sector_id}`} title={sentence} className="group relative flex flex-col text-small hover:bg-surface">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-w-0 items-center gap-2 px-2.5 py-1.5 text-left">
        <span aria-hidden className="w-7 shrink-0 font-mono text-text">
          {t.sector_id}
        </span>
        <span className="min-w-0 flex-1 truncate text-caption text-text-3">{label}</span>
        <span aria-hidden className="w-11 shrink-0 text-right font-mono text-caption text-text-2">
          {pct(poa)}
        </span>
        <StatusPill tone={pill[0]} dot={t.state === "in_progress"} className="hidden sm:inline-flex">
          {pill[1]}
        </StatusPill>
        {t.team_id && <span className="w-16 shrink-0 truncate text-caption text-text-2">{callsign(t.team_id)}</span>}
        <span className="sr-only">
          Sector {t.sector_id}: {sentence}
        </span>
      </button>
      {/* actions on hover or keyboard focus, laid over the right end of the row; always shown on touch screens */}
      <div className="absolute top-0 right-0 flex h-8 items-center gap-1 bg-surface-solid pr-2 pl-3 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:static [@media(hover:none)]:px-2.5 [@media(hover:none)]:pb-2 [@media(hover:none)]:opacity-100 empty:hidden">
        {actions}
      </div>
      {(open || picking || podOpen) && (
        <div className="flex flex-col gap-1.5 px-2.5 pt-0.5 pb-2.5 text-caption text-text-2">
          {open && (
            <>
              <span className="text-text">{status}</span>
              <span className="text-text-3">
                {label} · POA {pct(poa)}
                {coverage !== undefined && ` · drone coverage ${pct(coverage)}`}
              </span>
              {t.note && <span className="text-text-3">“{t.note}”</span>}
            </>
          )}
          {picking && (
            <div className="flex flex-wrap items-center gap-1.5" aria-label="Pick a team">
              <span className="text-text-3">Team on standby:</span>
              {standby.map((x) => (
                <button key={x.id} type="button" className={quiet} onClick={() => void assign(x.id)}>
                  {x.callsign}
                </button>
              ))}
              <button type="button" className="text-text-3 underline" onClick={() => setPicking(false)}>
                Cancel
              </button>
            </div>
          )}
          {podOpen && (
            <div className="flex flex-col gap-1.5" aria-label="POD entry" title={POD_TIP}>
              <span className="text-text-3">{POD_TIP}</span>
              <div className="flex gap-1.5">
                {[
                  ["Low 30%", 0.3],
                  ["Medium 50%", 0.5],
                  ["High 70%", 0.7],
                ].map(([name, v]) => (
                  <button key={name} type="button" className={quiet} onClick={() => void searched(v as number)}>
                    {name}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-2">
                POD
                <input type="range" className="sl-range flex-1" style={{ ["--sl-range-fill" as string]: `${((pod - 0.05) / 0.85) * 100}%` }} min={0.05} max={0.9} step={0.05} value={pod} onChange={(e) => setPod(Number(e.target.value))} aria-label="POD" />
                <span className="w-9 text-right font-mono">{Math.round(pod * 100)}%</span>
              </label>
              <input className="rounded-sm border border-line bg-surface-strong px-2 py-1 text-caption text-text" placeholder="One line (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
              <div className="flex gap-1.5">
                <button type="button" className="rounded-full border border-accent bg-accent/15 px-2.5 py-0.5 text-caption text-text" onClick={() => void searched(pod)}>
                  Searched at {Math.round(pod * 100)}%
                </button>
                <button type="button" className="text-text-3 underline" onClick={() => setPodOpen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const STATUS_WORDS: Record<Team["status"], string> = {
  standby: "Standby",
  assigned: "Assigned",
  searching: "Searching",
  returning: "Returning",
  off_duty: "Off duty",
};

const TEAM_TONE: Record<Team["status"], Tone> = { standby: "muted", assigned: "neutral", searching: "ok", returning: "caution", off_duty: "muted" };

export function TeamRoster({ teams, tasks, now }: { teams: readonly Team[]; tasks: readonly SectorTask[]; now: Date }) {
  const selected = useSelection((s) => s.selectedTeamId);
  return (
    <section aria-label="Teams" className="flex flex-col gap-1">
      <span className="px-1 text-caption font-medium text-text-2">Teams ({teams.length})</span>
      <div className="flex flex-col divide-y divide-line overflow-hidden rounded-sm border border-line bg-surface-solid">
        {teams.map((t) => {
          const sector = tasks.find((x) => x.team_id === t.id && (x.state === "assigned" || x.state === "in_progress"));
          const pos = t.position_at ? `position ${minutesSince(t.position_at, now)} min ago` : "no position";
          return (
            <div key={t.id} title={`${t.members} people · ${pos}`} className={`flex items-center gap-2 px-2.5 py-1.5 text-small ${selected === t.id ? "bg-accent/10" : ""}`}>
              {/* selecting a team flies the live map to it (D-M2), when it has a position */}
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-text underline-offset-2 hover:underline"
                aria-pressed={selected === t.id}
                title={t.position ? "Show on the map" : "No position yet"}
                onClick={() => useSelection.getState().selectTeam(selected === t.id ? null : t.id)}
              >
                {t.callsign}
              </button>
              {sector && <span className="font-mono text-caption text-text-2">{sector.sector_id}</span>}
              <span className="w-14 text-right text-caption text-text-3">{t.position_at ? `${minutesSince(t.position_at, now)}m ago` : "no pos"}</span>
              <StatusPill tone={TEAM_TONE[t.status]} dot={t.status === "searching" || t.status === "returning"}>
                {STATUS_WORDS[t.status]}
              </StatusPill>
            </div>
          );
        })}
      </div>
    </section>
  );
}

const KINDS: ClueDraft["kind"][] = ["object", "track", "sighting", "sound", "other"];

/** What's wrong with a clue before it's sent (LANE_E §9 test 5), or null. */
export function clueProblem(text: string, where: "team" | "latlon", lat: string, lon: string, radius: string): string | null {
  if (!text.trim()) return "Say what was found.";
  if (where === "latlon") {
    const [a, o] = [Number(lat), Number(lon)];
    if (lat.trim() === "" || !Number.isFinite(a) || a < -90 || a > 90) return "Latitude must be a number from -90 to 90.";
    if (lon.trim() === "" || !Number.isFinite(o) || o < -180 || o > 180) return "Longitude must be a number from -180 to 180.";
  }
  if (radius.trim() !== "" && !(Number(radius) > 0)) return "The radius must be more than 0 m (or empty for the default).";
  return null;
}

export function ClueLog({
  clues,
  teams,
  onAddClue,
  onPickOnMap,
  utc = false,
}: {
  clues: readonly Clue[];
  teams: readonly Team[];
  onAddClue: CommandProps["onAddClue"];
  onPickOnMap?: CommandProps["onPickOnMap"];
  /** Times in UTC (the demo mission's scripted timeline). */
  utc?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ClueDraft["kind"]>("object");
  const [text, setText] = useState("");
  const [where, setWhere] = useState<"team" | "latlon">("team");
  const [team, setTeam] = useState(teams[0]?.id ?? "");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [reliability, setReliability] = useState<ClueDraft["reliability"]>("medium");
  const [radius, setRadius] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const field = "rounded-sm border border-border bg-surface-strong px-2 py-1 text-small text-text";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const why = clueProblem(text, where, lat, lon, radius);
    setProblem(why);
    if (why) return;
    const draft: ClueDraft = {
      kind,
      text: text.trim(),
      lat: where === "latlon" ? Number(lat) : null,
      lon: where === "latlon" ? Number(lon) : null,
      at_team_position: where === "team",
      radius_m: radius.trim() ? Number(radius) : null,
      reliability,
      reported_by: where === "team" ? team : "command",
      source: "form",
      confirmed_by_turn: null,
    };
    try {
      await onAddClue(draft);
      setText("");
      setOpen(false);
    } catch {
      /* the page shows the error */
    }
  };
  const newest = [...clues].sort((a, b) => b.at.localeCompare(a.at));
  const callsign = (id: string) => teams.find((t) => t.id === id)?.callsign ?? (id === "command" ? "command" : id);
  return (
    <section aria-label="Clue log" className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="text-caption font-medium text-text-2">Clue log ({clues.length})</span>
        <button type="button" aria-expanded={open} className="rounded-full border border-border px-3 py-0.5 text-caption text-text-2 hover:text-text" onClick={() => setOpen(!open)}>
          + Add clue
        </button>
      </div>
      {open && (
        <Panel className="p-3">
          <form onSubmit={submit} className="flex flex-wrap items-end gap-2" aria-label="Add clue">
            <select aria-label="Kind" className={field} value={kind} onChange={(e) => setKind(e.target.value as ClueDraft["kind"])}>
              {KINDS.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
            <input aria-label="What" className={`${field} min-w-48 flex-1`} placeholder="blue backpack by the creek" value={text} onChange={(e) => setText(e.target.value)} />
            <select aria-label="Where" className={field} value={where} onChange={(e) => setWhere(e.target.value as "team" | "latlon")}>
              <option value="team">at a team's position</option>
              <option value="latlon">at lat/lon</option>
            </select>
            {where === "team" ? (
              <select aria-label="Team" className={field} value={team} onChange={(e) => setTeam(e.target.value)}>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.callsign}
                  </option>
                ))}
              </select>
            ) : (
              <>
                <input aria-label="Latitude" className={`${field} w-28`} value={lat} onChange={(e) => setLat(e.target.value)} />
                <input aria-label="Longitude" className={`${field} w-28`} value={lon} onChange={(e) => setLon(e.target.value)} />
                {onPickOnMap && (
                  <button
                    type="button"
                    className="rounded-full border border-border px-3 py-1 text-small text-text-2"
                    onClick={async () => {
                      const p = await onPickOnMap();
                      if (p) {
                        setLat(p.lat.toFixed(6));
                        setLon(p.lon.toFixed(6));
                      }
                    }}
                  >
                    Pick on map
                  </button>
                )}
              </>
            )}
            <input
              aria-label="Radius (m)"
              className={`${field} w-24`}
              inputMode="numeric"
              placeholder="radius m"
              title="How far from the point it could be. Empty: the default for its kind (object 30 m … sound 200 m)."
              value={radius}
              onChange={(e) => setRadius(e.target.value)}
            />
            <select aria-label="Reliability" className={field} value={reliability} onChange={(e) => setReliability(e.target.value as ClueDraft["reliability"])}>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
            <button type="submit" className="rounded-full border border-accent px-3 py-1 text-small text-text">
              Add
            </button>
            {problem && (
              <p role="alert" className="basis-full text-small text-warn">
                {problem}
              </p>
            )}
          </form>
        </Panel>
      )}
      {newest.length === 0 ? (
        <p className="text-small text-text-3">No clues yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line" aria-label="Clues">
          {newest.map((c) => (
            <li key={c.id} className="flex items-center gap-3 py-1 text-small">
              <span className="w-10 shrink-0 font-mono text-text-2">{hhmm(new Date(c.at), utc)}</span>
              <span className="w-9 shrink-0 font-mono text-caption text-text-3">{c.id}</span>
              <span className="min-w-0 flex-1 truncate text-text" title={c.text}>
                {c.text}
              </span>
              <span className="hidden truncate text-caption text-text-2 md:inline">
                {c.kind} · {callsign(c.reported_by)} · {c.reliability} · {c.source === "radio" ? "by radio" : "entered at command"}
              </span>
              <StatusPill tone={c.confirmed ? "ok" : "caution"} dot={false}>
                {c.confirmed ? "confirmed" : "unconfirmed"}
              </StatusPill>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
