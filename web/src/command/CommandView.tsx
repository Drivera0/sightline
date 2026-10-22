// The command view (LANE_E §7): the search manager's screen. Mission header with conditions, the task
// board (sectors through proposed → assigned → in progress → searched at a POD), the team roster, the
// approval inbox, the clue log. Built by lane A for lane E (issue #70); lane B's map goes in the middle
// once it reads live missions.

import { useEffect, useState, type FormEvent } from "react";
import type { Clue, ClueDraft, Conditions, Mission, Proposal, SectorTask, Team } from "../contract";
import type { SectorNow } from "../lib/api";
import { Badge, Label, Panel } from "../shell/components";
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
  now?: () => Date;
}

const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
const hhmm = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const minutesSince = (iso: string, now: Date) => Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60000));

export function CommandView(p: CommandProps) {
  const now = p.now ?? (() => new Date());
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000); // the clock and the ages
    return () => clearInterval(id);
  }, []);
  return (
    <div className="flex flex-col gap-4" aria-label="Command view">
      <MissionHeader mission={p.mission} status={p.status} conditions={p.conditions} now={now()} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="flex flex-col gap-4">
          <TaskBoard tasks={p.tasks} sectors={p.sectors} teams={p.teams} onSetTask={p.onSetTask} onUpdateTeam={p.onUpdateTeam} now={now()} cardHref={p.cardHref} />
          <TeamRoster teams={p.teams} tasks={p.tasks} now={now()} />
        </div>
        <ApprovalInbox proposals={p.proposals} teams={p.teams} onDecide={p.onDecide} imageUrl={p.imageUrl} />
      </div>
      <ClueLog clues={p.clues} teams={p.teams} onAddClue={p.onAddClue} onPickOnMap={p.onPickOnMap} />
    </div>
  );
}

