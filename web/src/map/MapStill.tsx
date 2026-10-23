// The map's still stand-in on phones and slower devices: MapLibre's start-up (its WebGL context, shader
// compiles and first frames) is the heaviest work on the console, over a second of blocking time on a
// throttled phone. Until the visitor touches the map, or the story reaches a moment that needs it moving,
// the console shows a picture of it instead: the demo map at the call, or a plain basemap crop on a live
// mission. Same box as the map, so nothing moves when it loads. Built by lane A.

import type { ReactNode } from "react";

/** The pictures (web/public/map/): the demo map at t0, phone and wide, and a neutral basemap crop. */
export const STILL = {
  demoPhone: "/map/demo-t0-390.webp",
  demoWide: "/map/demo-t0-1440.webp",
  basemap: "/map/basemap-still.webp",
} as const;

/**
 * Whether this device gets the still map first: a screen under 1024 px, a touch device with four cores or
 * fewer, or a viewer who asked for less data. False where the browser cannot tell (tests, no matchMedia).
 */
export function wantsStillMap(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 0;
  const saveData = typeof navigator !== "undefined" && !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
  // a fine pointer at 1024 px and up (a laptop, a desktop) always gets the live map, whatever its cores
  const small = window.matchMedia("(max-width: 1023.98px)").matches;
  const slowTouch = window.matchMedia("(pointer: coarse)").matches && cores > 0 && cores <= 4;
  return small || slowTouch || window.matchMedia("(prefers-reduced-data: reduce)").matches || saveData;
}

/**
 * The still map: fills the map's box (the same frame, border and minimum height), with one button over all
 * of it, so a tap anywhere, or Enter on the button, loads the live map.
 */
export function MapStill({ demo, loading = false, onLoad }: { demo: boolean; loading?: boolean; onLoad: () => void }): ReactNode {
  return (
    <div data-testid="map-still" className="relative h-full min-h-[360px] overflow-hidden rounded-lg border border-border bg-surface-solid">
      {demo ? (
        <picture>
          <source media="(min-width: 1024px)" srcSet={STILL.demoWide} />
          <img
            src={STILL.demoPhone}
            alt="Still image of the demo map at the call: the search sectors around the last known point."
            className="absolute inset-0 h-full w-full object-cover"
            decoding="async"
            fetchPriority="high"
          />
        </picture>
      ) : (
        <img src={STILL.basemap} alt="" className="absolute inset-0 h-full w-full object-cover opacity-70" decoding="async" />
      )}
      <button
        type="button"
        onClick={onLoad}
        // a touch on the map starts it loading before the tap ends
        onPointerDown={(e) => e.pointerType === "touch" && onLoad()}
        aria-busy={loading || undefined}
        className="absolute inset-0 bg-transparent focus-visible:outline-offset-[-4px]"
      >
        {/* under the last known point, above the scrubber */}
        <span className="absolute left-1/2 top-[62%] -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border border-border bg-bg/85 px-4 py-2 text-body text-text shadow-[var(--shadow-pop)]">{loading ? "Loading the map…" : "Tap to load the map"}</span>
      </button>
      {demo && <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-bg/80 px-2 py-0.5 text-caption text-text-2">Still image · at the call</span>}
    </div>
  );
}
