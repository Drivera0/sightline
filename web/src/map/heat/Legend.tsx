import type { Manifest, Params } from "../../contract";
import { Badge, Label } from "../../shell/components";
import { HEAT_CEIL, HEAT_FLOOR } from "./geometry";
import { REVIEW_OPACITY, UNSEARCHED_OPACITY } from "./layers";

/** Contract 1.1 §8: the value of `map.params.prior_source` when the pipeline used the placeholder prior. */
export const PRIOR_FROM_PLACEHOLDER = "placeholder";

/**
 * Fallback for 1.0 caches, which have no `prior_source`: read the manifest notes. Matches
 * "placeholder … prior" inside one clause (e.g. "placeholder prior", "placeholder uniform
 * prior") or "uniform prior" (the placeholder of LANE_C_SEARCH §3.2), case-insensitive.
 */
export function isPlaceholderPrior(notes: string): boolean {
  return /placeholder[^.;]*\bprior\b|\buniform prior\b/i.test(notes);
}

/**
 * Show the "Placeholder prior" badge? `prior_source` (contract 1.1) decides when it is set:
 * "placeholder" → yes, any other string (a citation) → no, even if the notes mention a
 * placeholder, because the field is the exact statement and the notes are free text. Only
 * when it is null or missing (a 1.0 cache) do the manifest notes decide.
 */
export function showsPlaceholderPrior(priorSource: Params["prior_source"], notes: string): boolean {
  if (priorSource !== undefined && priorSource !== null) return priorSource === PRIOR_FROM_PLACEHOLDER;
  return isPlaceholderPrior(notes);
}

const pct = (x: number) => Math.round(x * 100);
const RAMP = `linear-gradient(to right, color-mix(in srgb, var(--accent) ${pct(HEAT_FLOOR)}%, transparent), color-mix(in srgb, var(--accent) ${pct(
  HEAT_CEIL,
)}%, transparent))`;
const UNSEARCHED_FILL = `color-mix(in srgb, var(--bg) ${pct(UNSEARCHED_OPACITY)}%, transparent)`;
const REVIEW_FILL = `color-mix(in srgb, var(--warn) ${pct(REVIEW_OPACITY)}%, transparent)`;

interface Props {
  simulatedPath: boolean;
  params: Pick<Params, "prior_source">;
  manifest: Pick<Manifest, "notes">;
  hasSurveyed: boolean;
  /** With a handler, the legend shows a "Flight path (simulated)" switch. */
  showPath?: boolean;
  onShowPathChange?: (visible: boolean) => void;
}

export function Legend({ simulatedPath, params, manifest, hasSurveyed, showPath = true, onShowPathChange }: Props) {
  const placeholder = showsPlaceholderPrior(params.prior_source, manifest.notes);
  return (
    <div className="flex flex-col gap-3">
      <Label>Where the person could be</Label>
      <div className="flex flex-col gap-1">
        <div className="h-2 w-full rounded-full" style={{ background: RAMP }} />
        <div className="flex justify-between text-label text-text-2">
          <span>Less likely</span>
          <span>More likely</span>
        </div>
        <span className="text-label text-text-3">Inside the surveyed area, relative to the other surveyed cells</span>
      </div>
      <div className="flex items-center gap-2 text-small text-text-2">
        <span
          className="inline-block h-3 w-6 rounded-[4px] ring-1 ring-border"
          style={{ background: UNSEARCHED_FILL }}
          aria-hidden="true"
        />
        Not yet searched
      </div>
      <div className="flex items-center gap-2 text-small text-text-2">
        <span
          className="inline-block h-3 w-6 rounded-[4px] ring-1 ring-border"
          style={{ background: REVIEW_FILL }}
          aria-hidden="true"
        />
        Awaiting review
      </div>
      <div className="flex items-center gap-2 text-small text-text-2">
        <span className="inline-block h-0 w-6 border-t border-text/60" aria-hidden="true" />
        {hasSurveyed ? "Surveyed area (outline)" : "No cell photographed yet"}
      </div>
      <div className="flex items-center gap-2 text-small text-text-2">
        <span className="relative inline-flex w-6 items-center" aria-hidden="true">
          <span className="h-0.5 w-full rounded-full bg-text/80" />
          <span className="absolute right-0 size-2 rounded-full bg-text ring-2 ring-bg" />
        </span>
        Drone, during replay
      </div>
      {onShowPathChange && (
        <label className="flex cursor-pointer items-center justify-between gap-3 border-t border-border pt-3 text-small text-text-2">
          <span>Flight path{simulatedPath ? " (simulated)" : ""}</span>
          <span className="relative inline-flex">
            <input
              type="checkbox"
              role="switch"
              checked={showPath}
              onChange={(e) => onShowPathChange(e.target.checked)}
              className="peer sr-only"
            />
            <span
              aria-hidden="true"
              className="h-5 w-9 rounded-full bg-surface-strong ring-1 ring-border transition-colors peer-checked:bg-accent peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-accent"
            />
            <span
              aria-hidden="true"
              className="absolute left-0.5 top-0.5 size-4 rounded-full bg-text shadow transition-transform peer-checked:translate-x-4"
            />
          </span>
        </label>
      )}
      {(simulatedPath || placeholder) && (
        <div className="flex flex-wrap gap-2">
          {simulatedPath && <Badge kind="simulated">Simulated flight path</Badge>}
          {placeholder && <Badge kind="placeholder">Placeholder prior</Badge>}
        </div>
      )}
    </div>
  );
}
