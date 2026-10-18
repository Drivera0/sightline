import type { MapFile } from "../../contract";
import type { MapState } from "../../search/update";
import { Label } from "../../shell/components";
import {
  canopyLabel,
  cellCenter,
  distanceM,
  probabilityShares,
  topCellIndices,
} from "./geometry";

const pct = (fraction: number) => `${(fraction * 100).toFixed(2)}%`;

interface Props {
  map: Pick<MapFile, "grid" | "lkp" | "canopy">;
  state: MapState;
  covered: Uint8Array;
  onSelect: (lon: number, lat: number) => void;
}

/** "Search next": the 5 most likely cells now, and where the probability sits. */
export function NextSearch({ map, state, covered, onSelect }: Props) {
  const top = topCellIndices(state.p, 5);
  const shares = probabilityShares(state, covered);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label>Search next</Label>
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
                  <span className="font-mono text-small text-accent-soft">
                    {pct(state.p[idx] as number)}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
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
