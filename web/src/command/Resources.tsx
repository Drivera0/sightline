// Resources (COMMAND_POST.md §5, left column): one T-card per team and drone, the way a command post's
// T-card board reads. A team: name, status, sector, "heard N min" (its last radio turn or check-in, never
// its position; amber near the check-in interval, red past it), back in ~N min; Call, Task, Recall. A
// drone: status, battery, link, leg n/m; Task, Recall. Most overdue first. Drag a team's card onto a
// sector on the map to assign it. Below, the sectors by POA, folded. Built by lane A.
import { useState, type DragEvent, type ReactNode } from "react";
import type { Drone, FleetState, Mission, MissionEvent, SectorTask, Team } from "../contract";
import type { SectorNow } from "../lib/api";
import type { FleetLinks } from "../lib/mission";
import { useSelection } from "../lib/selection";
import { StatusPill, type Tone } from "../shell/components";
import { Icon } from "../shell/icons";
import { duration, etaMin, legOf, linkWord, teamOrder, type Heard } from "./console";
import { useConsole } from "./consoleStore";

export const TEAM_DRAG = "application/x-sightline-team";

const STATUS: Record<Team["status"], [string, Tone]> = {
  standby: ["Standby", "muted"],
  assigned: ["Assigned", "neutral"],
  searching: ["Searching", "ok"],
  returning: ["Returning", "caution"],
  off_duty: ["Off duty", "muted"],
  overdue: ["Overdue", "alert"],
};
const DRONE_STATUS: Record<Drone["status"], [string, Tone]> = {
  idle: ["At base", "muted"],
  flying: ["Flying", "ok"],
  returning: ["Returning", "caution"],
  charging: ["Charging", "muted"],
  offline: ["Offline", "alert"],
};
const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)} %`;
const btn = "sl-tap inline-flex h-7 items-center rounded-full border border-line px-2.5 text-caption text-text-2 hover:border-border hover:text-text disabled:opacity-40";

export interface ResourceActions {
  onCall: (teamId: string) => void;
  onRecall: (teamId: string) => void;
  onRecallDrone: (droneId: string) => void;
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
}: {
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
  const ordered = teamOrder(teams, events, now, checkIn);
  const drones = [...(fleet?.drones ?? [])].sort((a, b) => a.battery_pct - b.battery_pct);
  const picking = useConsole((s) => s.picking);
  return (
    <section aria-label="Resources" data-tour="tasks" className="flex min-h-0 flex-col overflow-hidden lg:flex-1 rounded-lg border border-line bg-surface-solid">
      <h2 className="sl-panel-head">
        Resources
        <span className="ml-auto whitespace-nowrap text-caption font-normal text-text-3" title={`${teams.length} teams, ${drones.length} drones. A team turns amber near the check-in interval and red past it (${checkIn} min, a planning choice for this mission).`}>
          check-in {checkIn} min
        </span>
      </h2>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {ordered.map(({ team, heard }) => (
          <TeamCard key={team.id} team={team} heard={heard} task={tasks.find((x) => x.team_id === team.id && (x.state === "assigned" || x.state === "in_progress"))} base={mission?.base_camp} picking={picking?.id === team.id} glow={glow === team.id} actions={actions} />
        ))}
        {drones.map((d) => (
          <DroneCard key={d.id} d={d} fleet={fleet} link={linkWord(links, d.id)} picking={picking?.id === d.id} glow={glow === d.id} onRecall={() => actions.onRecallDrone(d.id)} />
        ))}
        <SectorsByPoa tasks={tasks} sectors={sectors} teams={teams} />
        {footer}
      </div>
    </section>
  );
}

function heardWords(h: Heard): [string, string] {
  if (h.min === null) return ["not heard yet", "text-text-3"];
  const m = Math.round(h.min);
  if (h.overdue) return [`not heard ${m} min`, "text-alert"];
  return [`heard ${m} min`, h.due ? "text-caution" : "text-text-2"];
}

function TeamCard({ team, heard, task, base, picking, glow = false, actions }: { team: Team; heard: Heard; task?: SectorTask; base?: Mission["base_camp"]; picking: boolean; glow?: boolean; actions: ResourceActions }) {
  const selected = useSelection((s) => s.selectedTeamId === team.id);
  const [word, tone] = STATUS[heard.overdue && team.status !== "standby" ? "overdue" : team.status];
  const [heardText, heardClass] = heardWords(heard);
  const eta = etaMin(team, base);
  const inField = team.status !== "standby" && team.status !== "off_duty";
  const onDrag = (e: DragEvent) => {
    e.dataTransfer.setData(TEAM_DRAG, team.id);
    e.dataTransfer.setData("text/plain", team.callsign);
    e.dataTransfer.effectAllowed = "move";
  };
  return (
    <article
      aria-label={`Team ${team.callsign}`}
      data-team={team.id}
      draggable
      onDragStart={onDrag}
      className={`flex cursor-grab flex-col gap-1.5 rounded-md border bg-bg/40 p-2.5 active:cursor-grabbing ${picking ? "border-accent" : heard.overdue ? "border-alert/50" : selected ? "border-border" : "border-line"} ${glow ? "sl-glow-proposal" : ""}`}
      data-glow={glow || undefined}
      title="Drag onto a sector on the map to assign"
    >
      <div className="flex items-center gap-2">
        <Icon name="team" className={heard.overdue ? "text-alert" : "text-text-2"} />
        <button
          type="button"
          aria-pressed={selected}
          title={team.position ? "Show on the map" : "No position yet"}
          onClick={() => useSelection.getState().selectTeam(selected ? null : team.id)}
          className="sl-tap min-w-0 truncate text-left text-small font-medium text-text hover:underline"
        >
          {team.callsign}
        </button>
        {task && <span className="text-caption text-text-2">{task.sector_id}</span>}
        <StatusPill tone={tone} dot={team.status === "searching" || team.status === "returning"} className="ml-auto">
          {word}
        </StatusPill>
      </div>
      <div className="flex items-center gap-3 text-caption">
        <span className={heardClass}>{heardText}</span>
        {eta !== null && <span className="text-text-2">back ~{duration(eta)}</span>}
        <span className="ml-auto text-text-3">{team.members} people</span>
      </div>
      <div className="flex gap-1.5">
        <button type="button" className={btn} onClick={() => actions.onCall(team.id)}>
          Call
        </button>
        <button type="button" className={btn} aria-pressed={picking} onClick={() => useConsole.getState().pick(picking ? null : { kind: "team", id: team.id })}>
          {picking ? "Pick a sector…" : "Task"}
        </button>
        <button type="button" className={btn} disabled={!inField || team.status === "returning"} onClick={() => actions.onRecall(team.id)}>
          Recall
        </button>
      </div>
    </article>
  );
}

function DroneCard({ d, fleet, link, picking, glow = false, onRecall }: { d: Drone; fleet: FleetState | null; link: string; picking: boolean; glow?: boolean; onRecall: () => void }) {
  const [word, tone] = DRONE_STATUS[d.status];
  const leg = legOf(d, fleet);
  const sector = fleet?.legs.find((l) => l.id === d.leg_id)?.sector_id;
  const linkTone = link === "connected" ? "text-text-2" : link === "degraded" ? "text-caution" : "text-alert";
  return (
    <article aria-label={`Drone ${d.name}`} data-drone={d.id} data-glow={glow || undefined} className={`flex flex-col gap-1.5 rounded-md border bg-bg/40 p-2.5 ${picking ? "border-accent" : "border-line"} ${glow ? "sl-glow-proposal" : ""}`}>
      <div className="flex items-center gap-2">
        <Icon name="drone" className="text-text-2" />
        <button type="button" onClick={() => useSelection.getState().selectDrone(d.id)} className="sl-tap min-w-0 truncate text-left text-small font-medium text-text hover:underline">
          {d.name}
        </button>
        {sector && <span className="text-caption text-text-2">{sector}</span>}
        <StatusPill tone={tone} dot={d.status === "flying"} className="ml-auto">
          {word}
        </StatusPill>
      </div>
      <div className="flex items-center gap-3 text-caption">
        <span className={d.battery_pct < 25 ? "text-caution" : "text-text-2"}>battery {Math.round(d.battery_pct)} %</span>
        <span className={linkTone}>link {link === "connected" ? "ok" : link}</span>
        {leg.m > 0 && <span className="ml-auto text-text-3">leg {leg.n}/{leg.m}</span>}
      </div>
      <div className="flex gap-1.5">
        <button type="button" className={btn} aria-pressed={picking} onClick={() => useConsole.getState().pick(picking ? null : { kind: "drone", id: d.id })}>
          {picking ? "Pick a sector…" : "Task"}
        </button>
        <button type="button" className={btn} disabled={d.status !== "flying"} onClick={onRecall}>
          Recall
        </button>
      </div>
    </article>
  );
}

/** The sectors by POA, folded (the old task board's facts, one row each); a row opens its popover on the map. */
function SectorsByPoa({ tasks, sectors, teams }: { tasks: readonly SectorTask[]; sectors: readonly SectorNow[]; teams: readonly Team[] }) {
  const [open, setOpen] = useState(false);
  const rows = [...sectors].sort((a, b) => b.poa - a.poa);
  const callsign = (id: string | null) => teams.find((t) => t.id === id)?.callsign ?? "";
  const STATE: Record<SectorTask["state"], string> = { proposed: "open", assigned: "assigned", in_progress: "searching", searched: "searched" };
  return (
    <details className="mt-1 rounded-md border border-line" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="sl-tap flex cursor-pointer items-center gap-2 px-2.5 py-2 text-small text-text-2">
        Sectors by POA <span className="text-caption text-text-3">{rows.length}</span>
      </summary>
      {open && (
        <table className="w-full text-caption" aria-label="Sectors by POA">
          <thead className="text-text-3">
            <tr>
              <th className="px-2.5 py-1 text-left font-normal">Sector</th>
              <th className="sl-num px-2 py-1 font-normal">POA</th>
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
                    {t ? (t.state === "searched" ? `searched, POD ${Math.round((t.pod ?? 0) * 100)} %` : STATE[t.state]) : "open"}
                    {t?.team_id && t.state !== "searched" ? ` · ${callsign(t.team_id)}` : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </details>
  );
}
