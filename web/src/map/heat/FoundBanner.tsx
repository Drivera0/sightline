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
 * Shown while one or more detections' latest answer is "Person". Names every confirmed find (photo,
 * position, the position radius) with a "Fly to it" button. Never blocks the slider or other answers.
 */
export function FoundBanner({
  finds,
  simulatedRadius = false,
  onFlyTo,
}: {
  finds: readonly Find[];
  /** The radius is a simulated position uncertainty (simulated flight path). */
  simulatedRadius?: boolean;
  onFlyTo?: (find: Find) => void;
}) {
  const [all, setAll] = useState(false);
  if (finds.length === 0) return null;
  const shown = all ? finds : finds.slice(0, FINDS_SHOWN);
  return (
    <div role="status" className="flex flex-col gap-3">
      <span className="text-title font-medium text-ok">
        {finds.length === 1
          ? "Person confirmed: dispatch ground team"
          : `${finds.length} people confirmed: dispatch ground teams`}
      </span>
      <ul className="flex flex-col gap-2" aria-label="Confirmed finds">
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
          </li>
        ))}
      </ul>
      {finds.length > FINDS_SHOWN && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="self-start text-label text-text-2 underline-offset-2 hover:text-text hover:underline"
        >
          {all ? "Show fewer" : `Show all ${finds.length} finds`}
        </button>
      )}
    </div>
  );
}
