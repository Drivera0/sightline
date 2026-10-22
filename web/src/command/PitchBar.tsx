// The landing's two lines, between the app bar and the console at t0: what Sightline is, and the one
// thing to do (follow the search). No marketing page: the console under it is the product.

import { HERO } from "../front/copy";
import { Button } from "../shell/components";

export const PITCH = {
  line: "A hiker in a red jacket is overdue on Mount Seymour. Drones and ground teams feed one probability map, and the map says where to look next.",
  follow: "Follow the search (3 min)",
  skip: "Skip to now",
} as const;

export function PitchBar({ onFollow, onSkip }: { onFollow: () => void; onSkip: () => void }) {
  return (
    <section aria-label="Sightline" className="sl-fade flex flex-col gap-3 border-b border-line px-4 py-3 lg:flex-row lg:items-center lg:gap-6 lg:px-6">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h1 className="text-title font-medium tracking-[-0.01em] text-text">{HERO.tagline}</h1>
        <p className="max-w-[80ch] text-small text-text-2">{PITCH.line}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2 lg:ml-auto">
        <Button variant="primary" size="lg" onClick={onFollow}>
          {PITCH.follow}
        </Button>
        <Button variant="ghost" onClick={onSkip}>
          {PITCH.skip}
        </Button>
      </div>
    </section>
  );
}
