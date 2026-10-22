// How it works as four pictures in a row (the old front door's line drawings): the drone flies a grid,
// photos arrive, Sightline flags and people confirm, the map directs the search. One short line each.
import type { ReactNode } from "react";
import { HOW_IT_WORKS, HOW_IT_WORKS_SHORT } from "./copy";

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** One line drawing per step: the grid, the photos arriving, the flag, the map. */
const PICTURES: ReactNode[] = [
  // a drone over a lawnmower grid
  <g key="grid" {...stroke}>
    <path d="M10 62 H110 M10 62 V48 H110 V34 H10 V20 H110" opacity={0.5} strokeDasharray="4 4" />
    <circle cx="74" cy="20" r="5" />
    <path d="M62 14 h24 M62 26 h24" />
    <path d="M74 25 v12" opacity={0.6} />
  </g>,
  // photos from an SD card to a laptop
  <g key="photos" {...stroke}>
    <rect x="12" y="22" width="22" height="30" rx="2" />
    <path d="M18 22 v-6 h10 v6" />
    <path d="M40 37 h18 m-6 -6 l6 6 l-6 6" />
    <rect x="64" y="18" width="46" height="30" rx="3" />
    <path d="M58 54 h58" />
    <rect x="70" y="24" width="12" height="9" opacity={0.6} />
    <rect x="86" y="24" width="12" height="9" opacity={0.6} />
    <rect x="70" y="36" width="12" height="9" opacity={0.6} />
  </g>,
  // a ranked photo with a flagged person, and a tick
  <g key="flag" {...stroke}>
    <rect x="12" y="14" width="56" height="42" rx="3" />
    <rect x="34" y="28" width="12" height="14" strokeDasharray="3 2" />
    <path d="M74 20 h10 M74 32 h10 M74 44 h10" opacity={0.5} />
    <circle cx="100" cy="35" r="11" />
    <path d="M95 35 l4 4 l7 -8" />
  </g>,
  // a heat map with arrows to a drone and a team
  <g key="map" {...stroke}>
    <rect x="12" y="12" width="60" height="48" rx="3" />
    <circle cx="42" cy="36" r="14" opacity={0.35} />
    <circle cx="42" cy="36" r="7" opacity={0.7} />
    <path d="M58 26 L86 18 M58 46 L86 52" />
    <circle cx="96" cy="18" r="5" />
    <circle cx="96" cy="52" r="5" />
    <path d="M96 57 v6" />
  </g>,
];

export function Steps() {
  return (
    <ol aria-label="How it works" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {HOW_IT_WORKS.map((s, i) => (
        <li key={s.title} className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface-solid p-3">
          <svg viewBox="0 0 120 70" className="h-12 w-full text-accent-soft" aria-hidden>
            {PICTURES[i]}
          </svg>
          <span className="flex items-baseline gap-1.5 text-small font-medium text-text">
            <span className="font-mono text-caption text-accent">{i + 1}</span>
            {s.title}
          </span>
          <span className="text-caption text-text-2">{HOW_IT_WORKS_SHORT[i]}</span>
        </li>
      ))}
    </ol>
  );
}
