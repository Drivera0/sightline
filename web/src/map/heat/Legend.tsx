import type { Manifest, Params } from "../../contract";
import { Badge, Label } from "../../shell/components";
import { MAX_OPACITY } from "./geometry";

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

// Matches the map: warm and faint for "some chance", full accent for the most likely cell.
const RAMP = `linear-gradient(to right, color-mix(in srgb, var(--warn) 8%, transparent), color-mix(in srgb, var(--accent) ${Math.round(
  MAX_OPACITY * 100,
)}%, transparent))`;

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
      <Label>Reading the map</Label>
      <div className="flex flex-col gap-1.5">
        <div className="h-2 w-full rounded-full" style={{ background: RAMP }} />
        <div className="flex justify-between text-label text-text-2">
          <span>Less likely</span>
          <span>More likely</span>
        </div>
      </div>
      <ul className="flex flex-col gap-2 text-small text-text-2">
        <li className="flex items-center gap-2.5">
          <span className="inline-block h-0 w-5 border-t border-text/60" aria-hidden="true" />
          {hasSurveyed ? "Photographed area" : "No cell photographed yet"}
        </li>
        <li className="flex items-center gap-2.5">
          <span className="inline-block size-3 rounded-[3px] bg-bg/80 ring-1 ring-border" aria-hidden="true" />
          Not photographed: unsearched
        </li>
        <li className="flex items-center gap-2.5">
          <span className="relative inline-flex w-5 items-center" aria-hidden="true">
            <span className="h-0.5 w-full rounded-full bg-text/80" />
            <span className="absolute right-0 size-2 rounded-full bg-text ring-2 ring-bg" />
          </span>
          Drone, during replay
        </li>
      </ul>
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
