import type { Params } from "../../contract";
import { Label } from "../../shell/components";
import { droneSvgMarkup } from "./droneImage";
import { UNSURE_LABEL } from "./unsure";
import { type FillStyle, HEAT_PALETTES, type HeatPalette, HELD_ALPHA, type LineStyle, VEIL_ALPHA } from "./palette";

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

/**
 * A class's swatch on the legend's dark panel: its colour, a little stronger than on the map (where
 * the ground under it adds to it), so the three classes stay apart on the panel too.
 */
export function swatchColor(fill: FillStyle): string {
  const alpha = Math.min(1, fill.alpha + 0.3);
  return `color-mix(in srgb, ${fill.color} ${pct(alpha)}%, transparent)`;
}

/** The three classes as CSS colours, 80–90 % first and the likeliest 50 % last (the pill's bar). */
export function classSwatches(palette: HeatPalette = HEAT_PALETTES.dark): string[] {
  return [palette.low, palette.mid, palette.top].map(swatchColor);
}

/** The mass classes, likeliest first: what each fill means (classes.ts MASS_LEVELS). */
export const CLASS_ROWS = [
  { key: "top", label: "Likeliest 50 %", hint: "The fewest cells that hold half of the estimated probability" },
  { key: "mid", label: "50 to 80 %", hint: "The next cells, up to 80 % of it" },
  { key: "low", label: "80 to 90 %", hint: "Up to 90 % of it" },
] as const;
/** The cells with no fill: never "empty", only less likely than the 90 % region. */
export const OUTSIDE_LABEL = "Outside 90 % of estimated probability";

