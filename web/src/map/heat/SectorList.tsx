import { Label } from "../../shell/components";
import { UNSURE_LABEL } from "./unsure";
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
  /** Sectors holding a candidate sighting: listed first, with a ground-team label. */
  sighted?: ReadonlySet<string>;
  /**
   * Sectors holding a flown "Unsure" answer: tagged in their row. The entry that counts them and flies
   * to them leads the Search next list (NextSearch), so it is not repeated here.
   */
  unsureSectors?: ReadonlySet<string>;
}

/**
 * The remaining work as search sectors, most probable first: each sector's probability of area
 * (POA, its share of the total), how much of it the drone photographed, and its state. Hover
 * highlights the sector on the map; click flies there.
 */
export function SectorList({ statuses, outside, currentId, hoverId, onHover, onSelect, layout, sighted, unsureSectors }: Props) {
  const byPoa = rankSectors(statuses);
  // A sector with a candidate sighting goes first: a ground team checks it before anything else.
  const ranked = sighted?.size
    ? [...byPoa.filter((s) => sighted.has(s.sector.id)), ...byPoa.filter((s) => !sighted.has(s.sector.id))]
    : byPoa;
  const done = statuses.filter((s) => s.state === "searched").length;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <Label>Sectors by remaining probability</Label>
        <span className="text-small text-text-2">
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
                className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 rounded-sm px-2 py-3 text-left transition-colors lg:py-1.5 hover:bg-surface-strong ${
                  active ? "bg-surface-strong" : ""
                }`}
              >
                <span className={`text-small ${id === currentId ? "text-accent" : "text-text"}`}>{sectorName(s.sector)}</span>
                <span className="flex min-w-0 flex-col">
                  {sighted?.has(id) ? (
                    <span className="text-label text-ok">Candidate sighting · send ground team to check</span>
                  ) : (
                    <span className="text-label text-text-2">
                      {id === currentId ? "Drone here" : SECTOR_STATE_LABEL[s.state]} · {pct(s.coverage, 0)} photographed
                    </span>
                  )}
                  {unsureSectors?.has(id) && <span className="text-label text-warn">{UNSURE_LABEL}</span>}
                </span>
                <span className="text-small text-text-2" title="Probability of area: this sector's share of the total probability">
                  {pct(s.poa)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <span className="text-label text-text-2">
        POA = the sector&apos;s share of the probability. It adds up every cell, so a large sector can outrank a small one
        whose cells look darker. Outside the 1 km grid: {pct(outside)}.
      </span>
    </div>
  );
}
