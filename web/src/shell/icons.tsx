// One icon set for the console and the map: a 24-unit grid, 2-unit round strokes, no fills, drawn here
// once. The map draws the same paths on a canvas (map/base/iconImages.ts) at one size, so a drone in a
// T-card, the timeline and on the map is the same drawing. No emoji anywhere. Built by lane A.
import type { SVGProps } from "react";

/** Each icon: SVG path data (and circles as [cx, cy, r]) on a 24 × 24 grid. */
export const ICONS = {
  drone: { d: ["M9.5 9.5h5v5h-5z", "M9.5 9.5 6.8 6.8", "M14.5 9.5l2.7-2.7", "M9.5 14.5l-2.7 2.7", "M14.5 14.5l2.7 2.7"], c: [[5, 5, 2.4], [19, 5, 2.4], [5, 19, 2.4], [19, 19, 2.4]] },
  team: { d: ["M5 20.5v-.8a7 7 0 0 1 14 0v.8"], c: [[12, 7.5, 3.5]] },
  clue: { d: ["M12 3.5 20.5 12 12 20.5 3.5 12z"], c: [[12, 12, 1.2]] },
  base: { d: ["M3.5 20 12 4.5 20.5 20z", "M12 20v-5.5", "M2.5 20h19"], c: [] },
  lkp: { d: ["M12 2.5v4", "M12 17.5v4", "M2.5 12h4", "M17.5 12h4"], c: [[12, 12, 5.5]] },
  radio: { d: ["M8 8.5h8v12.5H8z", "M10 8.5V3", "M10.5 12.5h3", "M10.5 15.5h3"], c: [] },
  decision: { d: ["m8 12.2 2.8 2.8 5.2-6"], c: [[12, 12, 8.5]] },
  detection: { d: ["M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8", "M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8", "M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16", "M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"], c: [[12, 12, 3]] },
  found: { d: ["M5.5 21V4", "M5.5 4.5h11l-2.2 4 2.2 4h-11"], c: [] },
  checkin: { d: ["M4.5 20.5v-.6a5.5 5.5 0 0 1 11 0v.6", "M17 5.5a5 5 0 0 1 0 7", "M19.6 3a8.5 8.5 0 0 1 0 12"], c: [[10, 8.5, 3]] },
  note: { d: ["M12 11v5.5", "M12 7.6v.1"], c: [[12, 12, 8.5]] },
  speaker: { d: ["M4 9.5h3.5L12 5.5v13l-4.5-4H4z", "M15.5 9a4.2 4.2 0 0 1 0 6", "M18.2 6.5a7.8 7.8 0 0 1 0 11"], c: [] },
  mute: { d: ["M4 9.5h3.5L12 5.5v13l-4.5-4H4z", "M16 9.5l5 5", "M21 9.5l-5 5"], c: [] },
  /** A drag handle: the card can be dragged (a T-card onto a sector on the map). */
  grip: { d: [], c: [[9, 6, 1.2], [15, 6, 1.2], [9, 12, 1.2], [15, 12, 1.2], [9, 18, 1.2], [15, 18, 1.2]] },
} as const satisfies Record<string, { d: readonly string[]; c: readonly (readonly [number, number, number])[] }>;

export type IconName = keyof typeof ICONS;

/** An icon in the text's colour (`currentColor`), 16 px by default. Decorative: the words beside it say it. */
export function Icon({ name, size = 16, ...props }: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  const icon = ICONS[name];
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      {icon.d.map((d) => (
        <path key={d} d={d} />
      ))}
      {icon.c.map(([cx, cy, r]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} />
      ))}
    </svg>
  );
}
