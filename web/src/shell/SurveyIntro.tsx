import type { CacheBundle } from "../contract";
import { cacheUrl } from "../lib/cache";
import { Label } from "./components";

/**
 * Median width of the candidate boxes, in pixels, or null when there are none. Shows how small a
 * person is in these photos, measured from the detections rather than asserted.
 */
export function medianPersonPx(cache: Pick<CacheBundle, "detections">): number | null {
  const widths = Object.values(cache.detections.frames)
    .flat()
    .filter((d) => d.conf >= cache.detections.candidate_threshold)
    .map((d) => d.box_px[2] - d.box_px[0])
    .sort((x, y) => x - y);
  if (widths.length === 0) return null;
  const mid = Math.floor(widths.length / 2);
  return Math.round(widths.length % 2 ? (widths[mid] as number) : ((widths[mid - 1] as number) + (widths[mid] as number)) / 2);
}

const HOW: [string, string][] = [
  ["Detect", "A detector trained on drone photos scores every photo"],
  ["Rank", "Likeliest people first in the review queue"],
  ["Review", "A person confirms; confirmed finds are pinned"],
  ["Search", "The map shows where else to look"],
];

function Fact({ value, label, source }: { value: string; label: string; source: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-bg/50 px-4 py-3 backdrop-blur" title={source}>
      <dd className="font-mono text-[30px] leading-none text-text">{value}</dd>
      <dt className="text-label text-text-3">{label}</dt>
    </div>
  );
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
  const personPx = medianPersonPx(cache);
  return (
    <div className="relative flex h-full min-h-0 items-center overflow-hidden rounded-lg border border-border">
      {/* The real photos, dimmed: what a searcher would have to go through. */}
      <div aria-hidden="true" className="sl-drift absolute inset-0 grid grid-cols-6 content-start gap-1 p-1 opacity-60 md:grid-cols-10 xl:grid-cols-12">
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
      <div className="absolute inset-0 bg-gradient-to-r from-bg from-25% via-bg/85 via-50% to-bg/20" aria-hidden="true" />

      <div className="relative flex w-full max-w-[52rem] flex-col gap-7 p-12">
        <Label className="sl-rise">Search and rescue · drone survey</Label>
        <h2 className="sl-rise text-[60px] font-semibold leading-[1.02] tracking-[-0.02em]" style={{ animationDelay: "80ms" }}>
          {manifest.n_frames} drone photos from a search over Mount Seymour
        </h2>
        <p className="sl-rise max-w-[38rem] text-[19px] leading-relaxed text-text-2" style={{ animationDelay: "160ms" }}>
          Somewhere in them are a few people, each a speck in a forest. Sightline&apos;s detector reads
          every photo, puts the likeliest people first, and keeps a live map of where else to look.
        </p>

        <dl className="sl-rise grid grid-cols-3 gap-3" style={{ animationDelay: "220ms" }}>
          <Fact value={String(manifest.n_frames)} label="photos to check" source={`manifest.n_frames`} />
          {personPx !== null && (
            <Fact
              value={`${personPx} px`}
              label={`a person, in a ${survey.frames[0]?.width_px ?? ""} px wide photo`}
              source="Median width of the candidate boxes (detections.json)"
            />
          )}
          <Fact
            value={`${Math.round((1 - human.recall) * 100)}%`}
            label="of people missed by eye"
            source={`Human recall ${Math.round(human.recall * 100)}% (${human.source})`}
          />
        </dl>

        <div className="sl-rise flex flex-wrap items-center gap-4" style={{ animationDelay: "300ms" }}>
          <button
            type="button"
            onClick={onRank}
            autoFocus
            className="group inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-body font-medium text-bg shadow-[0_0_32px_-8px_var(--accent)] transition-transform hover:scale-[1.03]"
          >
            Rank with Sightline
            <svg viewBox="0 0 16 16" className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true">
              <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <span className="text-small text-text-3">or press 2</span>
        </div>

        <ol className="sl-rise grid grid-cols-2 gap-x-6 gap-y-3 border-t border-border pt-5 sm:grid-cols-4" style={{ animationDelay: "380ms" }}>
          {HOW.map(([title, body], i) => (
            <li key={title} className="flex flex-col gap-1">
              <span className="font-mono text-label text-accent-soft">0{i + 1}</span>
              <span className="text-body text-text">{title}</span>
              <span className="text-small text-text-3">{body}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
