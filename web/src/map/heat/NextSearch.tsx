import type { MapFile } from "../../contract";
import type { MapState } from "../../search/update";
import { Label } from "../../shell/components";
import { eligibleCells } from "./coverage";
import {
  canopyLabel,
  likelyPatches,
  type LikelyPatchResult,
  probabilityShares,
} from "./geometry";
import { unsureListText } from "./unsure";

/** Two decimals, but 3 significant figures below 0.1% so tiny cell values stay distinguishable. */
const pct = (fraction: number) => {
  const percent = fraction * 100;
  return `${percent > 0 && percent < 0.1 ? percent.toPrecision(3) : percent.toFixed(2)}%`;
};

/** Compact hectares without implying more precision than a 5 m cell provides. */
function hectares(areaHa: number): string {
  return areaHa < 0.1 ? areaHa.toFixed(2) : areaHa.toFixed(1);
}

interface Props {
  map: Pick<MapFile, "grid" | "lkp" | "canopy">;
  state: MapState;
  covered: Uint8Array;
  /** Per cell, footprint overlap in cell areas (coverage.ts; the heat map uses the "max" rule). */
  overlap: Float64Array;
  /** 1 for cells awaiting review: left out of the ranking and the average. */
  held?: Uint8Array;
  /** The exact patch result also drawn on the map; omitted only by isolated component tests. */
  patchResult?: LikelyPatchResult;
  /** Sector display names indexed by the patch's `sectorIndex`. */
  sectorNames?: readonly string[];
  /** A person is confirmed: the list is for the remaining search if that is not the missing person. */
  found?: boolean;
  /** Click on a spot: fly there (`idx` is its cell, the same as the circle on the map). */
  onSelect: (lon: number, lat: number, idx: number) => void;
  /** The cell whose circle is hovered or picked (on the map or here): its row is highlighted. */
  activeIdx?: number | null;
  /** Hover or focus on a row (null on leave): the map rings its circle. */
  onHover?: (idx: number | null) => void;
  /**
   * Flown "Unsure" answers: an entry at the top of the list, before the ranked spots, with their
   * count and the sectors holding them. Clicking it flies to the next unsure area.
   */
  unsure?: { count: number; sectorNames: readonly string[]; onSelect: () => void };
}

/**
 * "Search next": connected patches of the likeliest WELL-PHOTOGRAPHED ground, and where the
 * probability sits.
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
 * the drone could not see well; the rest of the grid is the "Not yet searched" share below.
 */
export function NextSearch({
  map,
  state,
  covered,
  overlap,
  held,
  patchResult,
  sectorNames = [],
  found = false,
  onSelect,
  activeIdx = null,
  onHover,
  unsure,
}: Props) {
  const eligible = eligibleCells(overlap, held);
  const patchSet = patchResult ?? likelyPatches(map.grid, state.p, eligible, { canopy: map.canopy });
  const shares = probabilityShares(state, covered);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <Label>Search next in the surveyed area</Label>
          <span className="text-small text-text-2">
            {found
              ? "If the sighting is not your missing person, search here next"
              : "Most likely spots on ground the drone photographed well"}
          </span>
        </div>
        {unsure && unsure.count > 0 && (
          <button
            type="button"
            data-unsure={unsure.count}
            onClick={unsure.onSelect}
            title={unsure.count === 1 ? "Fly to the unsure area" : "Fly to the next unsure area"}
            // The count is in the sentence ("1 area"), so no second number on the right.
            className="grid w-full grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-3 rounded-sm border border-warn/40 px-2 py-2 text-left transition-colors hover:bg-surface-strong"
          >
            <span aria-hidden="true" className="ml-1 inline-block size-3 rounded-full ring-2 ring-warn" />
            <span className="flex min-w-0 flex-col">
              <span className="text-small text-warn" data-testid="unsure-line">
                {unsureListText(unsure.count)}
              </span>
              {unsure.sectorNames.length > 0 && (
                <span className="text-label text-text-2">In {unsure.sectorNames.join(", ")} · held until someone answers</span>
              )}
            </span>
          </button>
        )}
        {patchSet.patches.length === 0 && <p className="text-small text-text-2">No ground photographed well enough yet</p>}
        {patchSet.patches.length > 0 && (
          <span className="px-2 text-label text-text-2" aria-hidden="true" data-testid="avg-key">
            Share of the chance left in the surveyed area. Density compares each patch cell with the average photographed cell.
          </span>
        )}
        {patchSet.patches.length > 0 && (
          <ol className="flex flex-col gap-0.5" aria-label="Most likely patches" onMouseLeave={() => onHover?.(null)}>
            {patchSet.patches.map((patch, rank) => {
              const sector = patch.sectorIndex === null ? "surveyed area" : (sectorNames[patch.sectorIndex] ?? "surveyed area");
              return (
                <li key={patch.id}>
                  <button
                    type="button"
                    data-patch-id={patch.id}
                    data-active={patch.id === activeIdx ? "true" : undefined}
                    aria-current={patch.id === activeIdx ? "true" : undefined}
                    onClick={() => onSelect(patch.centroid.lon, patch.centroid.lat, patch.id)}
                    onMouseEnter={() => onHover?.(patch.id)}
                    onFocus={() => onHover?.(patch.id)}
                    onBlur={() => onHover?.(null)}
                    title={`Fly to this patch (marker ${rank + 1} on the map)`}
                    className={`grid w-full grid-cols-[1.25rem_1fr_auto] items-center gap-3 rounded-sm px-2 py-2 text-left transition-colors hover:bg-surface-strong ${
                      patch.id === activeIdx ? "bg-surface-strong ring-1 ring-accent/70" : ""
                    }`}
                  >
                    {/* The same number and fill as the circle's badge on the map. */}
                    <span className="inline-flex size-5 items-center justify-center rounded-full bg-accent font-mono text-label font-semibold text-bg">
                      {rank + 1}
                    </span>
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="text-small text-text">Area in {sector}</span>
                      <span className="text-label text-text-2 first-letter:uppercase">
                        {hectares(patch.areaHa)} ha · {canopyLabel(patch.canopy)}
                      </span>
                      <span className="font-mono text-label text-text-2">{patch.density.toFixed(1)}× avg per cell</span>
                    </span>
                    <span
                      className="flex flex-col items-end"
                      title={`This patch holds ${pct(patch.share)} of the probability left on eligible surveyed ground`}
                      data-patch-share={pct(patch.share)}
                    >
                      <span className="font-mono text-small text-text">{pct(patch.share)}</span>
                      <span className="text-label text-text-2">of surveyed chance</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        {patchSet.patches.length > 0 && (
          <span className="px-2 text-label text-text-2" data-testid="patch-remainder">
            Other surveyed ground: {pct(patchSet.otherShare)}
          </span>
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
        <p className="text-label text-text-2">
          Darkened ground on the map is not yet searched (under half of the cell photographed): it is
          unsearched, not cleared.
        </p>
      </div>
    </div>
  );
}

export const SHARE_LABELS = {
  surveyed: "Photographed by the drone",
  restOfGrid: "Not yet searched",
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
