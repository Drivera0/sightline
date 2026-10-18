import type { MapFile } from "../../contract";
import type { MapState } from "../../search/update";
import { Label } from "../../shell/components";
import { eligibleCells } from "./coverage";
import {
  canopyLabel,
  cellCenter,
  distanceM,
  probabilityShares,
  topCellIndices,
} from "./geometry";

/** Two decimals, but 3 significant figures below 0.1% so tiny cell values stay distinguishable. */
const pct = (fraction: number) => {
  const percent = fraction * 100;
  return `${percent > 0 && percent < 0.1 ? percent.toPrecision(3) : percent.toFixed(2)}%`;
};

/** Mean probability over the eligible cells (0 when there are none). */
function eligibleMean(p: ArrayLike<number>, eligible: Uint8Array): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < eligible.length; i++) {
    if (eligible[i]) {
      sum += p[i] ?? 0;
      n++;
    }
  }
  return n ? sum / n : 0;
}

interface Props {
  map: Pick<MapFile, "grid" | "lkp" | "canopy">;
  state: MapState;
  covered: Uint8Array;
  /** Per cell, summed footprint overlap in cell areas (coverage.ts). */
  overlap: Float64Array;
  /** 1 for cells awaiting review: left out of the ranking and the average. */
  held?: Uint8Array;
  onSelect: (lon: number, lat: number) => void;
}

/**
 * "Search next": the 5 most likely WELL-PHOTOGRAPHED cells now, and where the probability sits.
 *
 * Only cells the footprints covered at least MIN_OVERLAP times are ranked ("eligible"), so edge
 * slivers the camera barely touched do not fill the list. The "× avg" average is over the same
 * eligible cells. Cells awaiting review (a candidate detection not yet answered "Not a person") are
 * left out of both: they have pod 0 until a searcher decides. The shares below still use `covered`
 * (the area photographed so far).
 *
 * Only photographed cells are ranked. Inside a 1 km grid a hiker prior is flat (Koester's hiker
 * distances are larger than the grid), so every unphotographed cell would outrank every
 * photographed one and the list would show the grid corners. Ranking the surveyed area shows where
 * the drone could not see well; the rest of the grid is the "Rest of grid" share below.
 */
export function NextSearch({ map, state, covered, overlap, held, onSelect }: Props) {
  const eligible = eligibleCells(overlap, held);
  const top = topCellIndices(state.p, 5, eligible);
  const shares = probabilityShares(state, covered);
  const mean = eligibleMean(state.p, eligible);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label>Search next in the surveyed area</Label>
        {top.length === 0 && <p className="text-small text-text-2">No cell photographed well enough yet</p>}
        {top.length > 0 && (
        <ol className="flex flex-col gap-1" aria-label="Most likely cells">
          {top.map((idx, rank) => {
            const c = cellCenter(map.grid, idx);
            const dist = distanceM(map.lkp.lat, map.lkp.lon, c.lat, c.lon);
            return (
              <li key={idx}>
                <button
                  type="button"
                  data-idx={idx}
                  onClick={() => onSelect(c.lon, c.lat)}
                  className="grid w-full grid-cols-[1.5rem_1fr_auto] items-baseline gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-surface-strong"
                >
                  <span className="font-mono text-small text-text-3">{rank + 1}</span>
                  <span className="flex flex-col">
                    <span className="text-small text-text">{canopyLabel(map.canopy[idx])}</span>
                    <span className="font-mono text-label text-text-3">
                      {Math.round(dist)} m from LKP
                    </span>
                  </span>
                  <span className="flex flex-col items-end">
                    <span className="font-mono text-small text-accent-soft">
                      {pct(state.p[idx] as number)}
                    </span>
                    {mean > 0 && (
                      <span className="font-mono text-label text-text-3" title="Compared with the average well-photographed cell">
                        {((state.p[idx] as number) / mean).toFixed(1)}× avg
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        )}
      </div>
      <div className="flex flex-col gap-1.5" aria-label="Where the probability is">
        <Label>Where the probability is</Label>
        <ShareRow label="Inside surveyed area" value={shares.surveyed} />
        <ShareRow label="Rest of grid" value={shares.restOfGrid} />
        <ShareRow label="Outside the grid" value={shares.outside} />
      </div>
    </div>
  );
}

function ShareRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-small">
      <span className="text-text-2">{label}</span>
      <span className="font-mono text-text" data-share={label}>
        {pct(value)}
      </span>
    </div>
  );
}
