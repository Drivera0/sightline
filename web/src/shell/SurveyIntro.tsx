import type { CacheBundle } from "../contract";
import { cacheUrl } from "../lib/cache";
import { Label } from "./components";

/** "About 4.6 h" / "about 11 min": time for one person at the published human pace. */
export function humanReviewTime(nFrames: number, secondsPerPhoto: number): string {
  const seconds = nFrames * secondsPerPhoto;
  if (seconds >= 5400) return `${(seconds / 3600).toFixed(1)} h`;
  return `${Math.round(seconds / 60)} min`;
}

/** Step 1: the job. A mosaic of the real frames, the size of the job, and one action. */
export function SurveyIntro({
  cache,
  dir,
  onRank,
}: {
  cache: CacheBundle;
  dir: string;
  onRank: () => void;
}) {
  const { survey, manifest, metrics } = cache;
  const human = metrics.baseline_human;
  const mosaic = survey.frames.slice(0, 84);
  return (
    <div className="relative flex h-full min-h-0 items-center overflow-hidden rounded-lg border border-border">
      {/* The real photos, dimmed: what a searcher would have to go through. */}
      <div aria-hidden="true" className="absolute inset-0 grid grid-cols-6 content-start gap-1 p-1 opacity-40 md:grid-cols-10 xl:grid-cols-12">
        {mosaic.map((frame, i) => (
          <img
            key={frame.id}
            src={cacheUrl(dir, frame.file)}
            alt=""
            loading="lazy"
            className="sl-fade aspect-[4/3] w-full rounded-sm object-cover"
            style={{ animationDelay: `${i * 12}ms` }}
          />
        ))}
      </div>
      <div className="absolute inset-0 bg-gradient-to-r from-bg via-bg/90 to-bg/30" aria-hidden="true" />

      <div className="relative flex max-w-xl flex-col gap-6 p-10">
        <Label className="sl-rise">Search and rescue · drone survey</Label>
        <h2 className="sl-rise text-[44px] font-semibold leading-[1.05]" style={{ animationDelay: "80ms" }}>
          {manifest.n_frames} drone photos from a search over Mount Seymour
        </h2>
        <p className="sl-rise text-title text-text-2" style={{ animationDelay: "160ms" }}>
          Somewhere in them is a person about 60 pixels wide. Finding them by eye takes one searcher
          about{" "}
          <span className="font-mono text-text" title={`${human.seconds_per_image} s per photo (${human.source})`}>
            {humanReviewTime(manifest.n_frames, human.seconds_per_image)}
          </span>
          , and misses about a third of people.
        </p>
        <div className="sl-rise flex flex-wrap items-center gap-4" style={{ animationDelay: "240ms" }}>
          <button
            type="button"
            onClick={onRank}
            autoFocus
            className="rounded-full bg-accent px-6 py-3 text-body font-medium text-bg shadow-[0_0_32px_-8px_var(--accent)] transition-transform hover:scale-[1.03]"
          >
            Rank with Sightline
          </button>
          <span className="text-small text-text-3">
            Human pace: {human.seconds_per_image} s per photo, {Math.round(human.recall * 100)}% recall (
            {human.source})
          </span>
        </div>
      </div>
    </div>
  );
}
