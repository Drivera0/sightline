import { Label } from "../../shell/components";
import { unsureListText, UNSURE_LABEL } from "./unsure";
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
   * Flown "Unsure" answers: an entry after the candidate sightings with their count and the sectors
   * holding them (those rows are tagged too). Clicking the entry flies to the next unsure area.
   */
  unsure?: { count: number; sectors: ReadonlySet<string>; onSelect: () => void };
}

/**
 * The remaining work as search sectors, most probable first: each sector's probability of area
 * (POA, its share of the total), how much of it the drone photographed, and its state. Hover
 * highlights the sector on the map; click flies there.
 */
export function SectorList({ statuses, outside, currentId, hoverId, onHover, onSelect, layout, sighted, unsure }: Props) {
  const byPoa = rankSectors(statuses);
  // A sector with a candidate sighting goes first: a ground team checks it before anything else.
  const ranked = sighted?.size
    ? [...byPoa.filter((s) => sighted.has(s.sector.id)), ...byPoa.filter((s) => !sighted.has(s.sector.id))]
    : byPoa;
  const done = statuses.filter((s) => s.state === "searched").length;
  const sightedCount = sighted?.size ? ranked.filter((s) => sighted.has(s.sector.id)).length : 0;
  const unsureNames = unsure ? ranked.filter((s) => unsure.sectors.has(s.sector.id)).map((s) => sectorName(s.sector)) : [];
  const unsureEntry =
    unsure && unsure.count > 0 ? (
      <li key="unsure">
        <button
          type="button"
          data-unsure={unsure.count}
          onClick={unsure.onSelect}
          title={unsure.count === 1 ? "Fly to the unsure area" : "Fly to the next unsure area"}
          className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-sm px-2 py-3 text-left transition-colors lg:py-1.5 hover:bg-surface-strong"
        >
          <span aria-hidden="true" className="ml-0.5 inline-block size-3 rounded-full ring-2 ring-warn" />
          <span className="flex min-w-0 flex-col">
            <span className="text-label text-warn" data-testid="unsure-line">
              {unsureListText(unsure.count)}
            </span>
            {unsureNames.length > 0 && (
              <span className="text-label text-text-2">
                In {unsureNames.join(", ")} · held until someone answers
              </span>
            )}
          </span>
          <span className="font-mono text-small text-warn">{unsure.count}</span>
        </button>
      </li>
    ) : null;
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
        {sightedCount === 0 && unsureEntry}
        {ranked.flatMap((s, i) => {
          const id = s.sector.id;
          const active = id === hoverId || id === currentId;
          const row = (
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
                <span className={`font-mono text-small ${id === currentId ? "text-accent" : "text-text"}`}>{sectorName(s.sector)}</span>
                <span className="flex min-w-0 flex-col">
                  {sighted?.has(id) ? (
                    <span className="text-label text-ok">Candidate sighting · send ground team to check</span>
                  ) : (
                    <span className="text-label text-text-2">
                      {id === currentId ? "Drone here" : SECTOR_STATE_LABEL[s.state]} · {pct(s.coverage, 0)} photographed
                    </span>
                  )}
                  {unsure?.sectors.has(id) && <span className="text-label text-warn">{UNSURE_LABEL}</span>}
                </span>
                <span className="font-mono text-small text-text-2" title="Probability of area: this sector's share of the total probability">
                  {pct(s.poa)}
                </span>
              </button>
            </li>
          );
          // The unsure entry goes straight after the candidate sightings (first, when there are none).
          return i === sightedCount - 1 && unsureEntry ? [row, unsureEntry] : [row];
        })}
      </ol>
      <span className="text-label text-text-2">
        POA = the sector&apos;s share of the probability. It adds up every cell, so a large sector can outrank a small one
        whose cells look darker. Outside the 1 km grid: {pct(outside)}.
      </span>
    </div>
  );
}
