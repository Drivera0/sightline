import type { ReactNode } from "react";
import type { CacheBundle } from "../../contract";
import { Popover } from "../../shell/Popover";
import { showsPlaceholderPrior } from "../heat/Legend";

interface Item {
  label: string;
  explain: string;
}

/** What this survey's map draws that is simulated: the props for `SimulatedLine`. */
export function simulatedLineFor(bundle: CacheBundle): { simulatedPath: boolean; radiusM: number | null; placeholderPrior: boolean } {
  const radii = Object.values(bundle.detections.frames)
    .flat()
    .filter((d) => d.conf >= bundle.detections.candidate_threshold)
    .map((d) => d.radius_m);
  return {
    simulatedPath: bundle.survey.simulated_path,
    radiusM: new Set(radii).size === 1 ? (radii[0] ?? null) : null,
    placeholderPrior: showsPlaceholderPrior(bundle.map.params.prior_source, bundle.manifest.notes),
  };
}

/**
 * The map's one honesty line, bottom-left inside the map: every simulated thing drawn on it,
 * named once, each explained on hover, focus or tap. Lists only what applies to this survey.
 */
export function SimulatedLine({
  simulatedPath,
  radiusM,
  placeholderPrior,
  plain = false,
}: {
  simulatedPath: boolean;
  /** The candidates' shared position radius, or null when they differ (then each pin says its own). */
  radiusM: number | null;
  placeholderPrior: boolean;
  /** Inside a panel: no pill of its own. */
  plain?: boolean;
}): ReactNode {
  const items: Item[] = [
    ...(simulatedPath
      ? [
          {
            label: "flight path",
            explain:
              "The photos are real HERIDAL drone images. Where they sit on this map, and the path between them, is a flight laid out for this demo, not recorded GPS.",
          },
        ]
      : []),
    ...(radiusM !== null
      ? [
          {
            label: `${radiusM} m radius`,
            explain: `Each pin's circle is a simulated ${radiusM} m position uncertainty, not one measured from the camera's position and angle.`,
          },
        ]
      : []),
    ...(placeholderPrior
      ? [
          {
            label: "placeholder prior",
            explain:
              "The starting probability map, before any photo is counted, is a placeholder, not a fitted model of where lost people are found.",
          },
        ]
      : []),
  ];
  if (items.length === 0) return null;
  return (
    <p
      data-testid="simulated-line"
      className={
        "pointer-events-auto inline-flex flex-wrap items-center gap-x-1 text-caption text-text-2 " +
        (plain ? "" : "rounded-full bg-bg/75 px-2.5 py-1 backdrop-blur-md")
      }
    >
      <span className="text-accent-soft">Simulated:</span>
      {items.map((item, i) => (
        <span key={item.label} className="inline-flex items-center gap-1">
          {i > 0 && (
            <span aria-hidden="true" className="text-text-3">
              ·
            </span>
          )}
          <Popover
            align={plain ? "end" : "start"}
            trigger={item.label}
            triggerClassName="cursor-help underline decoration-text-3 decoration-dotted underline-offset-2 hover:text-text"
          >
            {item.explain}
          </Popover>
        </span>
      ))}
    </p>
  );
}
