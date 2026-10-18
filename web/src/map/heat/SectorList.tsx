import { Label } from "../../shell/components";
import { rankSectors, SECTOR_STATE_LABEL, sectorName, type Sector, type SectorStatus } from "./sectors";

const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;

interface Props {
  statuses: readonly SectorStatus[];
  /** Probability outside the 1 km grid (the sectors share the rest). */
  outside: number;
  currentId: string | null;
  hoverId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (sector: Sector) => void;
  layout: "flight" | "lattice";
}

/**
 * The remaining work as search sectors, most probable first: each sector's probability of area
 * (POA, its share of the total), how much of it the drone photographed, and its state. Hover
 * highlights the sector on the map; click flies there.
 */
export function SectorList({ statuses, outside, currentId, hoverId, onHover, onSelect, layout }: Props) {
  const ranked = rankSectors(statuses);
  const done = statuses.filter((s) => s.state === "searched").length;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <Label>Sectors by remaining probability</Label>
        <span className="text-small text-text-3">
          {done} of {statuses.length} searched by drone.{" "}
          {layout === "flight" ? "Numbered sectors follow the flight blocks." : "4 × 4 map reference, A1 north-west."}
        </span>
      </div>
      <ol className="flex flex-col gap-0.5" aria-label="Sectors by remaining probability" onMouseLeave={() => onHover(null)}>
        {ranked.map((s) => {
          const id = s.sector.id;
          const active = id === hoverId || id === currentId;
          return (
            <li key={id}>
              <button
                type="button"
                data-sector={id}
                onMouseEnter={() => onHover(id)}
                onFocus={() => onHover(id)}
                onBlur={() => onHover(null)}
                onClick={() => onSelect(s.sector)}
                className={`grid w-full grid-cols-[auto_1fr_auto] items-baseline gap-x-3 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-surface-strong ${
                  active ? "bg-surface-strong" : ""
                }`}
              >
                <span className={`font-mono text-small ${id === currentId ? "text-accent" : "text-text"}`}>{sectorName(s.sector)}</span>
                <span className="truncate text-label text-text-3">
                  {id === currentId ? "Drone here" : SECTOR_STATE_LABEL[s.state]} · {pct(s.coverage, 0)} photographed
                </span>
                <span className="font-mono text-small text-text-2" title="Probability of area: this sector's share of the total probability">
                  {pct(s.poa)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <span className="text-label text-text-3">
        POA = the sector&apos;s share of the probability. Outside the 1 km grid: {pct(outside)}.
      </span>
    </div>
  );
}
