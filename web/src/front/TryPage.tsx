// Try your own photo (#try): the detector on a page of its own, so the home page's button lands on the
// upload, not inside the console. The same panel (detect/TryPhoto.tsx) as the console's Photos rail, on the
// demo survey's cache, then what a search does with a box next. Built by lane A.
import { useEffect, useState } from "react";
import type { CacheBundle } from "../contract";
import { TryPhoto } from "../detect/TryPhoto";
import { loadCache } from "../lib/cache";
import { AppBar } from "../shell/AppBar";
import { Button, Label } from "../shell/components";
import { guideHash, PLAY_HASH } from "../shell/flow";

/** The demo survey's cache (ingest/LiveMission.tsx DEMO_DIR): its threshold and three of its photos. */
const DIR = "demo";

/** What a search does with a box, in order. */
export const NEXT_STEPS = [
  { title: "A person looks at every box", body: "Each box above the cut-off joins the review queue, and someone at base camp answers it: person, not a person, or unsure. The detector never decides on its own." },
  { title: "Unsure photos get an AI re-check", body: "Where the detector isn't sure, a vision model on Nebius (Nemotron VL) takes a closer look, with OpenCV tools that zoom in or lift the contrast, and says whether a person is probably there." },
  { title: "A confirmed person moves the search", body: "Confirm one and a sighting is pinned on the map, the probabilities re-form around it, and the agent proposes an alert to all teams and the nearest team on standby. Each waits for your approval." },
] as const;

export function TryPage() {
  const [cache, setCache] = useState<CacheBundle | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    loadCache(DIR).then(
      (c) => live && setCache(c),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <AppBar action={{ label: "Guided simulation", href: "#scenarios" }} />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 lg:py-12">
        <header className="flex flex-col gap-2">
          <Label>Try the detector</Label>
          <h1 className="text-[30px] font-semibold leading-[36px] tracking-[-0.02em] text-text">Try it on your own photo</h1>
          <p className="text-body text-text-2">
            This is the first thing Sightline does with every drone photo in a search: a person detector looks for people
            seen from above. Drop in an aerial photo, or tap one of three photos from the survey, and the same detector
            runs on it here, in your browser.
          </p>
        </header>

        {cache ? (
          <TryPhoto cache={cache} dir={DIR} />
        ) : failed ? (
          <p role="alert" className="text-small text-warn">
            The detector&apos;s settings could not be loaded. Reload the page to try again.
          </p>
        ) : (
          <p className="text-small text-text-3">Loading the detector&apos;s settings…</p>
        )}

        <section aria-labelledby="try-next" className="flex flex-col gap-4">
          <h2 id="try-next" className="text-title font-medium text-text">
            What happens to a box in a search
          </h2>
          <ol className="grid gap-4 sm:grid-cols-3">
            {NEXT_STEPS.map((s, i) => (
              <li key={s.title} className="flex flex-col gap-1 rounded-lg border border-line bg-surface-solid p-4">
                <span className="text-label text-text-3 tabular-nums">{i + 1}</span>
                <span className="text-body font-medium text-text">{s.title}</span>
                <span className="text-small text-text-2">{s.body}</span>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-3">
            <Button href={guideHash()} size="lg" variant="primary">
              See it in the guided simulation
            </Button>
            <Button href={PLAY_HASH} size="lg" variant="secondary">
              Set up your own search
            </Button>
          </div>
        </section>
      </main>
    </div>
  );
}
