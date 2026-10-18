import type { ReactNode } from "react";
import { Popover } from "../../shell/Popover";

interface Item {
  label: string;
  explain: string;
}

/**
 * The map's one honesty line, bottom-left inside the map: every simulated thing drawn on it,
 * named once, each explained on hover, focus or tap. Lists only what applies to this survey.
 */
export function SimulatedLine({
  simulatedPath,
  radiusM,
  placeholderPrior,
}: {
  simulatedPath: boolean;
  /** The candidates' shared position radius, or null when they differ (then each pin says its own). */
  radiusM: number | null;
  placeholderPrior: boolean;
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
      className="pointer-events-auto inline-flex flex-wrap items-center gap-x-1 rounded-full bg-bg/75 px-2.5 py-1 text-caption text-text-2 backdrop-blur-md"
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
            align="start"
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
