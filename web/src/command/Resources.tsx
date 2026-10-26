// Resources (COMMAND_POST.md §5, left column): the T-card board of a command post, one compact row per team
// and per drone (ICS 219: what it is, its status in words, where it is, its time since last heard and back
// ETA), with a summary line on top ("4 teams: 2 free · 2 searching · 3 drones: 1 flying"). Each row has one
// primary action in words: a team's "Assign to sector…" (the sector list, the agent's pick first, POA shown),
// a drone's "Fly a leg…"; Call and Recall are smaller. The rows carry a drag handle: drag one onto a sector
// on the map to assign it there (the map outlines the sector under it and says what a drop does). Most
// overdue first. A team: "heard N min" from its last radio turn or check-in, never its position; amber near
// the check-in interval, red past it. Below, the sectors by POA. Built by lane A.
import { useState, type DragEvent, type ReactNode } from "react";
import type { Drone, FleetState, Mission, MissionEvent, Proposal, SectorTask, Team } from "../contract";
import { SectorPicker } from "./SectorPicker";
import type { SectorNow } from "../lib/api";
import type { FleetLinks } from "../lib/mission";
import { useSelection } from "../lib/selection";
import { StatusPill, type Tone } from "../shell/components";
import { Icon } from "../shell/icons";
import { atBase, duration, etaMin, legOf, linkWord, teamOrder, type Heard } from "./console";
import { useConsole } from "./consoleStore";
import { podLabel, TERMS } from "./terms";

export const TEAM_DRAG = "application/x-sightline-team";
export const DRONE_DRAG = "application/x-sightline-drone";

