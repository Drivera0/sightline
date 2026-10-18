import type { Manifest, Params } from "../../contract";
import { Badge, Label } from "../../shell/components";
import { droneSvgMarkup } from "./droneImage";
import { HELD_ALPHA, heatColor, paletteFromTokens, readRasterTokens, VEIL_ALPHA } from "./raster";

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

/** The map's own ramp as a CSS gradient: the same OKLab-built colours and opacities as the raster, light (lower) to dark (higher). */
export function rampGradient(): string {
  const palette = paletteFromTokens(typeof document === "undefined" ? { bg: "", text: "", accent: "", accentSoft: "" } : readRasterTokens());
  const stops = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1].map((t) => {
    const [r, g, b, a] = heatColor(palette, t);
    return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)}) ${pct(t)}%`;
  });
  return `linear-gradient(to right, ${stops.join(", ")})`;
}
const UNSEEN_FILL = `color-mix(in srgb, var(--bg) ${pct(VEIL_ALPHA)}%, transparent)`;
const REVIEW_FILL = `color-mix(in srgb, var(--text) ${pct(HELD_ALPHA)}%, transparent)`;

/** Dan's drone icon, the same drawing as the replay marker on the map. */
export function DroneGlyph({ className = "size-5" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block text-text [&>svg]:h-full [&>svg]:w-full ${className}`}
      // A local, static SVG file from this repo (no user content).
      dangerouslySetInnerHTML={{ __html: droneSvgMarkup() }}
    />
  );
}

interface Props {
  simulatedPath: boolean;
  params: Pick<Params, "prior_source">;
  manifest: Pick<Manifest, "notes">;
  hasSurveyed: boolean;
  /** The short version beside the review queue: ramp, veil, awaiting review and the badges. */
  compact?: boolean;
  /** With a handler, the legend shows a "Flight path (simulated)" switch. */
  showPath?: boolean;
  onShowPathChange?: (visible: boolean) => void;
}

export function Legend({ simulatedPath, params, manifest, hasSurveyed, compact = false, showPath = true, onShowPathChange }: Props) {
  const placeholder = showsPlaceholderPrior(params.prior_source, manifest.notes);
  const ramp = rampGradient();
  return (
    <div className="flex flex-col gap-3">
      {!compact && <Label>Reading the map</Label>}
      <div className="flex flex-col gap-1.5">
        <div className="h-2 w-full rounded-full" style={{ background: ramp }} />
        <div className="flex justify-between text-label text-text-2">
          <span>Lower probability</span>
          <span>Higher probability</span>
        </div>
        {!compact && (
          <span className="text-label text-text-3">Inside the surveyed area, relative to the other surveyed cells</span>
        )}
      </div>
      <ul className="flex flex-col gap-2 text-small text-text-2">
        {!compact && (
          <li className="flex items-center gap-2.5">
            <span className="inline-block h-0 w-5 border-t border-text/60" aria-hidden="true" />
            {hasSurveyed ? "Surveyed area (outline)" : "No cell photographed yet"}
          </li>
        )}
        <li className="flex items-center gap-2.5">
          <span
            className="inline-block size-3 rounded-[3px] ring-1 ring-border"
            style={{ background: UNSEEN_FILL }}
            aria-hidden="true"
          />
          <span className="flex flex-col">
            <span>Not yet searched</span>
            {!compact && <span className="text-label text-text-3">Under half of the cell photographed</span>}
          </span>
        </li>
        <li className="flex items-center gap-2.5">
          <span
            className="inline-block size-3 rounded-[3px] border border-dashed border-warn"
            style={{ background: REVIEW_FILL }}
            aria-hidden="true"
          />
          Awaiting review
        </li>
        {!compact && (
          <li className="flex items-center gap-2.5">
            <span className="inline-block h-0 w-5 border-t border-text/30" aria-hidden="true" />
            <span className="flex flex-col">
              <span>Search sectors</span>
              <span className="text-label text-text-3">Orange: the sector the drone is in</span>
            </span>
          </li>
        )}
        {!compact && (
          <li className="flex items-center gap-2.5">
            <DroneGlyph />
            <span className="flex flex-col">
              <span>Drone, during replay</span>
              <span className="text-label text-text-3">Orange box: the photo it is taking</span>
            </span>
          </li>
        )}
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
