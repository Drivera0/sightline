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

const RAMP = `linear-gradient(to right, transparent, color-mix(in srgb, var(--accent) ${Math.round(
  MAX_OPACITY * 100,
)}%, transparent))`;

interface Props {
  simulatedPath: boolean;
  params: Pick<Params, "prior_source">;
  manifest: Pick<Manifest, "notes">;
  hasSurveyed: boolean;
}

export function Legend({ simulatedPath, params, manifest, hasSurveyed }: Props) {
  const placeholder = showsPlaceholderPrior(params.prior_source, manifest.notes);
  return (
    <div className="flex flex-col gap-3">
      <Label>Where the person could be</Label>
      <div className="flex flex-col gap-1">
        <div className="h-3 w-full rounded-sm border border-border" style={{ background: RAMP }} />
        <div className="flex justify-between text-label text-text-2">
          <span>Less likely</span>
          <span aria-hidden="true">→</span>
          <span>More likely</span>
        </div>
      </div>
      <div className="flex items-center gap-2 text-small text-text-2">
        <span className="inline-block h-0 w-6 border-t-2 border-text" aria-hidden="true" />
        {hasSurveyed ? "Surveyed area (outline)" : "No cell photographed yet"}
      </div>
      {(simulatedPath || placeholder) && (
        <div className="flex flex-wrap gap-2">
          {simulatedPath && <Badge kind="simulated">Simulated flight path</Badge>}
          {placeholder && <Badge kind="placeholder">Placeholder prior</Badge>}
        </div>
      )}
    </div>
  );
}
