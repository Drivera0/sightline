// The landing's one line, between the app bar and the console at t0: what Sightline is, and the one
// thing to do (follow the search: the guided search, each decision yours). Centred, one line and the
// button. No marketing page: the console under it is the product.

import { HERO } from "../front/copy";
import { Button } from "../shell/components";

export const PITCH = {
  line: "A hiker is overdue on Mount Seymour.",
  follow: "Follow the search (3 min)",
  skip: "Skip to now",
} as const;

export function PitchBar({ onFollow, onSkip }: { onFollow: () => void; onSkip: () => void }) {
  return (
    <section aria-label="Sightline" className="sl-fade flex flex-wrap items-center justify-center gap-x-5 gap-y-2 border-b border-line px-4 py-3 text-center lg:px-6">
      <div className="text-body text-text">
        <h1 className="inline font-medium">{HERO.tagline}</h1> <span className="text-text-2">{PITCH.line}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="primary" onClick={onFollow}>
          {PITCH.follow}
        </Button>
        <Button variant="ghost" onClick={onSkip}>
          {PITCH.skip}
        </Button>
      </div>
    </section>
  );
}