/** A contour line's legend glyph: its colour, width and dash, on a dark casing like on the map. */
export function ContourGlyph({ line, casing, className = "" }: { line: LineStyle; casing: HeatPalette["casing"]; className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 6" className={`h-1.5 w-5 shrink-0 overflow-visible ${className}`}>
      <line x1="0" y1="3" x2="20" y2="3" stroke={casing.color} strokeOpacity={casing.opacity} strokeWidth={line.width + 2 * casing.width} />
      <line
        x1="0"
        y1="3"
        x2="20"
        y2="3"
        stroke={line.color}
        strokeWidth={line.width}
        strokeDasharray={line.dash ? line.dash.map((d) => d * line.width).join(" ") : undefined}
      />
    </svg>
  );
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

/** The search-next circle as drawn on the map: a light ring on a dark casing with an accent badge. */
function SearchNextGlyph() {
  return (
    <span aria-hidden="true" className="relative inline-block size-3.5 shrink-0">
      <span className="absolute inset-0 rounded-full border-2 border-text shadow-[0_0_0_2px_var(--bg)]" />
      <span className="absolute -right-1.5 -top-1.5 inline-flex size-2.5 items-center justify-center rounded-full bg-accent ring-1 ring-bg" />
    </span>
  );
}

interface Props {
  simulatedPath: boolean;
  hasSurveyed: boolean;
  /** The short version beside the review queue: ramp, veil and awaiting review. The simulated labels live in the map's own line (map/base/SimulatedLine). */
  compact?: boolean;
  /** With a handler, the legend shows a "Flight path (simulated)" switch. */
  showPath?: boolean;
  onShowPathChange?: (visible: boolean) => void;
  /** A candidate sighting is on the map: add its entry, and say the heat is the "none of them" plan. */
  hasSightings?: boolean;
  /** An "Unsure" area is on the map (amber ring): add its entry next to the candidate sighting. */
  hasUnsure?: boolean;
  /** With a handler (the folded legend below 1280 px), the header gets a "Hide" button. */
  onCollapse?: () => void;
  /** The palette the map is drawn in (it follows the basemap). */
  palette?: HeatPalette;
}

/** The three classes, the unshaded rest, and the two contour lines: the legend's first block. */
export function HeatClassKey({ palette, compact = false }: { palette: HeatPalette; compact?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <ul aria-label="Probability classes" className="flex flex-col gap-1.5 text-small text-text-2">
        {CLASS_ROWS.map((row) => (
          <li key={row.key} className="flex items-center gap-2.5" title={row.hint}>
            <span
              className="inline-block size-3 shrink-0 rounded-[3px] ring-1 ring-border"
              style={{ background: swatchColor(palette[row.key]) }}
              aria-hidden="true"
            />
            {row.label}
          </li>
        ))}
        <li className="flex items-center gap-2.5">
          <span className="inline-block size-3 shrink-0 rounded-[3px] ring-1 ring-border" aria-hidden="true" />
          <span className="flex flex-col">
            <span>No shading</span>
            <span className="text-label text-text-2">{OUTSIDE_LABEL}</span>
          </span>
        </li>
        <li className="flex items-center gap-2.5">
          <ContourGlyph line={palette.contour50} casing={palette.casing} />
          Edge of the likeliest 50 %
        </li>
        <li className="flex items-center gap-2.5">
          <ContourGlyph line={palette.contour90} casing={palette.casing} />
          Edge of the 90 % region
        </li>
      </ul>
      {!compact && (
        <span className="text-label text-text-2">
          Shares of the estimated probability on photographed ground, recomputed at every step and answer.
        </span>
      )}
    </div>
  );
}

export function Legend({
  simulatedPath,
  hasSurveyed,
  compact = false,
  showPath = true,
  onShowPathChange,
  onCollapse,
  hasSightings = false,
  hasUnsure = false,
  palette = HEAT_PALETTES.dark,
}: Props) {
  return (
    <div className="flex flex-col gap-3">
      {!compact &&
        (onCollapse ? (
          <div className="flex items-center justify-between gap-2">
            <Label>Reading the map</Label>
            <button
              type="button"
              aria-expanded={true}
              aria-controls="search-legend"
              onClick={onCollapse}
              // Opened from the pill: focus moves here so the keyboard user lands in the legend.
              autoFocus
              className="-my-1 min-h-8 rounded-sm px-2 text-small text-text-2 hover:text-text"
            >
              Hide
            </button>
          </div>
        ) : (
          <Label>Reading the map</Label>
        ))}
      <HeatClassKey palette={palette} compact={compact} />
      {hasSightings && (
        <span className="text-label text-text-2">
          With a sighting on the map, the shading is the plan if none of the sightings is the missing person.
        </span>
      )}
      <ul className="flex flex-col gap-2 text-small text-text-2">
        {!compact && (
          <li className="flex items-center gap-2.5">
            <SearchNextGlyph />
            <span className="flex flex-col">
              <span>Search next</span>
              <span className="text-label text-text-2">Numbered as in the list; 1 is the likeliest</span>
            </span>
          </li>
        )}
        {hasSightings && (
          <li className="flex items-center gap-2.5">
            <span
              className="inline-block size-3 rounded-[3px] ring-2 ring-ok"
              style={{ background: swatchColor(palette.top) }}
              aria-hidden="true"
            />
            <span className="flex flex-col">
              <span>Candidate sighting</span>
              {!compact && <span className="text-label text-text-2">A person is there; maybe not the missing one</span>}
            </span>
          </li>
        )}
        {hasUnsure && (
          <li className="flex items-center gap-2.5">
            <span
              className="inline-block size-3 rounded-[3px] ring-2 ring-warn"
              style={{ background: REVIEW_FILL }}
              aria-hidden="true"
            />
            <span className="flex flex-col">
              <span>{UNSURE_LABEL}</span>
              {!compact && <span className="text-label text-text-2">The reviewer couldn&apos;t call it; held, map unchanged</span>}
            </span>
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
            {!compact && <span className="text-label text-text-2">Under half of the cell photographed</span>}
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
      </ul>
      {!compact && (
        // The line symbols are folded away so the legend stays short; the colours above are always shown.
        <details className="group text-small text-text-2">
          <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between gap-2 rounded-sm text-text-2 hover:text-text [&::-webkit-details-marker]:hidden">
            <span>Lines and markers</span>
            <span aria-hidden="true" className="text-text-3 transition-transform group-open:rotate-90">
              ›
            </span>
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            <li className="flex items-center gap-2.5">
              <span
                aria-hidden="true"
                className="ml-0.5 inline-block size-2.5 rotate-45 bg-text shadow-[0_0_0_2px_var(--bg)]"
              />
              {/* The same words as the map label (base/features.ts buildLkpFeature). */}
              {simulatedPath ? "Last known point" : "Survey centre"}
            </li>
            <li className="flex items-center gap-2.5">
              <span className="inline-block h-0 w-5 border-t border-text/60" aria-hidden="true" />
              {hasSurveyed ? "Surveyed area (outline)" : "No cell photographed yet"}
            </li>
            <li className="flex items-center gap-2.5">
              <span className="inline-block h-0 w-5 border-t border-text/30" aria-hidden="true" />
              <span className="flex flex-col">
                <span>Search sectors</span>
                <span className="text-label text-text-2">Orange: the sector the drone is in</span>
              </span>
            </li>
            <li className="flex items-center gap-2.5">
              <DroneGlyph />
              <span className="flex flex-col">
                <span>Drone, during replay</span>
                <span className="text-label text-text-2">Orange box: the photo it is taking</span>
              </span>
            </li>
          </ul>
        </details>
      )}
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
    </div>
  );
}