const STATUS: Record<Team["status"], [string, Tone]> = {
  standby: ["Free", "muted"],
  assigned: ["Assigned", "neutral"],
  searching: ["Searching", "team"],
  returning: ["Returning", "caution"],
  off_duty: ["Off duty", "muted"],
  overdue: ["Overdue", "alert"],
};
const DRONE_STATUS: Record<Drone["status"], [string, Tone]> = {
  idle: ["At base", "muted"],
  flying: ["Flying", "drone"],
  returning: ["Returning", "caution"],
  charging: ["Charging", "muted"],
  offline: ["Offline", "alert"],
};
const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)} %`;
/** The row's one primary action: a filled button with words. */
const primary = "sl-tap inline-flex h-7 items-center gap-1 rounded-full border border-border bg-surface-strong px-2.5 text-caption font-medium text-text hover:border-text-3 aria-pressed:border-accent";
/** Secondary actions: smaller, no fill. */
const minor = "sl-tap inline-flex h-7 items-center rounded-full px-1.5 text-caption text-text-2 hover:bg-surface hover:text-text disabled:opacity-40 disabled:hover:bg-transparent";

export interface ResourceActions {
  /** Task: the sector picked in the list (SectorPicker) for a team or a drone. */
  onAssign?: (teamId: string, sector: string) => void;
  onDroneLeg?: (sector: string, droneId: string) => void;
  onCall: (teamId: string) => void;
  onRecall: (teamId: string) => void;
  onRecallDrone: (droneId: string) => void;
  /** Record the find: the team has the subject in its sector. */
  onFound?: (teamId: string, sector: string) => void;
}

/** The board at a glance: how many teams are free, out, overdue; how many drones fly. Zero counts are left out. */
export function resourceSummary(teams: readonly { team: Team; heard: Heard }[], drones: readonly Drone[]): { teams: string; drones: string | null } {
  const n = (k: number, word: string) => (k ? `${k} ${word}` : null);
  const free = teams.filter(({ team, heard }) => team.status === "standby" && !heard.overdue).length;
  const overdue = teams.filter(({ team, heard }) => team.status === "overdue" || (heard.overdue && team.status !== "standby")).length;
  const searching = teams.filter(({ team, heard }) => team.status === "searching" && !heard.overdue).length;
  const assigned = teams.filter(({ team, heard }) => team.status === "assigned" && !heard.overdue).length;
  const returning = teams.filter(({ team, heard }) => team.status === "returning" && !heard.overdue).length;
  const teamParts = [n(free, "free"), n(assigned, "assigned"), n(searching, "searching"), n(returning, "returning"), n(overdue, "overdue")].filter(Boolean);
  const flying = drones.filter((d) => d.status === "flying").length;
  const atBase = drones.filter((d) => d.status === "idle" || d.status === "charging").length;
  const back = drones.filter((d) => d.status === "returning").length;
  const off = drones.filter((d) => d.status === "offline").length;
  const droneParts = [n(flying, "flying"), n(atBase, "at base"), n(back, "returning"), n(off, "offline")].filter(Boolean);
  return {
    teams: `${teams.length} ${teams.length === 1 ? "team" : "teams"}${teamParts.length ? `: ${teamParts.join(" · ")}` : ""}`,
    drones: drones.length ? `${drones.length} ${drones.length === 1 ? "drone" : "drones"}${droneParts.length ? `: ${droneParts.join(" · ")}` : ""}` : null,
  };
}

export function Resources({
  mission,
  teams,
  tasks,
  sectors,
  fleet,
  links,
  events,
  now,
  actions,
  footer,
  glow = null,
  proposals = [],
  board,
}: {
  /** The teams with when each was last heard (CommandView computes it once for every panel); else computed here. */
  board?: readonly { team: Team; heard: Heard }[];
  /** The agent's pending proposals: Task's list puts its pick for a team or drone first. */
  proposals?: readonly Proposal[];
  /** The team or drone the proposal in focus would send: its card glows violet (V3 §2). */
  glow?: string | null;
  /** Under the cards (a live mission's fleet controls for the simulated fleet). */
  footer?: ReactNode;
  mission: Mission | null;
  teams: readonly Team[];
  tasks: readonly SectorTask[];
  sectors: readonly SectorNow[];
  fleet: FleetState | null;
  links: FleetLinks;
  events: readonly MissionEvent[];
  now: Date;
  actions: ResourceActions;
}) {
  const checkIn = mission?.check_in_min ?? 30;
  const ordered = board ?? teamOrder(teams, events, now, checkIn);
  // the fleet's own order (Drone 1, 2, 3): a row never jumps as a battery drains
  const drones = fleet?.drones ?? [];
  const picking = useConsole((s) => s.picking);
  const summary = resourceSummary(ordered, drones);
  const canDrag = !!actions.onAssign;
  return (
    <section aria-label="Resources" data-tour="tasks" className="flex min-h-0 flex-col overflow-hidden lg:flex-1 rounded-lg border border-line bg-surface-solid">
      <h2 className="sl-panel-head">
        Resources
        <span className="ml-auto whitespace-nowrap text-caption font-normal text-text-3" title={`Teams in the field radio in at least every ${checkIn} min (a planning choice for this mission). A team turns amber ten minutes before and is overdue past it.`}>
          Radio check-in every {checkIn} min
        </span>
      </h2>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
        <p aria-label="Resources summary" className="flex flex-col px-1 text-caption text-text-2">
          <span>{summary.teams}</span>
          {summary.drones && <span>{summary.drones}</span>}
        </p>
        {canDrag && (
          <p className="flex items-center gap-1 px-1 text-caption text-text-3">
            <Icon name="grip" size={14} className="shrink-0" />
            <span>
              <span className="hidden lg:inline">Drag a row onto a sector, or press Assign</span>
              <span className="lg:hidden">Press Assign to sector… to send a team</span>
            </span>
          </p>
        )}
        <ul aria-label="Teams" className="flex flex-col gap-1">
          {ordered.map(({ team, heard }) => (
            <li key={team.id}>
              <TeamCard team={team} heard={heard} task={tasks.find((x) => x.team_id === team.id && (x.state === "assigned" || x.state === "in_progress"))} base={mission?.base_camp} picking={picking?.id === team.id} glow={glow === team.id} actions={actions} picker={{ sectors, tasks, proposals }} />
            </li>
          ))}
        </ul>
        {drones.length > 0 && (
          <ul aria-label="Drones" className="mt-0.5 flex flex-col gap-1">
            {drones.map((d) => (
              <li key={d.id}>
                <DroneCard d={d} fleet={fleet} link={linkWord(links, d.id)} picking={picking?.id === d.id} glow={glow === d.id} onRecall={() => actions.onRecallDrone(d.id)} picker={{ sectors, tasks, proposals }} onLeg={actions.onDroneLeg} />
              </li>
            ))}
          </ul>
        )}
        <SectorsByPoa tasks={tasks} sectors={sectors} teams={teams} />
        {footer}
      </div>
    </section>
  );
}

function heardWords(h: Heard, status: Team["status"], home: boolean): [string, string] {
  // at base camp the team is at the command post: no radio check-in to keep
  const free = status === "standby" || status === "off_duty";
  if (free && home) return ["at base camp", "text-text-3"];
  // a free team away from base camp says where it is (the map shows it there)
  const where = free ? "in the field · " : "";
  if (h.min === null) return [`${where}not heard yet`, "text-text-3"];
  const m = Math.round(h.min);
  // overdue: the row's red badge says it
  if (h.overdue) return ["", ""];
  return [`${where}heard ${m} min`, h.due ? "text-caution" : "text-text-2"];
}

interface PickerData {
  sectors: readonly SectorNow[];
  tasks: readonly SectorTask[];
  proposals: readonly Proposal[];
}
const stopPicking = () => useConsole.getState().pick(null);

/** Start dragging a row toward the map (the map takes the drop; lib: LiveHeatMap). */
function dragStart(e: DragEvent, kind: "team" | "drone", id: string, name: string) {
  e.dataTransfer.setData(kind === "team" ? TEAM_DRAG : DRONE_DRAG, id);
  e.dataTransfer.setData("text/plain", name);
  e.dataTransfer.effectAllowed = "move";
  useConsole.getState().drag({ kind, id });
}
const dragEnd = () => useConsole.getState().drag(null);

/** The handle on the left of a row: it says the row can be dragged (the whole row drags). */
function Grip({ name }: { name: string }) {
  return (
    <span aria-hidden title={`Drag ${name} onto a sector on the map`} className="-ml-1 hidden shrink-0 cursor-grab text-text-3 lg:inline-flex">
      <Icon name="grip" size={14} />
    </span>
  );
}

function TeamCard({ team, heard, task, base, picking, glow = false, actions, picker }: { team: Team; heard: Heard; task?: SectorTask; base?: Mission["base_camp"]; picking: boolean; glow?: boolean; actions: ResourceActions; picker?: PickerData }) {
  const selected = useSelection((s) => s.selectedTeamId === team.id);
  const dragging = useConsole((s) => s.dragging?.id === team.id);
  const overdue = heard.overdue && team.status !== "standby";
  const [word, tone] = STATUS[overdue ? "overdue" : team.status];
  const home = atBase(team, base);
  const [heardText, heardClass] = heardWords(heard, team.status, home);
  const eta = etaMin(team, base);
  const inField = team.status !== "standby" && team.status !== "off_duty";
  const canAssign = !!actions.onAssign;
  // overdue: one red badge with how long ("Overdue · not heard 45 min"), the same minutes as Needs you
  const overdueWords = heard.min === null ? "not heard yet" : `not heard ${Math.round(heard.min)} min`;
  const hasty = team.note === "hasty search" && !task && team.status === "searching";
  const pill = (
    <StatusPill tone={tone} dot={team.status === "searching" || team.status === "returning"} className="shrink-0">
      {overdue ? `Overdue · ${overdueWords}` : word}
      {task ? ` · ${task.sector_id}` : hasty ? " · hasty search" : ""}
    </StatusPill>
  );
  return (
    <article
      aria-label={`Team ${team.callsign}`}
      data-team={team.id}
      data-overdue={overdue || undefined}
      data-status={overdue ? "overdue" : team.status}
      data-tone={tone}
      draggable={canAssign}
      onDragStart={(e) => dragStart(e, "team", team.id, team.callsign)}
      onDragEnd={dragEnd}
      className={`flex flex-col gap-0.5 rounded-md border border-l-[3px] border-l-[var(--c)] bg-bg/40 py-1 pr-2 pl-2.5 ${canAssign ? "lg:cursor-grab lg:active:cursor-grabbing" : ""} ${picking ? "border-accent" : heard.overdue ? "border-alert/50" : selected ? "border-border" : "border-line"} ${glow ? "sl-glow-proposal" : ""} ${dragging ? "opacity-60" : ""}`}
      data-glow={glow || undefined}
    >
      <div className="flex items-center gap-1.5">
        {canAssign && <Grip name={team.callsign} />}
        <Icon name="team" className={`shrink-0 ${heard.overdue ? "text-alert" : "text-team"}`} />
        <button
          type="button"
          aria-pressed={selected}
          title={`${team.members} people · ${team.position ? "show on the map" : "no position yet"}`}
          onClick={() => useSelection.getState().selectTeam(selected ? null : team.id)}
          className="sl-tap min-w-0 truncate text-left text-small font-medium text-text hover:underline"
        >
          {team.callsign}
        </button>
        {!inField && pill}
        <span className={`ml-auto shrink-0 text-right text-caption ${heardClass}`}>{heardText}</span>
      </div>
      {/* a team out: its status and sector on a line of their own, with when it is back */}
      {inField && (
        <div className="flex items-center gap-2">
          {pill}
          {eta !== null && <span className="ml-auto text-caption text-text-2">back ~{duration(eta)}</span>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1">
        {canAssign && (
          <button type="button" className={primary} aria-pressed={picking} aria-expanded={picking} onClick={() => useConsole.getState().pick(picking ? null : { kind: "team", id: team.id })}>
            {picking ? "Pick a sector…" : inField ? "Reassign…" : "Assign to sector…"}
          </button>
        )}
        <button type="button" className={minor} onClick={() => actions.onCall(team.id)}>
          Call
        </button>
        <button type="button" className={minor} disabled={!inField || team.status === "returning"} onClick={() => actions.onRecall(team.id)}>
          Recall
        </button>
        {task && actions.onFound && (
          <button type="button" className={minor} title={`Record that ${team.callsign} has the subject in ${task.sector_id}`} onClick={() => actions.onFound?.(team.id, task.sector_id)}>
            Record find
          </button>
        )}
      </div>
      {picking && picker && actions.onAssign && (
        <SectorPicker
          kind="team"
          id={team.id}
          name={team.callsign}
          {...picker}
          onPick={(sector) => {
            actions.onAssign?.(team.id, sector);
            stopPicking();
          }}
          onClose={stopPicking}
        />
      )}
    </article>
  );
}

function DroneCard({ d, fleet, link, picking, glow = false, onRecall, picker, onLeg }: { d: Drone; fleet: FleetState | null; link: string; picking: boolean; glow?: boolean; onRecall: () => void; picker?: PickerData; onLeg?: (sector: string, drone: string) => void }) {
  const [word, tone] = DRONE_STATUS[d.status];
  const dragging = useConsole((s) => s.dragging?.id === d.id);
  const leg = legOf(d, fleet);
  const sector = fleet?.legs.find((l) => l.id === d.leg_id)?.sector_id;
  const linkTone = link === "connected" ? "text-text-2" : link === "degraded" ? "text-caution" : "text-alert";
  const canFly = !!onLeg;
  // a drone in the air: its status and sector on a line of their own
  const out = d.status === "flying" || d.status === "returning";
  const facts = (
    <span className="flex gap-2 text-caption whitespace-nowrap">
      <span className={linkTone}>link {link === "connected" ? "ok" : link}</span>
      {leg.m > 0 && <span className="text-text-3" title={`${TERMS.flightLine} ${leg.n} of ${leg.m}`}>line {leg.n} of {leg.m}</span>}
    </span>
  );
  const pill = (
    <StatusPill tone={tone} dot={d.status === "flying"} className="shrink-0">
      {word}
      {sector && d.status !== "idle" ? ` · ${sector}` : ""}
    </StatusPill>
  );
  return (
    <article
      aria-label={`Drone ${d.name}`}
      data-drone={d.id}
      data-tone={tone}
      data-glow={glow || undefined}
      draggable={canFly}
      onDragStart={(e) => dragStart(e, "drone", d.id, d.name)}
      onDragEnd={dragEnd}
      className={`flex flex-col gap-0.5 rounded-md border border-l-[3px] border-l-[var(--c)] bg-bg/40 py-1 pr-2 pl-2.5 ${canFly ? "lg:cursor-grab lg:active:cursor-grabbing" : ""} ${picking ? "border-accent" : "border-line"} ${glow ? "sl-glow-proposal" : ""} ${dragging ? "opacity-60" : ""}`}
    >
      <div className="flex items-center gap-1.5">
        {canFly && <Grip name={d.name} />}
        <Icon name="drone" className="shrink-0 text-drone" />
        <button type="button" onClick={() => useSelection.getState().selectDrone(d.id)} className="sl-tap min-w-0 truncate text-left text-small font-medium text-text hover:underline">
          {d.name}
        </button>
        {!out && pill}
        <span className={`ml-auto shrink-0 text-caption ${d.battery_pct < 25 ? "text-caution" : "text-text-2"}`}>battery {Math.round(d.battery_pct)} %</span>
      </div>
      {out && (
        <div className="flex items-center gap-2">
          {pill}
          <span className="ml-auto">{facts}</span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1">
        {canFly && (
          <button type="button" className={primary} aria-pressed={picking} aria-expanded={picking} onClick={() => useConsole.getState().pick(picking ? null : { kind: "drone", id: d.id })}>
            {picking ? "Pick a sector…" : "Fly over a sector…"}
          </button>
        )}
        <button type="button" className={minor} disabled={d.status !== "flying"} onClick={onRecall}>
          Recall
        </button>
        {!out && <span className="ml-auto">{facts}</span>}
      </div>
      {picking && picker && onLeg && (
        <SectorPicker
          kind="drone"
          id={d.id}
          name={d.name}
          {...picker}
          onPick={(sector) => {
            onLeg(sector, d.id);
            stopPicking();
          }}
          onClose={stopPicking}
        />
      )}
    </article>
  );
}

/** How many sectors show before "Show N more". */
export const SECTORS_SHOWN = 5;

/** The sectors by POA (the old task board's facts, one row each), the likeliest shown; a row opens its popover on the map. */
function SectorsByPoa({ tasks, sectors, teams }: { tasks: readonly SectorTask[]; sectors: readonly SectorNow[]; teams: readonly Team[] }) {
  const [open, setOpen] = useState(false);
  const all = [...sectors].sort((a, b) => b.poa - a.poa);
  const rows = open ? all : all.slice(0, SECTORS_SHOWN);
  const callsign = (id: string | null) => teams.find((t) => t.id === id)?.callsign ?? "";
  const STATE: Record<SectorTask["state"], string> = { proposed: "open", assigned: "assigned", in_progress: "searching", searched: "searched" };
  return (
    <section aria-label="Sectors by POA" className="mt-1 rounded-md border border-line">
      <h3 className="flex items-center gap-2 px-2.5 py-2 text-small text-text-2">
        Sectors by POA <span className="text-caption text-text-3">{all.length}</span>
      </h3>
      {(
        <table className="w-full text-caption" aria-label="Sectors by POA">
          <thead className="text-text-3">
            <tr>
              <th className="px-2.5 py-1 text-left font-normal">Sector</th>
              <th className="sl-num px-2 py-1 font-normal" title={TERMS.poaTip}>POA</th>
              <th className="px-2 py-1 text-left font-normal">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const t = tasks.find((x) => x.sector_id === s.sector_id);
              return (
                <tr key={s.sector_id} aria-label={`Sector ${s.sector_id}`} className="border-t border-line hover:bg-surface">
                  <td className="px-2.5 py-1">
                    <button
                      type="button"
                      className="sl-tap text-left text-text hover:underline"
                      onClick={() => {
                        useConsole.getState().openSector(s.sector_id, Number.NaN, Number.NaN);
                        // phones: the map is above, out of sight
                        if (window.innerWidth < 1024) document.getElementById("console-map")?.scrollIntoView({ block: "start" });
                      }}
                    >
                      {s.sector_id} <span className="text-text-3">{s.label}</span>
                    </button>
                  </td>
                  <td className="sl-num px-2 py-1 text-text">{pct(s.poa)}</td>
                  <td className="px-2 py-1 text-text-2">
                    {t ? (t.state === "searched" ? `searched, ${podLabel(t.pod ?? 0)}` : STATE[t.state]) : "open"}
                    {t?.team_id && t.state !== "searched" ? ` · ${callsign(t.team_id)}` : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {all.length > 0 && (
        <p className="border-t border-line px-2.5 py-1.5 text-caption text-text-3" title={TERMS.rowTip}>
          {TERMS.row}: <span className="text-text-2">{Math.round(Math.max(0, 1 - all.reduce((n, s) => n + s.poa, 0)) * 100)} %</span>
        </p>
      )}
      {all.length > SECTORS_SHOWN && (
        <button type="button" onClick={() => setOpen(!open)} className="sl-tap w-full border-t border-line px-2.5 py-1.5 text-left text-caption text-text-2 underline underline-offset-2 hover:text-text">
          {open ? "Show fewer" : `Show ${all.length - SECTORS_SHOWN} more`}
        </button>
      )}
    </section>
  );
}
