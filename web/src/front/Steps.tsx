// How it works in four steps, each with its icon in its colour (shell/icons.tsx, theme.css): the drone
// flies a grid, the photos arrive, Sightline flags and people confirm, the map directs the search.
import { Icon, type IconName } from "../shell/icons";
import { HOW_IT_WORKS, HOW_IT_WORKS_SHORT } from "./copy";

const ICON: readonly { name: IconName; className: string }[] = [
  { name: "drone", className: "text-drone" },
  { name: "base", className: "text-team" },
  { name: "detection", className: "text-found" },
  { name: "decision", className: "text-proposal" },
];

export function Steps() {
  return (
    <ol aria-label="How it works" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {HOW_IT_WORKS.map((s, i) => (
        <li key={s.title} className="flex items-start gap-3 rounded-lg border border-line bg-surface-solid p-3">
          <span className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-line ${ICON[i]!.className}`}>
            <Icon name={ICON[i]!.name} size={18} />
          </span>
          <span className="flex flex-col gap-0.5">
            <span className="flex items-baseline gap-1.5 text-small font-medium text-text">
              <span className="text-caption text-text-3">{i + 1}</span>
              {s.title}
            </span>
            <span className="text-caption text-text-2">{HOW_IT_WORKS_SHORT[i]}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