export function MissionHeader({ mission, status, conditions: c, now }: { mission: Mission | null; status: string; conditions: Conditions | null; now: Date }) {
  const bits: string[] = [];
  if (c) {
    if (c.wind_kmh !== null) bits.push(`wind ${c.wind_kmh.toFixed(0)} km/h${c.gust_kmh !== null ? `, gusts ${c.gust_kmh.toFixed(0)}` : ""}`);
    if (c.precip_mm_h) bits.push(`rain ${c.precip_mm_h.toFixed(1)} mm/h`);
    if (c.flyability_reason.startsWith("before dawn")) bits.push("before dawn");
    else if (c.civil_twilight_end) {
      const left = (new Date(c.civil_twilight_end).getTime() - now.getTime()) / 60000;
      bits.push(left > 0 ? `daylight ${Math.floor(left / 60)} h ${Math.round(left % 60)} m` : "after dark");
    }
    bits.push(c.flyable === true ? `flyable until ~${c.flyable_until ? hhmm(new Date(c.flyable_until)) : "dusk"}` : c.flyable === false ? `not flyable: ${c.flyability_reason}` : "flyability unknown");  // prettier-ignore
  }
  const old = c ? minutesSince(c.fetched_at, now) > 60 : false;
  return (
    <Panel className="flex flex-col gap-1 p-4" aria-label="Mission header">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-title text-text">{mission?.name ?? "…"}</span>
        <span className="font-mono text-small text-text-2">{hhmm(now)}</span>
        <Badge kind={status === "demo" ? "simulated" : "info"}>{status === "demo" ? "Demo" : status === "live" ? "Live" : status}</Badge>
      </div>
      <p className="text-small text-text-2">
        <span className="text-text-3">Conditions: </span>
        {c ? bits.join(" · ") : "not yet fetched"}
        {c && c.alerts.length > 0 && <span className="text-warn"> · {c.alerts.map((a) => a.title).join("; ")}</span>}
        {old && <span className="text-warn"> · as of {hhmm(new Date(c!.fetched_at))}</span>}
      </p>
    </Panel>
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
}: {
  tasks: readonly SectorTask[];
  sectors: readonly SectorNow[];
  teams: readonly Team[];
  onSetTask: CommandProps["onSetTask"];
  onUpdateTeam: CommandProps["onUpdateTeam"];
  now: Date;
  cardHref?: CommandProps["cardHref"];
}) {
  const [allProposed, setAllProposed] = useState(false);
  const live = new Map(sectors.map((s) => [s.sector_id, s]));
  const callsign = (id: string | null) => teams.find((t) => t.id === id)?.callsign ?? id ?? "";
  const poa = (t: SectorTask) => live.get(t.sector_id)?.poa ?? t.poa;
  return (
    <section aria-label="Task board" className="flex flex-col gap-2">
      <Label>Task board</Label>
      <div className="grid gap-3 md:grid-cols-4">
        {COLUMNS.map((col) => {
          const all = tasks.filter((t) => t.state === col.state).sort((a, b) => poa(b) - poa(a));
          // The unassigned sectors: the most likely few; the rest on request (16 cards bury the board).
          const cut = col.state === "proposed" && !allProposed ? PROPOSED_SHOWN : all.length;
          const cards = all.slice(0, cut);
          return (
            <div key={col.state} className="flex flex-col gap-2" aria-label={col.label}>
              <span className="font-mono text-label text-text-3">
                {col.label} ({all.length})
              </span>
              {cards.map((t) => (
                <TaskCard key={t.sector_id} t={t} label={live.get(t.sector_id)?.label ?? t.sector_id} poa={poa(t)} coverage={live.get(t.sector_id)?.drone_coverage} teams={teams} callsign={callsign} onSetTask={onSetTask} onUpdateTeam={onUpdateTeam} now={now} cardHref={cardHref} />  // prettier-ignore
              ))}
              {all.length > cards.length && (
                <button type="button" className="rounded-full border border-border px-2.5 py-1 text-caption text-text-2" onClick={() => setAllProposed(true)}>
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
  const btn = "rounded-full border border-border px-2.5 py-1 text-caption text-text-2";
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
  const status =
    t.state === "assigned"
      ? `Assigned to ${callsign(t.team_id)}`
      : t.state === "in_progress"
        ? `In progress · ${callsign(t.team_id)} · ${minutesSince(t.updated_at, now)} min`
        : t.state === "searched"
          ? `Searched at POD ${Math.round((t.pod ?? 0) * 100)}%`
          : "Proposed";
  return (
    <Panel className="flex flex-col gap-1.5 p-3" aria-label={`Sector ${t.sector_id}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-small font-medium text-text">
          {t.sector_id} <span className="text-text-3">{label}</span>
        </span>
        <span className="font-mono text-small text-accent-soft" title="Probability the person is in this sector, on the live map">
          {pct(poa)}
        </span>
      </div>
      <span className="text-caption text-text-2">{status}</span>
      {coverage !== undefined && <span className="text-caption text-text-3">drone coverage {pct(coverage)}</span>}
      {t.note && <span className="text-caption text-text-3">“{t.note}”</span>}
      <div className="flex flex-wrap gap-1.5">
        {t.state === "proposed" && !picking && (
          <button type="button" className={btn} onClick={() => setPicking(true)} disabled={standby.length === 0}>
            Assign team…
          </button>
        )}
        {picking &&
          standby.map((x) => (
            <button key={x.id} type="button" className={btn} onClick={() => void assign(x.id)}>
              {x.callsign}
            </button>
          ))}
        {t.state === "assigned" && (
          <>
            <button type="button" className={btn} onClick={() => { void onSetTask(t.sector_id, { state: "in_progress", team_id: t.team_id }); if (t.team_id) void onUpdateTeam(t.team_id, { status: "searching" }); }}>  {/* prettier-ignore */}
              Start
            </button>
            <button type="button" className={btn} onClick={() => { void onSetTask(t.sector_id, { state: "proposed", team_id: null }); if (t.team_id) void onUpdateTeam(t.team_id, { status: "standby" }); }}>  {/* prettier-ignore */}
              Unassign
            </button>
          </>
        )}
        {cardHref && (t.state === "assigned" || t.state === "in_progress") && (
          <a className={btn} href={cardHref(t.sector_id)}>
            Card
          </a>
        )}
        {t.state === "in_progress" && !podOpen && (
          <button type="button" className={btn} onClick={() => setPodOpen(true)}>
            Mark searched…
          </button>
        )}
        {t.state === "searched" && (
          <button type="button" className={btn} onClick={() => void onSetTask(t.sector_id, { state: "proposed", team_id: null })}>
            Reopen
          </button>
        )}
      </div>
      {podOpen && (
        <div className="flex flex-col gap-1.5" aria-label="POD entry" title={POD_TIP}>
          <span className="text-caption text-text-3">{POD_TIP}</span>
          <div className="flex gap-1.5">
            {[
              ["Low 30%", 0.3],
              ["Medium 50%", 0.5],
              ["High 70%", 0.7],
            ].map(([name, v]) => (
              <button key={name} type="button" className={btn} onClick={() => void searched(v as number)}>
                {name}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-caption text-text-2">
            POD
            <input type="range" min={0.05} max={0.9} step={0.05} value={pod} onChange={(e) => setPod(Number(e.target.value))} aria-label="POD" />
            <span className="font-mono">{Math.round(pod * 100)}%</span>
          </label>
          <input className="rounded-sm border border-border bg-surface-strong px-2 py-1 text-caption text-text" placeholder="One line (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
          <button type="button" className={btn} onClick={() => void searched(pod)}>
            Searched at {Math.round(pod * 100)}%
          </button>
        </div>
      )}
    </Panel>
  );
}

const STATUS_WORDS: Record<Team["status"], string> = {
  standby: "Standby",
  assigned: "Assigned",
  searching: "Searching",
  returning: "Returning",
  off_duty: "Off duty",
};

export function TeamRoster({ teams, tasks, now }: { teams: readonly Team[]; tasks: readonly SectorTask[]; now: Date }) {
  return (
    <section aria-label="Teams" className="flex flex-col gap-2">
      <Label>Teams</Label>
      <Panel className="flex flex-col divide-y divide-border p-0">
        {teams.map((t) => {
          const sector = tasks.find((x) => x.team_id === t.id && (x.state === "assigned" || x.state === "in_progress"));
          return (
            <div key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-small">
              <span className="w-28 text-text">{t.callsign}</span>
              <Badge kind="info">{STATUS_WORDS[t.status]}</Badge>
              <span className="text-text-3">{t.members} people</span>
              <span className="text-text-3">{t.position_at ? `pos ${minutesSince(t.position_at, now)} min ago` : "no position"}</span>
              {sector && <span className="text-text-2">sector {sector.sector_id}</span>}
            </div>
          );
        })}
      </Panel>
    </section>
  );
}

const KINDS: ClueDraft["kind"][] = ["object", "track", "sighting", "sound", "other"];

export function ClueLog({
  clues,
  teams,
  onAddClue,
  onPickOnMap,
}: {
  clues: readonly Clue[];
  teams: readonly Team[];
  onAddClue: CommandProps["onAddClue"];
  onPickOnMap?: CommandProps["onPickOnMap"];
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ClueDraft["kind"]>("object");
  const [text, setText] = useState("");
  const [where, setWhere] = useState<"team" | "latlon">("team");
  const [team, setTeam] = useState(teams[0]?.id ?? "");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [reliability, setReliability] = useState<ClueDraft["reliability"]>("medium");
  const field = "rounded-sm border border-border bg-surface-strong px-2 py-1 text-small text-text";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    const draft: ClueDraft = {
      kind,
      text: text.trim(),
      lat: where === "latlon" ? Number(lat) : null,
      lon: where === "latlon" ? Number(lon) : null,
      at_team_position: where === "team",
      radius_m: null,
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
        <Label>Clue log</Label>
        <button type="button" className="rounded-full border border-border px-3 py-1 text-small text-text-2" onClick={() => setOpen(!open)}>
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
            <select aria-label="Reliability" className={field} value={reliability} onChange={(e) => setReliability(e.target.value as ClueDraft["reliability"])}>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
            <button type="submit" className="rounded-full border border-accent px-3 py-1 text-small text-text">
              Add
            </button>
          </form>
        </Panel>
      )}
      {newest.length === 0 ? (
        <p className="text-small text-text-3">No clues yet.</p>
      ) : (
        <ul className="flex flex-col gap-1" aria-label="Clues">
          {newest.map((c) => (
            <li key={c.id} className="flex flex-wrap gap-3 text-small">
              <span className="font-mono text-text-3">{c.id}</span>
              <span className="text-text">{c.text}</span>
              <span className="text-text-2">
                {c.kind} · {callsign(c.reported_by)} · {c.reliability} · {c.source === "radio" ? "by radio" : "entered at command"} · {hhmm(new Date(c.at))}
              </span>
              <span className="text-text-3">{c.confirmed ? "confirmed" : "unconfirmed"}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
