// The sector popover (COMMAND_POST.md §5, the map): click a sector and act on it directly. Assign a team
// (the agent's pick first, when it proposed one), send a drone leg, mark it searched at a POD (never 100 %:
// a search lowers a sector's probability, it never removes it), open it again for a recheck, or record the
// find. Every action is logged to the timeline like an approval. Built by lane A.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Proposal, SectorTask, Team } from "../contract";
import type { SectorNow } from "../lib/api";
import { KeyHint } from "../shell/components";

export interface SectorActions {
  assign: (teamId: string, sector: string) => void;
  droneLeg: (sector: string, droneId?: string) => void;
  searched: (sector: string, pod: number) => void;
  recheck: (sector: string) => void;
  found: (teamId: string, sector: string) => void;
}

export const POD_TIP = "POD is how likely the team would have found the person if they were there. It lowers the sector's probability; it never removes it.";
const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)} %`;
const chip = "sl-tap inline-flex h-7 items-center gap-1 rounded-full border border-line bg-surface-strong px-2.5 text-caption text-text hover:border-border disabled:opacity-40";

export function SectorPopover({
  sector,
  task,
  teams,
  proposals,
  x,
  y,
  width,
  height,
  actions,
  cardHref,
  onClose,
}: {
  sector: SectorNow;
  task: SectorTask | undefined;
  teams: readonly Team[];
  proposals: readonly Proposal[];
  /** Where it opens, in the map's own pixels, and the map's size (it stays inside). */
  x: number;
  y: number;
  width: number;
  height: number;
  actions: SectorActions;
  cardHref?: (sector: string) => string;
  onClose: () => void;
}) {
  const [pod, setPod] = useState(0.5);
  const box = useRef<HTMLDivElement>(null);
  const agent = proposals.find((p) => p.status === "pending" && p.kind === "assign_sector" && p.target.sector === sector.sector_id);
  const pick = agent?.target.team;
  // every team can be sent (a search manager re-tasks teams already out): the agent's pick, then those on
  // standby, then the rest, each saying what it is doing now
  const rank = (t: Team) => (t.id === pick ? 0 : t.status === "standby" ? 1 : t.status === "off_duty" ? 3 : 2);
  const ordered = teams.filter((t) => t.status !== "off_duty" || t.id === pick).sort((a, b) => rank(a) - rank(b));
  const busyIn = (t: Team) => (t.status === "standby" ? null : t.status);
  const assigned = task && (task.state === "assigned" || task.state === "in_progress") ? teams.find((t) => t.id === task.team_id) : undefined;
  const id = sector.sector_id;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    box.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, id]);
  const W = 288;
  const left = Math.max(8, Math.min(x + 12, width - W - 8));
  // inside the map: its own measured height decides how high it may open (it scrolls when the map is shorter)
  const [tall, setTall] = useState(360);
  useLayoutEffect(() => {
    if (box.current) setTall(box.current.offsetHeight);
  });
  const top = Math.max(8, Math.min(y - 24, height - tall - 8));
  const state = !task || task.state === "proposed" ? "open" : task.state === "searched" ? `searched at POD ${Math.round((task.pod ?? 0) * 100)} %` : `${task.state === "assigned" ? "assigned to" : "being searched by"} ${assigned?.callsign ?? task.team_id}`;
  return (
    <div
      ref={box}
      role="dialog"
      aria-label={`Sector ${id}`}
      className="sl-pop absolute z-20 flex flex-col gap-3 rounded-lg border border-border bg-surface-solid p-3 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.9)]"
      style={{ left, top, width: W, maxHeight: height - 16, overflowY: "auto" }}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-title font-medium text-text">{id}</span>
        <span className="truncate text-small text-text-2">{sector.label}</span>
        <button type="button" onClick={onClose} className="sl-tap ml-auto text-caption text-text-3 hover:text-text" aria-label="Close">
          Close <KeyHint>Esc</KeyHint>
        </button>
      </div>
      <p className="-mt-2 text-caption text-text-2">
        POA <span className="text-text">{pct(sector.poa)}</span> · drone coverage {pct(sector.drone_coverage)} · {state}
      </p>
      {(!task || task.state === "proposed" || task.state === "searched") && (
        <div role="group" aria-label="Assign a team" className="flex flex-col gap-1.5">
          <span className="text-caption font-medium text-text-2">Assign a team</span>
          {ordered.length === 0 ? (
            <span className="text-caption text-text-3">No team on duty.</span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {ordered.map((t) => (
                <button key={t.id} type="button" className={`${chip} ${t.id === pick ? "border-accent/60" : ""}`} onClick={() => actions.assign(t.id, id)}>
                  {t.callsign}
                  {t.id === pick ? <span className="text-accent-soft">· agent's pick</span> : busyIn(t) ? <span className="text-text-3">· {busyIn(t)}</span> : null}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className={chip} onClick={() => actions.droneLeg(id)}>
          Send a drone leg
        </button>
        {task?.state === "searched" && (
          <button type="button" className={chip} onClick={() => actions.recheck(id)}>
            Recheck
          </button>
        )}
        {cardHref && assigned && (
          <a className={chip} href={cardHref(id)}>
            Assignment card
          </a>
        )}
      </div>
      {task?.state !== "searched" && (
        <div role="group" aria-label="POD entry" title={POD_TIP} className="flex flex-col gap-1.5">
          <span className="text-caption font-medium text-text-2">Mark searched at a POD</span>
          <div className="flex gap-1.5">
            {[
              ["Low", 0.3],
              ["Medium", 0.5],
              ["High", 0.7],
            ].map(([name, v]) => (
              <button key={name} type="button" aria-label={`${name} ${Math.round((v as number) * 100)} %`} className={chip} onClick={() => actions.searched(id, v as number)}>
                <span className="whitespace-nowrap">{name}</span>
                <span className="whitespace-nowrap text-text-3">{Math.round((v as number) * 100)}%</span>
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-caption text-text-2">
            POD
            <input type="range" aria-label="POD" className="sl-range flex-1" style={{ ["--sl-range-fill" as string]: `${((pod - 0.05) / 0.85) * 100}%` }} min={0.05} max={0.9} step={0.05} value={pod} onChange={(e) => setPod(Number(e.target.value))} />
            <button type="button" className={chip} onClick={() => actions.searched(id, pod)}>
              {Math.round(pod * 100)} %
            </button>
          </label>
          <span className="text-caption text-text-3">{POD_TIP}</span>
        </div>
      )}
      {assigned && (
        <button type="button" className={`${chip} self-start border-ok/50`} onClick={() => actions.found(assigned.id, id)}>
          Found: {assigned.callsign} has the subject
        </button>
      )}
    </div>
  );
}
