import type { Manifest } from "../../contract";
import { Badge, Label } from "../../shell/components";
import { MAX_OPACITY } from "./geometry";

/**
 * TEMPORARY: map.json has no field saying the prior is a placeholder, so read the manifest
 * notes. Matches "placeholder … prior" inside one clause (e.g. "placeholder prior",
 * "placeholder uniform prior") or "uniform prior" (the placeholder of LANE_C_SEARCH §3.2),
 * case-insensitive. Replace with a contract field when one exists.
 */
export function isPlaceholderPrior(notes: string): boolean {
  return /placeholder[^.;]*\bprior\b|\buniform prior\b/i.test(notes);
}

const RAMP = `linear-gradient(to right, transparent, color-mix(in srgb, var(--accent) ${Math.round(
  MAX_OPACITY * 100,
)}%, transparent))`;

interface Props {
  simulatedPath: boolean;
  manifest: Pick<Manifest, "notes">;
  hasSurveyed: boolean;
}

export function Legend({ simulatedPath, manifest, hasSurveyed }: Props) {
  const placeholder = isPlaceholderPrior(manifest.notes);
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
