import { useState } from "react";
import type { Detection } from "../../contract";
import { Badge } from "../../shell/components";

type Find = Pick<Detection, "id" | "lat" | "lon" | "radius_m">;

/** Finds listed before "Show all": keeps the Search next list in view. */
export const FINDS_SHOWN = 3;

/** "f0336-d01" → "f0336": the photo a detection came from. */
export function photoOf(id: string): string {
  return id.split("-")[0] ?? id;
}

/**
 * Shown while one or more detections' latest answer is "Person" (and the replay has flown its photo).
 * A "Person" answer is a candidate sighting: someone is there, maybe not the missing person, so the
 * wording asks a ground team to check. Names every sighting (photo, position, the position radius,
 * its reading) with a "Fly to it" button. Never blocks the slider or other answers.
 */
export function FoundBanner({
  finds,
  simulatedRadius = false,
  onFlyTo,
  readingFor,
}: {
  finds: readonly Find[];
  /** The radius is a simulated position uncertainty (simulated flight path). */
  simulatedRadius?: boolean;
  onFlyTo?: (find: Find) => void;
  /** The sighting's reading (sightings.ts), shown under it. */
  readingFor?: (detectionId: string) => string | undefined;
}) {
  const [all, setAll] = useState(false);
  if (finds.length === 0) return null;
  const shown = all ? finds : finds.slice(0, FINDS_SHOWN);
  return (
    <div role="status" className="flex flex-col gap-3">
      <span className="text-title font-medium text-ok">
        {finds.length === 1
          ? "Person sighted: send ground team to check"
          : `${finds.length} people sighted: send ground teams to check`}
      </span>
      <ul className="flex flex-col gap-2" aria-label="Candidate sightings">
        {shown.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono text-small text-text-2">Photo {photoOf(f.id)}</span>
            <span className="font-mono text-small text-text">
              {f.lat.toFixed(6)}, {f.lon.toFixed(6)}
            </span>
            <Badge kind={simulatedRadius ? "simulated" : "info"}>
              {simulatedRadius ? `±${f.radius_m} m radius · simulated` : `±${f.radius_m} m position uncertainty`}
            </Badge>
            {onFlyTo && (
              <button
                type="button"
                onClick={() => onFlyTo(f)}
                className="rounded-full border border-border px-3 py-0.5 text-label text-text-2 hover:text-text"
              >
                Fly to it
              </button>
            )}
            {readingFor?.(f.id) && <span className="w-full text-label text-text-2">{readingFor(f.id)}</span>}
          </li>
        ))}
      </ul>
      {finds.length > FINDS_SHOWN && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="self-start text-label text-text-2 underline-offset-2 hover:text-text hover:underline"
        >
          {all ? "Show fewer" : `Show all ${finds.length} sightings`}
        </button>
      )}
    </div>
  );
}
