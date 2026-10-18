import type { Detection } from "../../contract";
import { Badge } from "../../shell/components";

/** Shown while a detection's latest answer is "Person". Never blocks the slider or other answers. */
export function FoundBanner({ detection }: { detection: Pick<Detection, "id" | "lat" | "lon" | "radius_m"> }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <span className="text-title font-medium text-ok">Person confirmed: dispatch ground team</span>
      <span className="font-mono text-small text-text">
        {detection.lat.toFixed(6)}, {detection.lon.toFixed(6)}
      </span>
      <Badge kind="info">±{detection.radius_m} m position uncertainty</Badge>
    </div>
  );
}
