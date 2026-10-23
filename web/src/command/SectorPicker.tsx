// Task (V3 §3): a team's or a drone's Task button opens this list under its card: the sectors by POA, the
// agent's pick for it first (its pending proposal, labelled), each one tap to assign; or click a sector on
// the map (Task mode stays on while the list is open), or drag the card onto one. Esc closes. Built by lane A.
import { useEffect, useRef, useState } from "react";
import type { Proposal, SectorTask } from "../contract";
import type { SectorNow } from "../lib/api";

const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)} %`;
const STATE: Record<SectorTask["state"], string> = { proposed: "open", assigned: "assigned", in_progress: "being searched", searched: "searched" };

export interface PickRow {
  sector: string;
  label: string;
  poa: number;
  state: string;
  /** The agent proposes this sector for this team or drone. */
  pick: boolean;
}

/**
 * The rows, the agent's pick first, then by POA (the likeliest first); a sector this team already has, or one
 * searched, goes to the end of the list.
 */
export function pickRows(kind: "team" | "drone", id: string, sectors: readonly SectorNow[], tasks: readonly SectorTask[], proposals: readonly Proposal[]): PickRow[] {
  const mine = proposals.find(
    (p) =>
      p.status === "pending" &&
      (kind === "team" ? p.kind === "assign_sector" && (p.edits?.team ?? p.target.team) === id : (p.kind === "drone_leg" || p.kind === "retask_drone") && (p.target.drone ?? p.leg?.drone_id) === id),
  );
  const pickSector = mine ? (mine.target.sector ?? mine.leg?.sector_id ?? null) : null;
  const rows = sectors.map((s) => {
    const t = tasks.find((x) => x.sector_id === s.sector_id);
    return { sector: s.sector_id, label: s.label, poa: s.poa, state: t ? STATE[t.state] : "open", pick: s.sector_id === pickSector, late: !!t && (t.state === "searched" || (kind === "team" && t.team_id === id)) };
  });
  rows.sort((a, b) => Number(b.pick) - Number(a.pick) || Number(a.late) - Number(b.late) || b.poa - a.poa);
  return rows.map(({ late: _late, ...r }) => r);
}

export function SectorPicker({
  kind,
  id,
  name,
  sectors,
  tasks,
  proposals,
  onPick,
  onClose,
  max = 6,
}: {
  kind: "team" | "drone";
  id: string;
  name: string;
  sectors: readonly SectorNow[];
  tasks: readonly SectorTask[];
  proposals: readonly Proposal[];
  onPick: (sector: string) => void;
  onClose: () => void;
  /** Rows shown before "Show N more". */
  max?: number;
}) {
  const rows = pickRows(kind, id, sectors, tasks, proposals);
  const box = useRef<HTMLDivElement>(null);
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, max);
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>("button[data-sector]")?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div ref={box} role="group" aria-label={`Task ${name}`} className="sl-slide-in flex flex-col gap-1 rounded-md border border-border bg-surface-solid p-1.5">
      <p className="px-1 text-caption text-text-3">Send {name} to… (or click a sector on the map)</p>
      <ul className="flex flex-col">
        {shown.map((r) => (
          <li key={r.sector}>
            <button
              type="button"
              data-sector={r.sector}
              onClick={() => onPick(r.sector)}
              className={`sl-tap flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-small hover:bg-surface-strong ${r.pick ? "shadow-[inset_2px_0_0_var(--c-proposal)]" : ""}`}
            >
              <span className="w-8 font-medium text-text">{r.sector}</span>
              <span className="sl-num w-12 text-text">{pct(r.poa)}</span>
              <span className="min-w-0 flex-1 truncate text-caption text-text-3">{r.state}</span>
              {r.pick && <span className="shrink-0 rounded-full bg-[color-mix(in_srgb,var(--c-proposal)_18%,transparent)] px-1.5 text-caption text-[var(--c-proposal)]">Agent's pick</span>}
            </button>
          </li>
        ))}
      </ul>
      <span className="flex items-center gap-2 px-1">
        {rows.length > max && (
          <button type="button" onClick={() => setAll(!all)} className="sl-tap text-caption text-text-2 underline underline-offset-2 hover:text-text">
            {all ? "Show fewer" : `Show ${rows.length - max} more`}
          </button>
        )}
        <button type="button" onClick={onClose} className="sl-tap ml-auto text-caption text-text-3 hover:text-text">
          Cancel
        </button>
      </span>
    </div>
  );
}

