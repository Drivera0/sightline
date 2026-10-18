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
 * left out of both: they have pod 0 until a searcher decides. The shares below use `covered`, which
 * follows the same MIN_OVERLAP rule (the area photographed well enough so far).
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
  const topP = top.length > 0 ? (state.p[top[0] as number] as number) : 0;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <Label>Search next in the surveyed area</Label>
          <span className="text-small text-text-3">Most likely spots on ground the drone photographed well</span>
        </div>
        {top.length === 0 && <p className="text-small text-text-2">No cell photographed well enough yet</p>}
        {top.length > 0 && (
          <ol className="flex flex-col gap-0.5" aria-label="Most likely cells">
            {top.map((idx, rank) => {
              const c = cellCenter(map.grid, idx);
              const dist = distanceM(map.lkp.lat, map.lkp.lon, c.lat, c.lon);
              const p = state.p[idx] as number;
              return (
                <li key={idx}>
                  <button
                    type="button"
                    data-idx={idx}
                    onClick={() => onSelect(c.lon, c.lat)}
                    title="Fly to this cell"
                    className="grid w-full grid-cols-[1.25rem_1fr_auto] items-center gap-3 rounded-sm px-2 py-2 text-left transition-colors hover:bg-surface-strong"
                  >
                    <span
                      className={
                        "inline-flex size-5 items-center justify-center rounded-full font-mono text-label " +
                        (rank === 0 ? "bg-accent text-bg" : "bg-surface-strong text-text-2")
                      }
                    >
                      {rank + 1}
                    </span>
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="text-small text-text first-letter:uppercase">{canopyLabel(map.canopy[idx])}</span>
                      <span className="h-0.5 w-full overflow-hidden rounded-full bg-surface-strong">
                        <span
                          className="block h-full rounded-full bg-accent transition-[width] duration-300"
                          style={{ width: `${topP > 0 ? Math.round((p / topP) * 100) : 0}%` }}
                        />
                      </span>
                      <span className="font-mono text-label text-text-3">{Math.round(dist)} m from LKP</span>
                    </span>
                    <span className="flex flex-col items-end">
                      <span className="font-mono text-small text-text">{pct(p)}</span>
                      {mean > 0 && (
                        <span
                          className="font-mono text-label text-text-3"
                          title="Compared with the average well-photographed cell"
                        >
                          {(p / mean).toFixed(1)}× avg
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
      <div className="flex flex-col gap-2.5" aria-label="Where the probability is">
        <Label>Where the person could be</Label>
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-strong" aria-hidden="true">
          <span className="h-full bg-accent transition-[width] duration-300" style={{ width: `${shares.surveyed * 100}%` }} />
          <span className="h-full bg-text-3 transition-[width] duration-300" style={{ width: `${shares.restOfGrid * 100}%` }} />
          <span className="h-full bg-text-3/30 transition-[width] duration-300" style={{ width: `${shares.outside * 100}%` }} />
        </div>
        <ShareRow label={SHARE_LABELS.surveyed} swatch="bg-accent" value={shares.surveyed} />
        <ShareRow label={SHARE_LABELS.restOfGrid} swatch="bg-text-3" value={shares.restOfGrid} />
        <ShareRow label={SHARE_LABELS.outside} swatch="bg-text-3/30" value={shares.outside} />
        <p className="text-label text-text-3">
          Dark ground on the map has not been photographed yet: it is unsearched, not cleared.
        </p>
      </div>
    </div>
  );
}

export const SHARE_LABELS = {
  surveyed: "Inside surveyed area",
  restOfGrid: "Not yet searched (rest of grid)",
  outside: "Beyond the search grid",
} as const;

function ShareRow({ label, swatch, value }: { label: string; swatch: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-3 text-small">
      <span className="flex items-center gap-2 text-text-2">
        <span aria-hidden="true" className={`size-2 rounded-full ${swatch}`} />
        {label}
      </span>
      <span className="font-mono text-text" data-share={label}>
        {pct(value)}
      </span>
    </div>
  );
}
